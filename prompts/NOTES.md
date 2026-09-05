# Ownership prompt — notes for the next cut

`fable-5-ownership.md` and `opus-5-ownership.md` are separate model-specific bases. Each model's three role files contain its complete base followed by one `# Your role` tail; `launch.test.ts` checks that contract. Opus 5 carries the compact communication limits and task-scoped security boundary.

Rebuild after editing a model's base:

```bash
cd $UCC_HOME/config
model=opus-5   # or fable-5
for role in worker leader advisor; do
  para=$(awk '/^# Your role$/{f=1;next} f&&NF{print;exit}' prompts/$model-ownership.$role.md)
  { cat prompts/$model-ownership.md; printf '\n# Your role\n\n%s\n' "$para"; } > prompts/$model-ownership.$role.md
done
bun test launch.test.ts
ccc-statusd session token-count prompts/$model-ownership.md --json   # real tokenizer; never chars/4
```

Per-section cost: split the base on `^# ` and pipe each piece through `token-count -`.

## Fable next cuts, heaviest section first

| Section | Next cut | What the text protects |
|---|---|---|
| Delivering work | merge the "act when ready" and "operating autonomously" paragraphs; drop the mid-task-uncertainty sentence | the anti-re-ask brakes — removing them once produced re-asking on this arm, so keep at least: the request is the go-ahead, a plain push reverts, a user-stated fact is ground truth |
| Communication | keep the readability paragraph whole (highest-value text in the file); cut the corrections paragraph to one sentence | unreadable long-session summaries; self-correction narration |
| Reporting outcomes | keep the one-line POSIWID definition, drop the table; drop the peer-correction sentence | fabricated status, hidden failures, "complete" taken on trust |
| Harness | Meridian bullet to one sentence plus the skill pointer | other agents' CAS guards; the lane rule |
| Writing durable artifacts | fold the second paragraph into one sentence: check a claim you are about to repeat when one command settles it | matching earlier models' verbosity; repeating stale doc claims |
| Delegation | drop the examples clause | spawn-and-block; re-spawning instead of continuing a running agent |
| Memory | drop the section (the harness still loads MEMORY.md; only the write instruction goes) | cross-session lessons |

## Held out of the Fable prompt by design

Re-add any of these only against an observed failure, and as a sentence in the section that owns the behavior, not as a list.

- An enumerated failure-modes list. The behaviors live as sentences in Delivering work.
- A "concise" output-style block and a `<tone_preference>` tail. Communication is the single style section, placed last so it sits nearest the end of context.
- The document cost ladder and its acceptance criterion (every identifier survives or its absence is one line in the notes). Payload-versus-carrier in Writing durable artifacts carries the rule.
- Refusal policy, "be fair and factual", and security-warning suppression. The user CLAUDE.md carries the model-check rule for security flags.
- "Read the task as a checklist and satisfy each sentence literally", "spot-check, do not audit", "write to the path you were given, never the source".
- A context-budget reassurance line. It would fight the ccc-handoff context-fill trigger.
- Mechanism names for delegation (Agent tool, ccc-agent, Workflow). The tool descriptions and the role skills carry them; the prompt states only when to delegate and the async discipline.

## Sources

- Official Fable 5.1 guidance: home-wiki `inbox/scraped/claude-api/bundled-2.1.257/shared/model-migration.md`, § Migrating to Claude Fable 5.1 › Behavioral shifts (prompt-tunable).
- Wiki home of the prompt: home-wiki `effects/prompts/ucc-system-prompt.md` (changelog) and `effects/prompts/ucc-system-prompt/final/` (deployed capture — this directory is the source; the wiki copies follow it).
- Released copy: ccc-statusd `worker/launch-config/` — sync it in the same change (GUIDE.md § Distribution).
