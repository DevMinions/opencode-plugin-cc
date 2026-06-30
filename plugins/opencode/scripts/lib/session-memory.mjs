// Minimal "last OpenCode session" memory for --resume-last.
// Replaces the old job-state DB: we only ever need to remember the most recent
// OpenCode session id per (Claude session, workspace) so a follow-up can resume.

import crypto from "node:crypto";
import path from "node:path";
import { readJson, writeJson } from "./fs.mjs";

const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";

/**
 * Current Claude session id, if the harness exported one. Used to scope the
 * resumable session so two parallel Claude sessions don't cross-resume.
 * @returns {string|undefined}
 */
export function getClaudeSessionId() {
  return process.env[SESSION_ID_ENV] || process.env.CLAUDE_SESSION_ID || undefined;
}

function memFile(workspacePath) {
  const base = process.env.CLAUDE_PLUGIN_DATA
    ? path.join(process.env.CLAUDE_PLUGIN_DATA, "session-memory")
    : path.join("/tmp", "opencode-companion", "session-memory");
  const hash = crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
  return path.join(base, `${hash}.json`);
}

/**
 * Remember the OpenCode session that just ran for this workspace.
 * @param {string} workspacePath
 * @param {string} opencodeSessionId
 */
export function recordSession(workspacePath, opencodeSessionId) {
  if (!opencodeSessionId) return;
  const key = getClaudeSessionId() ?? "_";
  const data = readJson(memFile(workspacePath)) ?? {};
  data[key] = { opencodeSessionId, updatedAt: new Date().toISOString() };
  writeJson(memFile(workspacePath), data);
}

/**
 * The most recent OpenCode session id for this (Claude session, workspace),
 * or null. Falls back to the unscoped "_" entry when no Claude session id is set.
 * @param {string} workspacePath
 * @returns {string|null}
 */
export function getLastSession(workspacePath) {
  const data = readJson(memFile(workspacePath));
  if (!data) return null;
  const key = getClaudeSessionId() ?? "_";
  return data[key]?.opencodeSessionId ?? data["_"]?.opencodeSessionId ?? null;
}
