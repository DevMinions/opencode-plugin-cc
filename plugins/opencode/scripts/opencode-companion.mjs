#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { parseArgs, extractTaskText } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, spawnDetached } from "./lib/process.mjs";
import { isServerRunning, ensureServer, createClient, connect } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, generateJobId, jobDataPath } from "./lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveWaitableJob, resolveCancelableJob, enrichJob } from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderReview, renderSetup } from "./lib/render.mjs";
import { buildReviewPrompt, buildTaskPrompt } from "./lib/prompts.mjs";
import { getDiff, getStatus as getGitStatus } from "./lib/git.mjs";
import { readJson } from "./lib/fs.mjs";
import { detectIncompleteFinish, changedFilesFromParts } from "./lib/response.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

// ------------------------------------------------------------------
// Subcommand dispatch
// ------------------------------------------------------------------

const [subcommand, ...argv] = process.argv.slice(2);

const handlers = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  result: handleResult,
  cancel: handleCancel,
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Available: ${Object.keys(handlers).join(", ")}`);
  process.exit(1);
}

handler(argv).catch((err) => {
  console.error(`Error in ${subcommand}: ${err.message}`);
  process.exit(1);
});

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const installed = await isOpencodeInstalled();
  const version = installed ? await getOpencodeVersion() : null;

  let serverRunning = false;
  let providers = [];

  if (installed) {
    serverRunning = await isServerRunning();

    if (serverRunning) {
      try {
        const client = createClient("http://127.0.0.1:4096");
        const providerList = await client.listProviders();
        if (Array.isArray(providerList)) {
          providers = providerList.map((p) => p.id ?? p.name).filter(Boolean);
        }
      } catch {
        // Server may not be fully ready
      }
    }
  }

  // Handle review gate toggle
  const workspace = await resolveWorkspace();
  let reviewGate = false;

  if (options["enable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = true;
    });
    reviewGate = true;
  } else if (options["disable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = false;
    });
    reviewGate = false;
  } else {
    const state = loadState(workspace);
    reviewGate = state.config?.reviewGate ?? false;
  }

  const status = { installed, version, serverRunning, providers, reviewGate };

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(renderSetup(status));
  }
}

// ------------------------------------------------------------------
// Review
// ------------------------------------------------------------------

async function handleReview(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["base", "scope"],
    booleanOptions: ["wait", "background"],
  });

  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "review", { base: options.base });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating review session...");
      const session = await client.createSession({ title: `Code Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: false,
      }, PLUGIN_ROOT);

      report("reviewing", "Running review...");
      log(`Prompt length: ${prompt.length} chars`);

      const response = await client.sendPromptAndWait(session.id, prompt, {
        agent: "plan", // read-only agent for reviews
      });

      report("finalizing", "Processing review output...");

      // Try to parse structured output
      const text = extractResponseText(response);
      let structured = tryParseJson(text);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Review failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleAdversarialReview(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["base", "scope"],
    booleanOptions: ["wait", "background"],
  });

  const focus = positional.join(" ").trim();
  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "adversarial-review", {
    base: options.base,
    focus,
  });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating adversarial review session...");
      const session = await client.createSession({ title: `Adversarial Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: true,
        focus,
      }, PLUGIN_ROOT);

      report("reviewing", "Running adversarial review...");
      log(`Prompt length: ${prompt.length} chars, focus: ${focus || "(none)"}`);

      const response = await client.sendPromptAndWait(session.id, prompt, {
        agent: "plan",
      });

      report("finalizing", "Processing review output...");

      const text = extractResponseText(response);
      let structured = tryParseJson(text);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Adversarial review failed: ${err.message}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Task (rescue delegation)
// ------------------------------------------------------------------

async function handleTask(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["model", "agent"],
    booleanOptions: ["write", "background", "wait", "resume", "resume-last", "fresh"],
  });

  const taskText = extractTaskText(argv, ["model", "agent"], [
    "write", "background", "wait", "resume", "resume-last", "fresh",
  ]);

  if (!taskText) {
    console.error("No task text provided.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const isWrite = options.write !== undefined ? options.write : true;
  const agentName = options.agent ?? (isWrite ? "build" : "plan");

  // Check for resume
  const resumeLast = Boolean(options["resume"] || options["resume-last"]);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    console.error("Choose either --resume/--resume-last or --fresh.");
    process.exit(1);
  }
  let resumeSessionId = null;
  if (resumeLast) {
    const state = loadState(workspace);
    const sessionId = getClaudeSessionId();
    const lastTask = state.jobs
      ?.filter((j) => j.type === "task" && j.opencodeSessionId)
      ?.filter((j) => !sessionId || j.sessionId === sessionId)
      ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

    if (lastTask?.opencodeSessionId) {
      resumeSessionId = lastTask.opencodeSessionId;
    }
  }

  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
  });

  // Background mode: spawn a detached worker
  if (options.background) {
    const workerArgs = [
      path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs"),
      "task-worker",
      "--job-id", job.id,
      "--workspace", workspace,
      "--task-text", taskText,
      "--agent", agentName,
    ];
    if (isWrite) workerArgs.push("--write");
    if (resumeSessionId) workerArgs.push("--resume-session", resumeSessionId);
    if (options.model) workerArgs.push("--model", options.model);

    spawnDetached("node", workerArgs, { cwd: workspace });
    console.log(`OpenCode task started in background: ${job.id}`);
    console.log("Check `/opencode:status` for progress.");
    console.log(`Block until done and print the result: \`/opencode:result ${job.id} --wait\``);
    return;
  }

  // Foreground mode
  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      let sessionId;
      if (resumeSessionId) {
        report("starting", `Resuming OpenCode session ${resumeSessionId}...`);
        sessionId = resumeSessionId;
      } else {
        report("starting", "Creating new OpenCode session...");
        const session = await client.createSession({ title: `Task ${job.id}` });
        sessionId = session.id;
      }
      upsertJob(workspace, { id: job.id, opencodeSessionId: sessionId });

      const prompt = buildTaskPrompt(taskText, { write: isWrite });

      report("investigating", "Sending task to OpenCode...");
      log(`Agent: ${agentName}, Write: ${isWrite}, Prompt: ${prompt.length} chars`);

      const sendOpts = { agent: agentName };
      if (options.model) sendOpts.model = parseModelOption(options.model);

      const response = await client.sendPromptAndWait(sessionId, prompt, sendOpts);

      report("finalizing", "Processing task output...");

      const text = extractResponseText(response);
      const changedFiles = await collectChangedFiles(client, sessionId, response, isWrite);
      const finishReason = detectIncompleteFinish(response);

      return {
        rendered: text,
        messages: response,
        changedFiles,
        summary: text.slice(0, 500),
        incomplete: !!finishReason,
        finishReason: finishReason ?? undefined,
      };
    });

    if (result.incomplete) {
      console.log(
        `[incomplete] OpenCode ended abnormally (finish: ${result.finishReason}). ` +
          "Partial output below; resume with `--resume`."
      );
    }
    console.log(result.rendered);
  } catch (err) {
    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["job-id", "workspace", "task-text", "agent", "model", "resume-session"],
    booleanOptions: ["write"],
  });

  const workspace = options.workspace;
  const jobId = options["job-id"];
  const taskText = options["task-text"];
  const agentName = options.agent ?? "build";
  const isWrite = !!options.write;
  const resumeSessionId = options["resume-session"];

  if (!workspace || !jobId || !taskText) {
    process.exit(1);
  }

  try {
    await runTrackedJob(workspace, { id: jobId }, async ({ report, log }) => {
      report("starting", "Background worker connecting to OpenCode...");
      const client = await connect({ cwd: workspace });

      let sessionId;
      if (resumeSessionId) {
        sessionId = resumeSessionId;
        report("starting", `Resuming session ${resumeSessionId}...`);
      } else {
        const session = await client.createSession({ title: `Task ${jobId}` });
        sessionId = session.id;
        report("starting", `Created session ${sessionId}`);
      }
      upsertJob(workspace, { id: jobId, opencodeSessionId: sessionId });

      const prompt = buildTaskPrompt(taskText, { write: isWrite });
      report("investigating", "Running task...");

      const sendOpts = { agent: agentName };
      if (options.model) sendOpts.model = parseModelOption(options.model);

      const response = await client.sendPromptAndWait(sessionId, prompt, sendOpts);

      const text = extractResponseText(response);
      const changedFiles = await collectChangedFiles(client, sessionId, response, isWrite);
      const finishReason = detectIncompleteFinish(response);
      report("finalizing", "Done");

      return {
        rendered: text,
        messages: response,
        changedFiles,
        summary: text.slice(0, 500),
        incomplete: !!finishReason,
        finishReason: finishReason ?? undefined,
      };
    });
  } catch (err) {
    // Error is already logged by runTrackedJob
    process.exit(1);
  }
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  const lastTask = state.jobs
    ?.filter((j) => j.type === "task" && j.opencodeSessionId)
    ?.filter((j) => j.status === "completed" || j.status === "running")
    ?.filter((j) => !sessionId || j.sessionId === sessionId)
    ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

  const result = {
    available: !!lastTask,
    jobId: lastTask?.id ?? null,
    opencodeSessionId: lastTask?.opencodeSessionId ?? null,
  };

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.available ? `Resumable session: ${result.opencodeSessionId}` : "No resumable session.");
  }
}

