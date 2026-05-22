import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectIncompleteFinish, changedFilesFromParts } from "../plugins/opencode/scripts/lib/response.mjs";

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
