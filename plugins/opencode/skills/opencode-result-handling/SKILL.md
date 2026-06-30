---
name: opencode-result-handling
description: Guidance for interpreting and presenting OpenCode task results
user-invocable: false
---

# OpenCode Result Handling

## Result Structure

OpenCode returns results as structured session data containing:
- **Messages**: The full conversation between the user prompt and OpenCode's agent
- **Tool calls**: All tool invocations (bash, edit, read, write, grep, glob, etc.)
- **File changes**: Diffs of all files modified during the session
- **Status**: Whether the session completed successfully, was aborted, or errored

## Presenting Results

When presenting OpenCode's output (the companion prints a tool-call tree of what it did, then the result, then a footer — all on stdout):
1. Present the final assistant message as the primary output
2. If file changes were made, the companion footer lists them — surface which files were modified
3. Note the session id from the footer for follow-ups

## Resuming Sessions

OpenCode sessions can be resumed by sending additional messages to the same session.
The `--resume-last` flag in the companion script handles this by reusing the last session id
recorded for the current workspace (see `lib/session-memory.mjs`).
