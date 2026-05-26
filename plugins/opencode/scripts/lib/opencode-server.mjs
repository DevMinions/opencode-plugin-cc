// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.

import { spawn } from "node:child_process";

import { isSessionBusy, lastAssistantMessage } from "./response.mjs";

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

// Per-request HTTP timeout for short calls (status/messages/dispatch). Long
// tasks never ride a single request — see sendPromptAndWait.
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
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace directory for x-opencode-directory header
 * @returns {OpenCodeClient}
 */
export function createClient(baseUrl, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (opts.directory) {
    headers["x-opencode-directory"] = opts.directory;
  }
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const cred = Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }

  async function request(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${method} ${path} returned ${res.status}: ${text}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  return {
    baseUrl,

    // Health
    health: () => request("GET", "/global/health"),

    // Sessions
    listSessions: () => request("GET", "/session"),
    createSession: (opts = {}) => request("POST", "/session", opts),
    getSession: (id) => request("GET", `/session/${id}`),
    deleteSession: (id) => request("DELETE", `/session/${id}`),
    abortSession: (id) => request("POST", `/session/${id}/abort`),
    getSessionStatus: () => request("GET", "/session/status"),
    getSessionDiff: (id) => request("GET", `/session/${id}/diff`),

    // Messages
    getMessages: (sessionId, opts = {}) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.before) params.set("before", opts.before);
      const qs = params.toString();
      return request("GET", `/session/${sessionId}/message${qs ? "?" + qs : ""}`);
    },

    /**
     * Send a prompt (synchronous / streaming).
     * Returns the full response text from SSE stream.
     */
    sendPrompt: async (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      if (opts.system) body.system = opts.system;

      const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000), // 10 min for long tasks
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenCode prompt failed ${res.status}: ${text}`);
      }

      return res.json();
    },

    /**
     * Send a prompt asynchronously (returns immediately).
     */
    sendPromptAsync: (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      return request("POST", `/session/${sessionId}/prompt_async`, body);
    },

    /**
     * Dispatch a prompt asynchronously, then poll session status until the
     * session is no longer busy, and return the final assistant message
     * ({ info, parts }) — the same shape the synchronous sendPrompt returned.
     *
     * No single fetch is held open for the task's whole duration, so this is
     * immune to the ~5-minute headers timeout that breaks the synchronous path
     * on long tasks. Transient status-poll errors are retried, not treated as
     * task failure.
     * @param {string} sessionId
     * @param {string} promptText
     * @param {object} [opts] - { agent, model, timeoutMs, pollMs }
     * @returns {Promise<object|null>}
     */
    sendPromptAndWait: async (sessionId, promptText, opts = {}) => {
      const body = { parts: [{ type: "text", text: promptText }] };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      await request("POST", `/session/${sessionId}/prompt_async`, body);

      const pollMs = opts.pollMs ?? POLL_INTERVAL;
      const deadline = Date.now() + (opts.timeoutMs ?? TASK_TIMEOUT);
      while (true) {
        await sleep(pollMs);
        let statusMap;
        try {
          statusMap = await request("GET", "/session/status");
        } catch {
          // Transient poll failure: the session may still be running.
          // Retry rather than declaring the task failed (avoids false negatives).
          if (Date.now() > deadline) break;
          continue;
        }
        if (!isSessionBusy(statusMap, sessionId)) break;
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out after ${Math.round((opts.timeoutMs ?? TASK_TIMEOUT) / 1000)}s ` +
              `waiting for session ${sessionId}. It may still be running — ` +
              "check `/opencode:status` and the OpenCode logs."
          );
        }
      }

      const messages = await request("GET", `/session/${sessionId}/message`);
      return lastAssistantMessage(messages);
    },

    // Agents
    listAgents: () => request("GET", "/agent"),

    // Providers
    listProviders: () => request("GET", "/provider"),
    getProviderAuth: () => request("GET", "/provider/auth"),

    // Config
    getConfig: () => request("GET", "/config"),

    // Events (SSE) - returns a ReadableStream
    subscribeEvents: async () => {
      const res = await fetch(`${baseUrl}/event`, {
        headers: { ...headers, Accept: "text/event-stream" },
      });
      return res.body;
    },
  };
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
