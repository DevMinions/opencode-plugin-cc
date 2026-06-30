#!/usr/bin/env node

// SessionStart warm-up hook: kick off the OpenCode server in the background so
// the first dispatch in this Claude session doesn't pay cold-start latency.
// Fire-and-forget — never blocks or fails the session.

import process from "node:process";
import { warmServer } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";

async function main() {
  const workspace = await resolveWorkspace().catch(() => undefined);
  const started = await warmServer({ cwd: workspace });
  if (started) process.stderr.write("[opencode-companion] warming OpenCode server…\n");
}

main().catch(() => process.exit(0));