// ------------------------------------------------------------------
// Status / Result / Cancel
// ------------------------------------------------------------------

async function handleStatus(argv) {
  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  const snapshot = buildStatusSnapshot(state.jobs ?? [], workspace, { sessionId });
  console.log(renderStatus(snapshot));
}

async function handleResult(argv) {
  const { positional, options } = parseArgs(argv, {
    booleanOptions: ["wait"],
    valueOptions: ["timeout"],
  });
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  let state = loadState(workspace);

  // --wait: block until the target job reaches a terminal state, then render
  // it. Deterministic retrieval that does not depend on a background relay.
  if (options.wait) {
    const target = resolveWaitableJob(state.jobs ?? [], ref);
    if (target.ambiguous) {
      console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
      process.exit(1);
    }
    if (!target.job) {
      console.log("No matching job found to wait for.");
      return;
    }
    const jobId = target.job.id;
    const timeoutMs = options.timeout ? Number(options.timeout) * 1000 : 600000;
    const deadline = Date.now() + timeoutMs;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (true) {
      state = loadState(workspace);
      const j = (state.jobs ?? []).find((x) => x.id === jobId);
      if (j && (j.status === "completed" || j.status === "failed" || j.status === "incomplete")) break;
      if (Date.now() >= deadline) {
        console.error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${jobId}. ` +
            "Check `/opencode:status`."
        );
        process.exit(1);
      }
      await sleep(1000);
    }
  }

  const { job, ambiguous } = resolveResultJob(state.jobs ?? [], ref);

  if (ambiguous) {
    console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No finished job found.");
    return;
  }

  const enriched = enrichJob(job, workspace);

  // Try to load detailed result data
  const dataFile = jobDataPath(workspace, job.id);
  const resultData = readJson(dataFile);

  console.log(renderResult(enriched, resultData));
}

async function handleCancel(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);

  const { job, ambiguous } = resolveCancelableJob(state.jobs ?? [], ref);

  if (ambiguous) {
    console.error("Multiple running jobs. Please specify a job ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No active job to cancel.");
    return;
  }

  // Abort the OpenCode session if we have one
  if (job.opencodeSessionId) {
    try {
      const client = createClient("http://127.0.0.1:4096");
      await client.abortSession(job.opencodeSessionId);
    } catch {
      // Server may not be running
    }
  }

  // Kill the process if we have a PID
  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
  }

  upsertJob(workspace, {
    id: job.id,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Canceled by user",
  });

  console.log(`Canceled job: ${job.id}`);
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
 * Extract text from an OpenCode API response.
 * @param {any} response
 * @returns {string}
 */
function extractResponseText(response) {
  if (typeof response === "string") return response;

  // Response shape: { info: { ... }, parts: [ { type: "text", text: "..." }, ... ] }
  if (response?.parts) {
    return response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  // Fallback: try info.content or just stringify
  if (response?.info?.content) {
    if (typeof response.info.content === "string") return response.info.content;
    if (Array.isArray(response.info.content)) {
      return response.info.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  }

  return JSON.stringify(response, null, 2);
}

/**
 * Collect the list of files changed by a write-mode task: the session diff
 * first, falling back to write/edit tool-call parts when the diff is empty.
 * @param {object} client
 * @param {string} sessionId
 * @param {object} response
 * @param {boolean} isWrite
 * @returns {Promise<string[]>}
 */
async function collectChangedFiles(client, sessionId, response, isWrite) {
  if (!isWrite) return [];
  const files = new Set();
  try {
    const diff = await client.getSessionDiff(sessionId);
    for (const f of diff?.files ?? []) {
      const p = f.path || f.name;
      if (p) files.add(p);
    }
  } catch {
    // diff endpoint may not be available
  }
  for (const p of changedFilesFromParts(response)) files.add(p);
  return [...files];
}

/**
 * Try to parse a string as JSON, returning null on failure.
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJson(text) {
  // Look for JSON in the text (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = jsonMatch ? jsonMatch[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}
