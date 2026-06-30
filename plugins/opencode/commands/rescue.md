---
description: Hand any task to OpenCode — investigate, fix, refactor, or build (foreground, shows what it did, can edit files)
argument-hint: "[--plan] [--model <provider/model>] [--agent <build|plan>] [--resume|--fresh] <what OpenCode should do>"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `opencode:opencode-rescue` subagent.
The final user-visible response must be OpenCode's output verbatim.

Raw user request:
$ARGUMENTS

What this command is:
- A **general, unrestricted delegate**. OpenCode may read/write files, run commands, refactor, build — whatever the task needs. There is no fixed scope.
- Runs **foreground**; on completion it prints a **tree of the tool calls it made** (read/edit/bash …) right above the result, so you can see what it did. The result returns in this same turn.
- Defaults: write-capable `build` agent, and OpenCode's own configured default model (currently `glm-5.2`). `--plan` makes it read-only; `--model <provider/model>` overrides the model; `--agent <build|plan>` overrides the agent.

Resume handling:
- If the request includes `--resume`, do not ask — route with `--resume`.
- If it includes `--fresh`, do not ask — route fresh.
- Otherwise, check for a resumable session:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json
```
  - If it reports `available: true`, use `AskUserQuestion` exactly once with two options:
    - `Continue current OpenCode session`
    - `Start a new OpenCode session`
    Put `Continue current OpenCode session (Recommended)` first when the user clearly signals follow-up ("continue", "keep going", "resume", "dig deeper", "apply the top fix"); otherwise put `Start a new OpenCode session (Recommended)` first.
    If the user chooses continue → add `--resume`. If new → add `--fresh`.
  - If it reports `available: false`, do not ask. Route normally.

Operating rules:
- The subagent is a thin forwarder: one `Bash` call to `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task ...`, returning that stdout verbatim.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- `--plan`, `--model`, `--agent`, `--resume`, `--fresh` are routing controls — keep them out of the natural-language task text.
- If OpenCode is missing or unauthenticated, stop and tell the user to run `/opencode:setup`.
- If the user did not supply a request, ask what OpenCode should do.
