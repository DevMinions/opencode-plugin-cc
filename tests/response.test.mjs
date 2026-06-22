import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectIncompleteFinish,
  changedFilesFromParts,
  isSessionBusy,
  lastAssistantMessage,
} from "../plugins/opencode/scripts/lib/response.mjs";

describe("detectIncompleteFinish", () => {
  it("flags an abnormal finish reason from info", () => {
    assert.equal(detectIncompleteFinish({ info: { finish: "unknown" }, parts: [] }), "unknown");
  });

  it("flags an abnormal finish reason from the last step-finish", () => {
    const response = {
      info: {},
      parts: [{ type: "step-start" }, { type: "step-finish", reason: "error" }],
    };
    assert.equal(detectIncompleteFinish(response), "error");
  });

  it("returns null for a normal stop", () => {
    assert.equal(detectIncompleteFinish({ info: { finish: "stop" }, parts: [] }), null);
  });

  it("treats tool_calls and length as normal", () => {
    assert.equal(detectIncompleteFinish({ info: { finish: "tool_calls" } }), null);
    assert.equal(detectIncompleteFinish({ info: { finish: "length" } }), null);
  });

  it("does not false-positive on unknown shapes", () => {
    assert.equal(detectIncompleteFinish({}), null);
    assert.equal(detectIncompleteFinish("plain string"), null);
    assert.equal(detectIncompleteFinish(null), null);
  });
});

describe("changedFilesFromParts", () => {
  it("extracts file paths from write/edit tool parts", () => {
    const response = {
      parts: [
        { type: "tool", tool: "write", state: { input: { filePath: "src/a.ts" } } },
        { type: "tool", tool: "edit", input: { path: "src/b.ts" } },
        { type: "text", text: "done" },
        { type: "tool", tool: "read", state: { input: { filePath: "src/c.ts" } } },
      ],
    };
    const files = changedFilesFromParts(response);
    assert.deepEqual(files.sort(), ["src/a.ts", "src/b.ts"]);
  });

  it("returns an empty array for unknown shapes", () => {
    assert.deepEqual(changedFilesFromParts({}), []);
    assert.deepEqual(changedFilesFromParts("x"), []);
    assert.deepEqual(changedFilesFromParts({ parts: [{ type: "tool", tool: "write" }] }), []);
  });
});

describe("isSessionBusy", () => {
  const map = {
    "ses-a": { type: "busy" },
    "ses-b": { type: "idle" },
    "ses-r": { type: "retry", attempt: 2 },
  };

  it("is true while the session is busy", () => {
    assert.equal(isSessionBusy(map, "ses-a"), true);
  });

  it("is true while the session is retrying (still running, not done)", () => {
    assert.equal(isSessionBusy(map, "ses-r"), true);
  });

  it("is false when the session left the status map (completed)", () => {
    assert.equal(isSessionBusy(map, "ses-gone"), false);
  });

  it("is false for an idle state", () => {
    assert.equal(isSessionBusy(map, "ses-b"), false);
  });

  it("is false for a missing or empty map", () => {
    assert.equal(isSessionBusy(undefined, "ses-a"), false);
    assert.equal(isSessionBusy({}, "ses-a"), false);
  });
});

describe("lastAssistantMessage", () => {
  it("returns the last assistant message ({info,parts})", () => {
    const msgs = [
      { info: { role: "user" }, parts: [] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "first" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "last" }] },
    ];
    assert.equal(lastAssistantMessage(msgs).parts[0].text, "last");
  });

  it("falls back to the last message when no assistant role present", () => {
    const msgs = [{ role: "tool" }, { role: "system" }];
    assert.deepEqual(lastAssistantMessage(msgs), { role: "system" });
  });

  it("returns null for empty or non-array input", () => {
    assert.equal(lastAssistantMessage([]), null);
    assert.equal(lastAssistantMessage(undefined), null);
  });
});
