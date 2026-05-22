import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWaitableJob } from "../plugins/opencode/scripts/lib/job-control.mjs";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

describe("resolveWaitableJob", () => {
  const jobs = [
    { id: "task-old", status: "completed", type: "task", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "task-run", status: "running", type: "task", updatedAt: "2026-01-01T02:00:00Z" },
    { id: "task-fail", status: "failed", type: "task", updatedAt: "2026-01-01T01:00:00Z" },
  ];

  it("matches a still-running job by ref (unlike resolveResultJob)", () => {
    const { job, ambiguous } = resolveWaitableJob(jobs, "task-run");
    assert.equal(job.id, "task-run");
    assert.equal(ambiguous, false);
  });

  it("without ref, prefers the most recent running job", () => {
    const { job } = resolveWaitableJob(jobs);
    assert.equal(job.id, "task-run");
  });

  it("without ref and nothing running, falls back to latest finished", () => {
    const finishedOnly = jobs.filter((j) => j.status !== "running");
    const { job } = resolveWaitableJob(finishedOnly);
    assert.equal(job.id, "task-fail");
  });

  it("reports ambiguity on a prefix matching multiple jobs", () => {
    const { job, ambiguous } = resolveWaitableJob(jobs, "task-");
    assert.equal(job, null);
    assert.equal(ambiguous, true);
  });
});

// Integration: `result <id> --wait` must block until a (separately running)
// worker flips the job to completed, then print the job's output verbatim.
describe("result --wait (integration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.join(here, "..", "plugins", "opencode", "scripts", "opencode-companion.mjs");
  let dataDir;
  let workspace;
  let state;

  before(async () => {
    dataDir = createTmpDir("opencode-wait-data");
    // A non-git tmp dir so resolveWorkspace() returns the dir itself.
    workspace = createTmpDir("opencode-wait-ws");
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    // Import state lib AFTER setting CLAUDE_PLUGIN_DATA so paths resolve here.
    state = await import("../plugins/opencode/scripts/lib/state.mjs");
  });

  after(() => {
    cleanupTmpDir(dataDir);
    cleanupTmpDir(workspace);
  });

  it("blocks on a running job, then prints output once it completes", async () => {
    const jobId = "task-waittest";
    // Seed a running job.
    state.upsertJob(workspace, { id: jobId, type: "task", status: "running" });

    const child = spawn("node", [cli, "result", jobId, "--wait", "--timeout", "20"], {
      cwd: workspace,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });

    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));

    const started = Date.now();
    // After a delay, complete the job (simulating the background worker).
    const flip = setTimeout(() => {
      const dataFile = state.jobDataPath(workspace, jobId);
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify({ rendered: "WAITED_RESULT_OK" }), "utf8");
      state.upsertJob(workspace, { id: jobId, status: "completed", completedAt: new Date().toISOString() });
    }, 1500);

    const code = await new Promise((res) => child.on("exit", res));
    clearTimeout(flip);

    assert.equal(code, 0, "process should exit cleanly");
    assert.ok(stdout.includes("WAITED_RESULT_OK"), `output should contain result; got: ${stdout}`);
    assert.ok(Date.now() - started >= 1400, "should have blocked until the job completed");
  });
});
