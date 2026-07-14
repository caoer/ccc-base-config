// Renderer regression tests for render.md.
//
// The renderer is a TS block embedded in render.md and executed by `md run`
// (which chdirs to this repo's toplevel and passes params as MD_PARAM_* env).
// These tests extract that exact block and run it with bun against temp fixture
// config trees — hermetic, no `md`/`claude` dependency, directly exercising the
// merge rules and every fail-loud branch.
//
// Run: bun test render.test.ts   (from this repo root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const RENDER_MD = join(import.meta.dir, 'render.md');
const block = readFileSync(RENDER_MD, 'utf8').match(/```ts\n([\s\S]*?)\n```/);
if (!block) throw new Error('render.test.ts: could not find the ```ts renderer block in render.md');
const RENDERER_TS = block[1];

let scriptPath: string;
const srcDir = mkdtempSync(join(tmpdir(), 'render-src-'));
beforeAll(() => {
  scriptPath = join(srcDir, 'renderer.ts');
  writeFileSync(scriptPath, RENDERER_TS);
});
afterAll(() => rmSync(srcDir, { recursive: true, force: true }));

type Files = Record<string, string>;
interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: { argv: string[]; layers: string[]; model_matched: boolean; warnings: string[] } | null;
  /** contents of any --system-prompt-file / --append-system-prompt-file the argv points at */
  promptFiles: Record<string, string>;
}

