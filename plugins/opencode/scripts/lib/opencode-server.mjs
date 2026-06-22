// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API via the
// official, typed `@opencode-ai/sdk` client (vendored under scripts/vendor),
// keeping the same method surface the rest of the plugin already calls.

import { spawn } from "node:child_process";

import { createOpencodeClient } from "../vendor/opencode-sdk/client.js";
import { isSessionBusy, lastAssistantMessage } from "./response.mjs";

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

// Per-request HTTP timeout. We only ever dispatch prompts asynchronously
// (prompt_async returns immediately), so no single request is long-lived; this
// bounds individual calls (status polls, message fetches, etc.) so a hung
// localhost socket can't stall a task forever.
const REQUEST_TIMEOUT = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS) || 300_000;
// Overall budget for a task to finish while we poll for completion.
const TASK_TIMEOUT = Number(process.env.OPENCODE_TASK_TIMEOUT_MS) || 1_800_000; // 30 min
const POLL_INTERVAL = Number(process.env.OPENCODE_POLL_INTERVAL_MS) || 2_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Check if an OpenCode server is already running on the given port.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isServerRunning(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://${host}:${port}/global/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the OpenCode server if not already running.
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.cwd]
 * @returns {Promise<{ url: string, pid?: number, alreadyRunning: boolean }>}
 */
export async function ensureServer(opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://${host}:${port}`;

  if (await isServerRunning(host, port)) {
    return { url, alreadyRunning: true };
  }

  // Start the server
  const proc = spawn("opencode", ["serve", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd: opts.cwd,
    shell: process.platform === "win32",
  });
  proc.unref();

  // Wait for the server to become ready
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  while (Date.now() < deadline) {
    if (await isServerRunning(host, port)) {
      return { url, pid: proc.pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`OpenCode server failed to start within ${SERVER_START_TIMEOUT / 1000}s`);
}

/**
 * Create an API client bound to a running OpenCode server.
 *
 * Wraps the typed `@opencode-ai/sdk` client. The client is configured with
 * `responseStyle: "data"` + `throwOnError: true`, so each method returns the
 * unwrapped response body and throws on a non-2xx status — the same contract
 * the rest of the plugin relied on from the previous hand-rolled client.
 *
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace directory to scope operations to
 * @returns {object}
 */
export function createClient(baseUrl, opts = {}) {
  const directory = opts.directory;

  const config = {
    baseUrl,
    responseStyle: "data",
    throwOnError: true,
    // Bound every request. The SDK's default fetch disables timeouts, which
    // would let a hung socket stall the status-poll loop past its deadline.
    fetch: (req) => fetch(req, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) }),
  };
  if (directory) config.directory = directory;
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const cred = Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
    config.headers = { Authorization: `Basic ${cred}` };
  }

  const sdk = createOpencodeClient(config);

  // OpenCode scopes operations by the `directory` query param. The SDK's
  // client-level `directory` only backfills it onto GET/HEAD requests, so we
  // pass it explicitly on every session call (including POST mutations) to
  // ensure work targets the project dir even on a shared :4096 server.
  const withDir = (extra) => {
    const q = { ...(directory ? { directory } : {}), ...extra };
    return Object.keys(q).length ? q : undefined;
  };

  return {
    baseUrl,

    // Sessions
    createSession: (sessionOpts = {}) =>
      sdk.session.create({ body: sessionOpts, query: withDir() }),
    abortSession: (id) => sdk.session.abort({ path: { id }, query: withDir() }),
    getSessionStatus: () => sdk.session.status({ query: withDir() }),
    getSessionDiff: (id) => sdk.session.diff({ path: { id }, query: withDir() }),

    // Messages
    getMessages: (sessionId, msgOpts = {}) => {
      const extra = {};
      if (msgOpts.limit) extra.limit = msgOpts.limit;
      if (msgOpts.before) extra.before = msgOpts.before;
      return sdk.session.messages({ path: { id: sessionId }, query: withDir(extra) });
    },

    /**
     * Send a prompt asynchronously (returns immediately).
     */
    sendPromptAsync: (sessionId, promptText, sendOpts = {}) =>
      sdk.session.promptAsync({
        path: { id: sessionId },
        query: withDir(),
        body: buildPromptBody(promptText, sendOpts),
      }),

    /**
     * Dispatch a prompt asynchronously, then poll session status until the
     * session is no longer busy, and return the final assistant message
     * ({ info, parts }).
     *
     * No single fetch is held open for the task's whole duration, so this is
     * immune to the ~5-minute headers timeout that breaks a synchronous send on
     * long tasks. Transient status-poll errors are retried, not treated as
     * task failure.
     * @param {string} sessionId
     * @param {string} promptText
     * @param {object} [sendOpts] - { agent, model, timeoutMs, pollMs }
     * @returns {Promise<object|null>}
     */
    sendPromptAndWait: async (sessionId, promptText, sendOpts = {}) => {
      await sdk.session.promptAsync({
        path: { id: sessionId },
        query: withDir(),
        body: buildPromptBody(promptText, sendOpts),
      });

      const pollMs = sendOpts.pollMs ?? POLL_INTERVAL;
      const deadline = Date.now() + (sendOpts.timeoutMs ?? TASK_TIMEOUT);
      while (true) {
        await sleep(pollMs);
        let statusMap;
        try {
          statusMap = await sdk.session.status({ query: withDir() });
        } catch {
          // Transient poll failure: the session may still be running.
          // Retry rather than declaring the task failed (avoids false negatives).
          if (Date.now() > deadline) break;
          continue;
        }
        if (!isSessionBusy(statusMap, sessionId)) break;
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out after ${Math.round((sendOpts.timeoutMs ?? TASK_TIMEOUT) / 1000)}s ` +
              `waiting for session ${sessionId}. It may still be running — ` +
              "check `/opencode:status` and the OpenCode logs."
          );
        }
      }

      const messages = await sdk.session.messages({
        path: { id: sessionId },
        query: withDir(),
      });
      return lastAssistantMessage(messages);
    },

    // Providers — returns the current OpenCode shape { all, default, connected }.
    listProviders: () => sdk.provider.list(),
  };
}

/**
 * Build the message body sent to /session/:id/{message,prompt_async}.
 * @param {string} promptText
 * @param {object} opts - { agent, model }
 */
function buildPromptBody(promptText, opts = {}) {
  const body = { parts: [{ type: "text", text: promptText }] };
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) body.model = opts.model; // { providerID, modelID }
  return body;
}

/**
 * Connect to OpenCode: ensure server is running, create client.
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {number} [opts.port]
 * @returns {Promise<ReturnType<typeof createClient> & { serverInfo: object }>}
 */
export async function connect(opts = {}) {
  const { url } = await ensureServer(opts);
  const client = createClient(url, { directory: opts.cwd });
  return { ...client, serverInfo: { url } };
}
