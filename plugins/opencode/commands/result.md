---
description: Show final output for a finished OpenCode job, including session ID for resuming
argument-hint: '[job-id-prefix] [--wait] [--timeout <seconds>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the result command and return output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" result $ARGUMENTS
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the result output.
- `--wait` blocks until the job finishes, then prints its result. Use it to
  retrieve a background job's output deterministically instead of polling
  `/opencode:status`. `--timeout <seconds>` caps the wait (default 600).
