# OpenCode plugin for Claude Code

> **Tribute**: This project is inspired by and pays homage to
> [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) by OpenAI.
> The plugin architecture, command structure, and design patterns are derived from
> the original codex-plugin-cc project, adapted to work with
> [OpenCode](https://github.com/sst/opencode) instead of Codex.

Use OpenCode from inside Claude Code for code reviews or to delegate tasks.

This plugin is for Claude Code users who want an easy way to start using OpenCode from the workflow
they already have.

## What You Get

- `/opencode:rescue` to hand OpenCode any task — investigate, fix, refactor, build (foreground, shows its tool-call tree, can edit files)
- `/opencode:review` for a normal read-only OpenCode review
- `/opencode:adversarial-review` for a steerable challenge review
- `/opencode:setup` to check install/auth

## Requirements

- [Claude Code](https://claude.com/claude-code) (CLI, desktop app, or IDE extension)
- [OpenCode](https://github.com/sst/opencode) installed (`npm i -g opencode-ai` or `brew install opencode`)
- A configured AI provider in OpenCode (Claude, OpenAI, Google, etc.)
- Node.js 18.18 or later

## Install

Inside Claude Code, run:

```
! curl -fsSL https://raw.githubusercontent.com/DevMinions/opencode-plugin-cc/main/install.sh | bash
```

Then reload the plugin:

```
/reload-plugins
```

You should see:

```
Reloaded: 1 plugin · ... · 1 hook ...
```

Finally, verify your setup:

```
/opencode:setup
```

> **What the installer does**: Clones the repo to `~/.claude/plugins/marketplaces/`,
> caches the plugin files, and registers it in Claude Code's plugin config.
> It tries SSH first and falls back to HTTPS automatically.

### Set up an AI Provider

If OpenCode is installed but no AI provider is configured, set one up:

```
! opencode providers login
```

To check your configured providers:

```
! opencode providers list
```

### Uninstall

```
/plugin uninstall opencode@devminions-opencode
/reload-plugins
```

## Command Mapping (codex-plugin-cc -> opencode-plugin-cc)

| codex-plugin-cc | opencode-plugin-cc | Description |
|---|---|---|
| `/codex:review` | `/opencode:review` | Read-only code review |
| `/codex:adversarial-review` | `/opencode:adversarial-review` | Adversarial challenge review |
| `/codex:rescue` | `/opencode:rescue` | Hand any task to OpenCode (foreground, shows what it did, can edit files) |
| `/codex:setup` | `/opencode:setup` | Check install/auth |

## Slash Commands

- `/opencode:rescue <task>` -- Hand any task to OpenCode via the `opencode:opencode-rescue` subagent. Runs **foreground**; on completion it prints a **tree of the tool calls it made** above the result, so you can see what it did. Can read/write files. Defaults to write-capable `build` and OpenCode's configured default model (currently `glm-5.2`). Supports `--plan` (read-only), `--model <provider/model>`, `--agent <build|plan>`, `--resume`, `--fresh`.
- `/opencode:review` -- Normal OpenCode code review (read-only, foreground). Supports `--base <ref>`.
- `/opencode:adversarial-review` -- Steerable review that challenges implementation and design decisions. Accepts custom focus text.
- `/opencode:setup` -- Checks OpenCode install/auth and configured providers.

## Troubleshooting

<details>
<summary><strong>Plugin not loading after install (0 plugins)</strong></summary>

1. Re-run the installer: `! curl -fsSL https://raw.githubusercontent.com/DevMinions/opencode-plugin-cc/main/install.sh | bash`
2. Run `/reload-plugins` again.
3. If still failing, restart Claude Code.
</details>

<details>
<summary><strong>Install script fails to clone</strong></summary>

The script tries SSH first, then HTTPS. If both fail:

- Check your network connection
- For SSH: ensure `ssh -T git@github.com` works
- For HTTPS: run `gh auth login` to set up credentials
</details>

<details>
<summary><strong>OpenCode commands not working</strong></summary>

1. Verify OpenCode is installed: `! opencode --version`
2. Verify a provider is configured: `! opencode providers list`
3. Run `/opencode:setup` to check the full status.
</details>

## Architecture

Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout, this plugin communicates with
OpenCode over its HTTP API using OpenCode's official typed client (`@opencode-ai/sdk`, vendored
under `plugins/opencode/scripts/vendor/` so no install step is needed). The server is warmed at
session start (SessionStart hook) and managed by the companion scripts. Each dispatch runs in the
**foreground** (polling session status for completion) and, when done, prints a tool-call tree of
what OpenCode did above the result — all on stdout. There is no background-job machinery.

```
codex-plugin-cc                          opencode-plugin-cc
+----------------------+                 +------------------------+
| JSON-RPC over stdio  |                 | HTTP via @opencode/sdk |
| codex app-server     |      vs.        | opencode serve         |
| Broker multiplexing  |                 | Typed client (no broker)|
| codex CLI binary     |                 | opencode CLI binary    |
+----------------------+                 +------------------------+
```

## Project Structure

```
opencode-plugin-cc/
├── .claude-plugin/marketplace.json       # Marketplace registration
├── install.sh                            # One-line installer
├── plugins/opencode/
│   ├── .claude-plugin/plugin.json        # Plugin metadata
│   ├── agents/opencode-rescue.md         # Rescue subagent definition
│   ├── commands/                         # 4 slash commands
│   │   ├── rescue.md
│   │   ├── review.md
│   │   ├── adversarial-review.md
│   │   └── setup.md
│   ├── hooks/hooks.json                  # SessionStart server warm-up
│   ├── prompts/                          # Prompt templates
│   ├── schemas/                          # Output schemas
│   ├── scripts/                          # Node.js runtime
│   │   ├── opencode-companion.mjs        # CLI entry point (foreground; prints tool-call tree + result)
│   │   ├── warm-server-hook.mjs          # SessionStart: warm the OpenCode server
│   │   └── lib/                          # Core modules
│   │       ├── opencode-server.mjs       # HTTP API client
│   │       ├── session-memory.mjs        # Last-session memory for --resume-last
│   │       ├── render.mjs               # Output rendering
│   │       ├── prompts.mjs              # Prompt construction
│   │       ├── git.mjs                  # Git utilities
│   │       ├── process.mjs             # Process utilities
│   │       ├── args.mjs                # Argument parsing
│   │       ├── fs.mjs                  # Filesystem utilities
│   │       └── workspace.mjs           # Workspace detection
│   └── skills/                          # Internal skills
├── tests/                               # Test suite
├── LICENSE                              # Apache License 2.0
├── NOTICE                               # Attribution notice
└── README.md
```

## OpenCode Integration

Wraps the OpenCode HTTP server API. Picks up config from:
- User-level: `~/.config/opencode/config.json`
- Project-level: `.opencode/opencode.jsonc`

## License

Copyright 2026 OpenCode Plugin Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
