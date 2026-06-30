---
name: opencode-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# OpenCode Runtime

Use this skill only inside the `opencode:opencode-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct OpenCode CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, or `adversarial-review` from `opencode:opencode-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `opencode-prompting` skill to rewrite the user's request into a tighter OpenCode prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--agent` unset unless the user explicitly requests a specific agent (build or plan).
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.

Command selection:
- Use exactly one `task` invocation per rescue handoff. `task` always runs foreground and streams its progress; there is no background mode.
- If the forwarded request includes `--plan` (read-only), pass it through to `task`.
- If the forwarded request includes `--model`, pass it through to `task`.
- If the forwarded request includes `--agent`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.

Safety rules:
- Default to write-capable OpenCode work in `opencode:opencode-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or OpenCode cannot be invoked, return nothing.
