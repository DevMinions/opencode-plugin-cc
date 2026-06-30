---
description: Run a steerable adversarial OpenCode review that challenges implementation and design decisions
argument-hint: '[--base <ref>] [focus area or custom review instructions]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run an adversarial OpenCode review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return OpenCode's output verbatim to the user.

Run it (foreground — it returns the review, with a tree of what it inspected above it):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" adversarial-review $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
- Preserve the user's arguments exactly. Any text after flags is treated as a focus area; the companion handles `--adversarial` framing internally.
