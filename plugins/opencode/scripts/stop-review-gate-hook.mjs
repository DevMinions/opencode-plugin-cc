#!/usr/bin/env node

// Stop review gate hook for the OpenCode companion.
// When enabled, runs a targeted OpenCode review on Claude's final response
// before allowing the session to stop. If issues are found, the stop is blocked
// so Claude addresses them first.
//
// Claude Code pipes a JSON payload to Stop hooks on stdin:
//   { session_id, transcript_path, cwd, hook_event_name, stop_hook_active }
// The assistant's reply text is NOT in the payload — it lives in the transcript
// JSONL at transcript_path. To BLOCK the stop, a hook must exit with code 2
// (its stderr is fed back to Claude); exit 0 allows the stop.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState } from "./lib/state.mjs";
import { isServerRunning, connect } from "./lib/opencode-server.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

/** Read and JSON-parse the hook payload piped on stdin. */
async function readStdinPayload() {
  if (process.stdin.isTTY) return {};
  const raw = await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    // Guard against a hung pipe.
    setTimeout(() => resolve(data), 5000);
  });
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/**
 * Extract the text of the last assistant turn from a Claude Code transcript
 * (JSONL). Each line is a record; assistant turns look like
 *   { type: "assistant", message: { role: "assistant", content: [ {type:"text", text}, ... ] } }
 * The final record may be a tool_use with no text, so we keep the latest
 * assistant record that actually carried text.
 * @param {string} transcriptPath
 * @returns {string}
 */
function readLastAssistantText(transcriptPath) {
  if (!transcriptPath) return "";
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  let text = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== "assistant") continue;
    const content = rec.message?.content;
    let turn = "";
    if (typeof content === "string") {
      turn = content.trim();
    } else if (Array.isArray(content)) {
      turn = content
        .filter((c) => c?.type === "text")
        .map((c) => c.text || "")
        .join("\n")
        .trim();
    }
    if (turn) text = turn;
  }
  return text;
}

/** Allow the stop and exit cleanly. */
function allow(message) {
  if (message) console.log(message);
  process.exit(0);
}

async function main() {
  const payload = await readStdinPayload();

  // Loop guard: if this stop was itself triggered while a stop hook was active,
  // let the session stop. Without this the gate can loop and drain usage limits.
  if (payload.stop_hook_active) {
    allow("ALLOW: stop_hook_active (avoiding review loop).");
  }

  const workspace = payload.cwd || (await resolveWorkspace());

  // Check if the review gate is enabled for this workspace.
  const state = loadState(workspace);
  if (!state.config?.reviewGate) {
    allow("ALLOW: Review gate is disabled.");
  }

  // Check if an OpenCode server is reachable; if not, don't block.
  if (!(await isServerRunning())) {
    allow("ALLOW: OpenCode server not running.");
  }

  // Pull Claude's final response text from the transcript.
  const claudeResponse = readLastAssistantText(payload.transcript_path);
  if (!claudeResponse.trim()) {
    allow("ALLOW: No assistant response to review.");
  }

  // Load the stop-review-gate prompt template and inject the response.
  const templatePath = path.join(PLUGIN_ROOT, "prompts", "stop-review-gate.md");
  const template = fs.readFileSync(templatePath, "utf8");
  const prompt = template.replace(
    "{{CLAUDE_RESPONSE_BLOCK}}",
    `<claude_response>\n${claudeResponse}\n</claude_response>`
  );

  try {
    const client = await connect({ cwd: workspace });
    const session = await client.createSession({ title: "Stop Review Gate" });

    const response = await client.sendPromptAndWait(session.id, prompt, {
      agent: "plan", // read-only review
    });

    // The review's first line is `ALLOW: ...` or `BLOCK: ...`.
    const text = extractText(response);
    const firstLine = text.trim().split("\n")[0] ?? "";

    if (firstLine.startsWith("BLOCK")) {
      // Exit code 2 blocks the stop; stderr is surfaced back to Claude so it
      // can address the issue before stopping again.
      process.stderr.write(`OpenCode review gate: ${firstLine}\n`);
      process.exit(2);
    }

    allow(firstLine || "ALLOW: No issues found.");
  } catch (err) {
    // On any failure, allow the stop (don't block on errors).
    allow(`ALLOW: Review gate error: ${err.message}`);
  }
}

function extractText(response) {
  if (typeof response === "string") return response;
  if (response?.parts) {
    return response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(response);
}

main().catch((err) => {
  // Never block the stop on an unexpected hook error.
  console.log(`ALLOW: Unhandled error: ${err.message}`);
  process.exit(0);
});