function runRender(files: Files, params: { model?: string; profile?: string; project?: string; role?: string; output?: string }): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'render-fix-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    if (params.model) env.MD_PARAM_MODEL = params.model;
    if (params.profile) env.MD_PARAM_PROFILE = params.profile;
    if (params.project) env.MD_PARAM_PROJECT = params.project;
    if (params.role) env.MD_PARAM_ROLE = params.role;
    if (params.output) env.MD_PARAM_OUTPUT = params.output;
    const proc = Bun.spawnSync(['bun', scriptPath], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    let json: RunResult['json'] = null;
    if (proc.exitCode === 0 && stdout.trim().startsWith('{')) {
      try {
        json = JSON.parse(stdout);
      } catch {
        /* leave null; a test asserting json will fail loudly */
      }
    }
    const promptFiles: Record<string, string> = {};
    for (let i = 0; json && i < json.argv.length - 1; i++) {
      if (json.argv[i] === '--append-system-prompt-file' || json.argv[i] === '--system-prompt-file') {
        try {
          promptFiles[json.argv[i]] = readFileSync(json.argv[i + 1], 'utf8');
        } catch {
          /* file may be an absolute referenced path outside root — skip */
        }
      }
    }
    return { exitCode: proc.exitCode, stdout, stderr, json, promptFiles };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const fm = (yaml: string) => `---\n${yaml}\n---\n`;

describe('render.md renderer', () => {
  test('shared.md only → empty argv, shared layer, model_matched false', () => {
    const r = runRender({ 'shared.md': fm('') }, {});
    expect(r.exitCode).toBe(0);
    expect(r.json!.argv).toEqual([]);
    expect(r.json!.layers).toEqual(['shared.md']);
    expect(r.json!.model_matched).toBe(false);
  });

  test('model layer sets model+effort → --model/--effort, model_matched true', () => {
    const r = runRender(
      { 'shared.md': fm(''), 'models/sel.md': fm('model: real-model\neffort: xhigh') },
      { model: 'sel' },
    );
    expect(r.json!.argv).toEqual(['--model', 'real-model', '--effort', 'xhigh']);
    expect(r.json!.model_matched).toBe(true);
  });

  // #2: empty-string model in a matched layer must fail loud, never emit --model ''.
  test('empty-string model: "" fails loud (exit 1)', () => {
    const r = runRender({ 'shared.md': fm(''), 'models/sel.md': fm('model: ""') }, { model: 'sel' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('empty model');
    expect(r.stdout).not.toContain('--model');
  });

  // #4: a per-model layer that sets no model: is legal — pass the caller's --model
  // through (model_matched false) with a warning, do not fail the render.
  test('per-model layer without model: passes through with a warning, not a failure', () => {
    const r = runRender(
      { 'shared.md': fm(''), 'models/sel.md': fm('effort: high') },
      { model: 'sel' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.model_matched).toBe(false);
    expect(r.json!.argv).toEqual(['--effort', 'high']);
    expect(r.json!.warnings.join(' ')).toContain('passes through');
  });

  // #4b: a per-model sub-layer can add prompt/tools while a broader model layer
  // supplies the real model: — model_matched stays true, caller drops its --model.
  test('broader model layer supplies model:, sub-layer adds only tools', () => {
    const r = runRender(
      {
        'shared.md': fm(''),
        'models/sel.md': fm('model: real-model'),
        'profiles/p/models/sel.md': fm('tools: Bash,Read'),
      },
      { model: 'sel', profile: 'p' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.model_matched).toBe(true);
    expect(r.json!.argv).toContain('real-model');
    expect(r.json!.argv).toContain('--tools');
  });

  // #3: an empty-frontmatter file (`---\n---`) is a no-op, not a body leak.
  test('empty-frontmatter any.md is a no-op (no --append-system-prompt-file leak)', () => {
    const r = runRender({ 'shared.md': fm(''), 'profiles/p/any.md': '---\n---\n' }, { profile: 'p' });
    expect(r.exitCode).toBe(0);
    expect(r.json!.argv).toEqual([]);
    expect(r.json!.layers).toEqual(['shared.md', 'profiles/p/any.md']);
  });

  test('a pure-body file (no frontmatter) is appended as system-prompt text', () => {
    const r = runRender({ 'shared.md': 'hello from shared body\n' }, {});
    expect(r.json!.argv[0]).toBe('--append-system-prompt-file');
    expect(r.promptFiles['--append-system-prompt-file']).toContain('hello from shared body');
  });

  // #5: inline-map mcp-config → JSON string, not `<root>/[object Object]`.
  test('inline-map mcp-config renders as JSON, not a bogus [object Object] path', () => {
    const r = runRender(
      { 'shared.md': fm('mcp-config:\n  mcpServers: {}') },
      {},
    );
    const i = r.json!.argv.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.json!.argv[i + 1]).toBe('{"mcpServers":{}}');
    expect(r.json!.argv.join(' ')).not.toContain('[object Object]');
  });

  test('scalar override: most specific layer wins', () => {
    const r = runRender(
      {
        'shared.md': fm('model: base-model'),
        'projects/proj/any.md': fm('model: project-model'),
      },
      { project: 'proj' },
    );
    const i = r.json!.argv.indexOf('--model');
    expect(r.json!.argv[i + 1]).toBe('project-model');
  });

  test('list union + dedup across layers (add-dir)', () => {
    const r = runRender(
      {
        'shared.md': fm('add-dir: [/a, /b]'),
        'profiles/p/any.md': fm('add-dir: /b'),
      },
      { profile: 'p' },
    );
    const i = r.json!.argv.indexOf('--add-dir');
    // union of {/a,/b} with the duplicate /b collapsed
    const dirs = r.json!.argv.slice(i + 1);
    expect(dirs).toEqual(['/a', '/b']);
  });

  test('append stream concatenates bodies in layer order', () => {
    const r = runRender(
      {
        'shared.md': '---\n---\nSHARED-NOTE',
        'profiles/p/any.md': '---\n---\nPROFILE-NOTE',
      },
      { profile: 'p' },
    );
    const content = r.promptFiles['--append-system-prompt-file'];
    expect(content).toContain('SHARED-NOTE');
    expect(content).toContain('PROFILE-NOTE');
    expect(content.indexOf('SHARED-NOTE')).toBeLessThan(content.indexOf('PROFILE-NOTE'));
  });

  test('unknown frontmatter key is a warning, not an error', () => {
    const r = runRender({ 'shared.md': fm('bogus-key: 1') }, {});
    expect(r.exitCode).toBe(0);
    expect(r.json!.warnings.join(' ')).toContain('bogus-key');
  });

  test('boolean verbose: false in a more specific layer undoes a broader true', () => {
    const r = runRender(
      {
        'shared.md': fm('verbose: true'),
        'profiles/p/any.md': fm('verbose: false'),
      },
      { profile: 'p' },
    );
    expect(r.json!.argv).not.toContain('--verbose');
  });

  test('verbose: true emits a bare --verbose flag', () => {
    const r = runRender({ 'shared.md': fm('verbose: true') }, {});
    expect(r.json!.argv).toContain('--verbose');
  });

  test('missing append-system-prompt-file fails loud (exit 1)', () => {
    const r = runRender({ 'shared.md': fm('append-system-prompt-file: /no/such/file.md') }, {});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('append-system-prompt-file not found');
  });

  test('project path is flattened (non-alphanumeric → -)', () => {
    const r = runRender(
      { 'shared.md': fm(''), 'projects/-x-y-z/any.md': fm('name: hit') },
      { project: '/x/y/z' },
    );
    expect(r.json!.layers).toContain('projects/-x-y-z/any.md');
    expect(r.json!.argv).toEqual(['--name', 'hit']);
  });

  test('role layer composes between shared and model layers', () => {
    const r = runRender(
      {
        'shared.md': fm(''),
        'roles/leader.md': fm('effort: high'),
        'models/m.md': fm('model: real-m'),
      },
      { role: 'leader', model: 'm' },
    );
    expect(r.json!.layers).toEqual(['shared.md', 'roles/leader.md', 'models/m.md']);
    expect(r.json!.argv).toEqual(['--model', 'real-m', '--effort', 'high']);
  });

  test('role model-selection promotes the full model layer stack when no model param', () => {
    const r = runRender(
      {
        'shared.md': fm(''),
        'roles/leader.md': fm('model-selection: claude-fable-5'),
        'models/claude-fable-5.md': fm('model: claude-fable-5'),
      },
      { role: 'leader' },
    );
    expect(r.json!.layers).toContain('models/claude-fable-5.md');
    expect(r.json!.argv).toEqual(['--model', 'claude-fable-5']);
    expect(r.json!.model_matched).toBe(true);
  });

  test('explicit model param beats the role model-selection', () => {
    const r = runRender(
      {
        'shared.md': fm(''),
        'roles/leader.md': fm('model-selection: claude-fable-5'),
        'models/claude-fable-5.md': fm('model: claude-fable-5'),
        'models/other.md': fm('model: real-other'),
      },
      { role: 'leader', model: 'other' },
    );
    expect(r.json!.layers).not.toContain('models/claude-fable-5.md');
    expect(r.json!.argv).toEqual(['--model', 'real-other']);
  });

  test('role param with no roles/<role>.md is a no-op', () => {
    const r = runRender({ 'shared.md': fm('name: base') }, { role: 'worker' });
    expect(r.json!.layers).toEqual(['shared.md']);
    expect(r.json!.argv).toEqual(['--name', 'base']);
  });

  test('empty model-selection fails loud', () => {
    const r = runRender(
      { 'shared.md': fm(''), 'roles/leader.md': fm('model-selection: ""') },
      { role: 'leader' },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('model-selection is empty');
  });

  test('model-selection outside roles/ is ignored with a warning', () => {
    const r = runRender(
      { 'shared.md': fm('model-selection: claude-fable-5\nname: base') },
      {},
    );
    expect(r.json!.argv).toEqual(['--name', 'base']);
    expect(r.json!.warnings.join(' ')).toContain("only meaningful on roles/<role>.md");
  });

});
