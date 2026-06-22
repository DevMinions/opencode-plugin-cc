// Helpers for interpreting an OpenCode session message response.
// The response shape is a single message object: { info: { role, finish, ... }, parts: [...] }.

// Terminal finish reasons that represent a normal end of a step/turn.
const NORMAL_FINISH = new Set([
  "stop",
  "length",
  "tool_calls",
  "tool-calls",
  "end_turn",
  "completed",
  "done",
]);

/**
 * Detect an abnormal / incomplete OpenCode termination.
 * Returns the offending finish reason string when the response did not end with
 * a normal terminal reason (e.g. "unknown", "error"), else null.
 * @param {object|string} response
 * @returns {string|null}
 */
export function detectIncompleteFinish(response) {
  if (!response || typeof response !== "object") return null;

  const infoFinish = response.info?.finish;
  let stepReason;
  if (Array.isArray(response.parts)) {
    const lastStep = [...response.parts].reverse().find((p) => p?.type === "step-finish");
    stepReason = lastStep?.reason;
  }

  const reason = infoFinish ?? stepReason;
  // No finish info at all: unknown shape — don't false-positive.
  if (!reason) return null;
  return NORMAL_FINISH.has(reason) ? null : reason;
}

/**
 * Best-effort derivation of changed file paths from write/edit tool-call parts.
 * Defensive: unknown shapes yield an empty list rather than throwing.
 * @param {object|string} response
 * @returns {string[]}
 */
export function changedFilesFromParts(response) {
  const files = new Set();
  const parts = response?.parts;
  if (!Array.isArray(parts)) return [];

  for (const part of parts) {
    if (part?.type !== "tool") continue;
    const name = part.tool ?? part.name ?? "";
    if (!/write|edit|patch|create/i.test(name)) continue;
    const input = part.state?.input ?? part.input ?? {};
    const p = input.filePath ?? input.path ?? input.file;
    if (typeof p === "string" && p) files.add(p);
  }
  return [...files];
}

/**
 * Whether a session is still running, per the /session/status map
 * ({ [sessionId]: SessionStatus }). SessionStatus is one of
 * { type: "idle" } | { type: "retry", ... } | { type: "busy" }. Both "busy"
 * and "retry" mean still-running — treating "retry" (e.g. a provider rate-limit
 * backoff) as done would grab an incomplete message. A session that has left
 * the map (key absent) is no longer busy.
 * @param {object} statusMap
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isSessionBusy(statusMap, sessionId) {
  const entry = statusMap?.[sessionId];
  return !!entry && (entry.type === "busy" || entry.type === "retry");
}

/**
 * Pick the last assistant message from a /session/:id/message array.
 * Falls back to the last message of any role, else null.
 * @param {Array} messages
 * @returns {object|null}
 */
export function lastAssistantMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const assistant = messages.filter((m) => (m?.info?.role ?? m?.role) === "assistant");
  return assistant[assistant.length - 1] ?? messages[messages.length - 1] ?? null;
}
