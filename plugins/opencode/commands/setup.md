---
description: Check whether the local OpenCode CLI is ready (install status, version, server, providers)
argument-hint: ''
allowed-tools: Bash(node:*), Bash(npm:*), Bash(brew:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json $ARGUMENTS
```

If the result says OpenCode is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install OpenCode now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install OpenCode (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g opencode-ai
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json $ARGUMENTS
```

If OpenCode is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If OpenCode is installed but `providers` is empty, note that an empty list does NOT mean OpenCode is unconfigured — a default model set via `/connect` or a config file will not appear in the providers API. Only suggest running `!opencode providers` if the user reports that tasks are actually failing.
