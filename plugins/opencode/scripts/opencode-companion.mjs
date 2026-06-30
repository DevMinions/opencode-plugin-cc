#!/usr/bin/env node

// OpenCode Companion — foreground entry point for the Claude Code plugin.
// One blocking call per dispatch: connect → prompt → poll to completion → print
// a "what it did" tool-call tree + the result. No background workers, no job
// state, no polling relay.

import path from "node:path";
import process from "node:process";

import { parseArgs, extractTaskText } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion } from "./lib/process.mjs";
import { isServerRunning, createClient, connect } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { renderReview, renderSetup } from "./lib/render.mjs";
import { buildReviewPrompt, buildTaskPrompt } from "./lib/prompts.mjs";
import { detectIncompleteFinish, changedFilesFromParts } from "./lib/response.mjs";
import { getLastSession, recordSession } from "./lib/session-memory.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

const [subcommand, ...argv] = process.argv.slice(2);

const handlers = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-resume-candidate": handleTaskResumeCandidate,
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Available: ${Object.keys(handlers).join(", ")}`);
  process.exit(1);
}

handler(argv).then(
  () => gracefulExit(0),
  (err) => {
    console.error(`Error in ${subcommand}: ${err.message}`);
    gracefulExit(1);
  }
);

/**
 * Force a clean process exit once the work is done. The OpenCode HTTP client
 * keeps keep-alive sockets open, which otherwise hold the event loop and leave
 * the process hanging long after the result is printed. We flush stdout/stderr
 * first so nothing is truncated, then exit (with a short safety-net timer).
 * @param {number} code
 */
function gracefulExit(code) {
  let pending = 0;
  const tryExit = () => {
    if (pending === 0) process.exit(code);
  };
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.writableLength > 0) {
      pending++;
      stream.once("drain", () => {
        pending--;
        tryExit();
      });
    }
  }
  setTimeout(() => process.exit(code), 250).unref();
  tryExit();
}

// ------------------------------------------------------------------
// Foreground runner — prints a "what it did" tool-call tree on completion
// ------------------------------------------------------------------

/**
 * Run a foreground OpenCode interaction and, on completion, print a compact
 * "what it did" tool-call tree to STDOUT right above the result. Claude Code
 * buffers tool output and only surfaces a subagent's returned stdout, so the
 * tree must be on stdout to be visible to the user once the task finishes.
 * The runner returns a result object that may carry `treeLines`.
 * @param {string} label - e.g. "glm-5.2 · build"
 * @param {() => Promise<object>} runner
 */
async function runForeground(label, runner) {
  const t0 = Date.now();
  try {
    const result = await runner();
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const tree = [`opencode · ${label}`, ...(result.treeLines ?? []), `✓ done (${secs}s)`];
    process.stdout.write(tree.join("\n") + "\n\n");
    return result;
  } catch (err) {
    process.stdout.write(`opencode · ${label}\n✗ ${err.message}\n\n`);
    throw err;
  }
}

/**
 * Build the "what it did" tree (one line per tool call, in order) from the
 * session's final assistant messages — computed once, so each tool call is
 * counted exactly once (no per-poll duplication).
 * @param {Array} messages
 * @returns {string[]}
 */
function buildToolTree(messages) {
  const lines = [];
  for (const m of messages ?? []) {
    if ((m?.info?.role ?? m?.role) !== "assistant") continue;
    for (const part of m?.parts ?? []) {
      const line = formatToolLine(part);
      if (line) lines.push(line);
    }
  }
  return lines;
}

/**
 * Format a tool-call part as a one-line tree entry. For file paths, keep the
 * tail (the filename) visible rather than the long /tmp/... prefix.
 * @param {object} part
 * @returns {string|null}
 */
function formatToolLine(part) {
  if (!part || part.type !== "tool") return null;
  const tool = part.tool ?? part.name ?? "tool";
  const input = part.state?.input ?? part.input ?? {};
  const filePath = input.filePath ?? input.path ?? input.file;
  const other = input.command ?? input.pattern ?? input.query ?? input.url;
  let target = "";
  if (filePath) {
    const p = String(filePath);
    target = p.length > 50 ? "…" + p.slice(-49) : p; // keep the filename end
  } else if (other) {
    const o = String(other).replace(/\s+/g, " ").trim();
    target = o.length > 60 ? o.slice(0, 57) + "…" : o;
  }
  return `├ ${tool}${target ? "  " + target : ""}`;
}

/** Fetch the session's messages, returning [] on any error. */
async function safeGetMessages(client, sessionId) {
  try {
    return (await client.getMessages(sessionId)) ?? [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });

  const installed = await isOpencodeInstalled();
  const version = installed ? await getOpencodeVersion() : null;

  let serverRunning = false;
  let providers = [];
  if (installed) {
    serverRunning = await isServerRunning();
    if (serverRunning) {
      try {
        const client = createClient("http://127.0.0.1:4096");
        const providerData = await client.listProviders();
        providers = Array.isArray(providerData?.connected) ? providerData.connected : [];
      } catch {
        // Server may not be fully ready.
      }
    }
  }

  const status = { installed, version, serverRunning, providers };
  if (options.json) console.log(JSON.stringify(status, null, 2));
  else console.log(renderSetup(status));
}

// ------------------------------------------------------------------
// Reviews (read-only presets on top of the same foreground core)
// ------------------------------------------------------------------

async function runReview(argv, { adversarial }) {
  const { options, positional } = parseArgs(argv, { valueOptions: ["base", "scope"] });
  const focus = adversarial ? positional.join(" ").trim() : "";
  const workspace = await resolveWorkspace();
  const label = adversarial ? "review · adversarial" : "review";

  try {
    const result = await runForeground(label, async () => {
      const client = await connect({ cwd: workspace });
      const session = await client.createSession({ title: `${label} ${Date.now().toString(36)}` });
      const prompt = await buildReviewPrompt(workspace, { base: options.base, adversarial, focus }, PLUGIN_ROOT);
      const response = await client.sendPromptAndWait(session.id, prompt, { agent: "plan" });
      const treeLines = buildToolTree(await safeGetMessages(client, session.id));
      const text = extractResponseText(response);
      const structured = tryParseJson(text);
      return { rendered: structured ? renderReview(structured) : text, treeLines };
    });
    console.log(result.rendered);
  } catch (err) {
    console.error(`${adversarial ? "Adversarial review" : "Review"} failed: ${err.message}`);
    process.exit(1);
  }
}

// Function declarations (hoisted) so the `handlers` map above can reference them.
function handleReview(argv) {
  return runReview(argv, { adversarial: false });
}
function handleAdversarialReview(argv) {
  return runReview(argv, { adversarial: true });
}

// ------------------------------------------------------------------
// Task — the general, unrestricted delegate (default: read/write, glm-5.2)
// ------------------------------------------------------------------

async function handleTask(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["model", "agent"],
    booleanOptions: ["write", "plan", "read-only", "resume", "resume-last", "fresh"],
  });

  const taskText = extractTaskText(argv, ["model", "agent"], [
    "write", "plan", "read-only", "resume", "resume-last", "fresh",
  ]);
  if (!taskText) {
    console.error("No task text provided.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  // Default: write-capable. `--plan`/`--read-only` switches to read-only plan agent.
  const isWrite = !(options.plan || options["read-only"]);
  const agentName = options.agent ?? (isWrite ? "build" : "plan");

  // Resume the last OpenCode session for this workspace unless --fresh.
  const resumeLast = Boolean(options.resume || options["resume-last"]);
  const fresh = Boolean(options.fresh);
  const resumeSessionId = resumeLast && !fresh ? getLastSession(workspace) : null;

  // Model: unset => OpenCode uses its own configured default (currently glm-5.2).
  const modelLabel = options.model ?? "default";

  let sessionId = null;
  try {
    const result = await runForeground(`${modelLabel} · ${agentName}`, async () => {
      const client = await connect({ cwd: workspace });

      if (resumeSessionId) {
        sessionId = resumeSessionId;
      } else {
        const session = await client.createSession({ title: `Task ${Date.now().toString(36)}` });
        sessionId = session.id;
      }

      const prompt = buildTaskPrompt(taskText, { write: isWrite });
      const sendOpts = { agent: agentName };
      if (options.model) sendOpts.model = parseModelOption(options.model);

      const response = await client.sendPromptAndWait(sessionId, prompt, sendOpts);
      const messages = await safeGetMessages(client, sessionId);
      const treeLines = buildToolTree(messages);
      const text = extractResponseText(response);
      const changedFiles = await collectChangedFiles(client, sessionId, messages, response, isWrite);
      const finishReason = detectIncompleteFinish(response);
      return {
        rendered: text,
        treeLines,
        changedFiles,
        incomplete: !!finishReason,
        finishReason: finishReason ?? undefined,
      };
    });

    if (sessionId) recordSession(workspace, sessionId);

    if (result.incomplete) {
      console.log(
        `[incomplete] OpenCode ended abnormally (finish: ${result.finishReason}). ` +
          'Partial output below; continue with `/opencode:rescue --resume-last "..."`.'
      );
    }
    console.log(result.rendered);

    const footer = [];
    if (result.changedFiles?.length > 0) footer.push(`changed: ${result.changedFiles.join(", ")}`);
    if (sessionId) footer.push(`session: ${sessionId}`);
    if (footer.length) {
      console.log(`\n---\n${footer.join("  ·  ")}  ·  resume: /opencode:rescue --resume-last "..."`);
    }
  } catch (err) {
    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });
  const workspace = await resolveWorkspace();
  const sid = getLastSession(workspace);
  const result = { available: !!sid, opencodeSessionId: sid ?? null };
  if (options.json) console.log(JSON.stringify(result));
  else console.log(sid ? `Resumable session: ${sid}` : "No resumable session.");
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Parse a "provider/model" string into the OpenCode API model object.
 * @param {string} raw
 * @returns {{ providerID?: string, modelID: string }}
 */
function parseModelOption(raw) {
  const idx = raw.indexOf("/");
  if (idx < 0) return { modelID: raw };
  return { providerID: raw.slice(0, idx), modelID: raw.slice(idx + 1) };
}

/**
 * Extract text from an OpenCode API response ({ info, parts }).
 * @param {any} response
 * @returns {string}
 */
function extractResponseText(response) {
  if (typeof response === "string") return response;
  if (response?.parts) {
    return response.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  }
  if (response?.info?.content) {
    if (typeof response.info.content === "string") return response.info.content;
    if (Array.isArray(response.info.content)) {
      return response.info.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    }
  }
  return JSON.stringify(response, null, 2);
}

/**
 * Collect files changed by a write-mode task from the already-fetched session
 * messages (write/edit tool-call parts), plus the session diff as a best-effort
 * secondary source.
 * @returns {Promise<string[]>}
 */
async function collectChangedFiles(client, sessionId, messages, response, isWrite) {
  if (!isWrite) return [];
  const files = new Set();
  const msgs = messages?.length ? messages : response ? [response] : [];
  for (const m of msgs) for (const p of changedFilesFromParts(m)) files.add(p);
  try {
    const diff = await client.getSessionDiff(sessionId);
    const fileDiffs = Array.isArray(diff) ? diff : diff?.files ?? [];
    for (const f of fileDiffs) {
      const p = f.file || f.path || f.name;
      if (p) files.add(p);
    }
  } catch {
    // diff endpoint may be unavailable
  }
  return [...files];
}

/**
 * Try to parse a string as JSON (possibly fenced), returning null on failure.
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJson(text) {
  const jsonMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = jsonMatch ? jsonMatch[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}
