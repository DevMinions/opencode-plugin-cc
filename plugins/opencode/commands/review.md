---
description: Run an OpenCode code review against local git state (foreground)
argument-hint: '[--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run an OpenCode review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return OpenCode's output verbatim to the user.

Run it (foreground — it returns the review, with a tree of what it inspected above it):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
- Preserve the user's arguments exactly; do not rewrite their intent.
- `/opencode:review` is native-review only (no staged-only/unstaged-only/focus text). For custom or adversarial framing, use `/opencode:adversarial-review`.
