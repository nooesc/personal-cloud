import { timingSafeEqual } from "node:crypto";
if (!crypto.subtle.timingSafeEqual)
  crypto.subtle.timingSafeEqual = timingSafeEqual;
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleAppleJobs,
  validateAppleJob,
  appleReady,
} from "../src/apple-jobs.ts";
import { sha256 } from "../src/crypto.ts";
import {
  appleNode,
  appleNomadJob,
  reconcileAppleJobs,
} from "../src/apple-nomad.ts";
import { deriveReadiness } from "../src/readiness.ts";
const spec = {
  scheme: "App",
  container: "ios/App.xcodeproj",
  commit: "a".repeat(40),
  action: "test",
  simulator: "A".repeat(36),
};
async function context() {
  const values = new Map();
  const ctx = {
    workspaceId: "w",
    userId: "u",
    machineId: null,
    store: {
      get: (c, k) => values.get(c + ":" + k),
      put: (c, k, v) => values.set(c + ":" + k, v),
      list: (c) =>
        [...values].filter(([k]) => k.startsWith(c + ":")).map(([, v]) => v),
    },
    env: {},
    broadcast() {},
    event() {},
    async schedule() {},
  };
  ctx.store.put("projects", "p", { id: "p", repository: "owner/app" });
  ctx.store.put("machines", "m", {
    id: "m",
    credential_hash: await sha256("machine-secret"),
    last_seen: new Date().toISOString(),
    report: {
      docker: false,
      nomad: false,
      apple: {
        enabled: true,
        xcode: "Xcode 26",
        simulators: [{ id: spec.simulator }],
      },
    },
  });
  return ctx;
}
function request(path, method = "GET", body, headers = {}) {
  return new Request("https://local.test/api/" + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const agentHeaders = {
  Authorization: "Bearer machine-secret",
  "x-apple-attempt": "attempt",
};
test("Apple job input rejects path traversal, option injection and mutable revisions", () => {
  assert.equal(validateAppleJob(spec).timeout_seconds, 1800);
  for (const patch of [
    { container: "../App.xcodeproj" },
    { container: "/tmp/App.xcodeproj" },
    { scheme: "-help" },
    { commit: "main" },
    { action: "archive" },
    { timeout_seconds: 99999 },
  ])
    assert.throws(() => validateAppleJob({ ...spec, ...patch }));
});
test("Apple readiness never implies Linux deployment or builder capacity", async () => {
  const ctx = await context(),
    m = ctx.store.get("machines", "m");
  assert(appleReady(m));
  const r = deriveReadiness([m], null, undefined, true);
  assert.equal(r.machines[0].state, "reporting_only");
  assert.equal(r.machines[0].can_apple, false);
  assert.equal(r.machines[0].can_run, false);
  assert.equal(r.counts.ready_to_build, 0);
  m.last_seen = "2020-01-01";
  assert(!appleReady(m));
});
test("jobs are project-scoped and public responses omit attempts and object keys", async () => {
  const ctx = await context();
  ctx.store.put("apple_jobs", "j", {
    id: "j",
    project_id: "p",
    status: "running",
    created_at: new Date().toISOString(),
    deadline: Date.now() + 10000,
    attempt: "secret",
    artifact_key: "private",
  });
  ctx.store.put("apple_jobs", "other", {
    id: "other",
    project_id: "elsewhere",
    created_at: new Date().toISOString(),
  });
  const r = await (
    await handleAppleJobs(request("projects/p/apple-jobs"), ctx)
  ).json();
  assert.equal(r.jobs.length, 1);
  assert(!JSON.stringify(r).includes("secret"));
  assert(!JSON.stringify(r).includes("private"));
  await assert.rejects(
    handleAppleJobs(request("projects/p/apple-jobs/other", "DELETE"), ctx),
    /not found/,
  );
});
test("cancellation and completion wait for Nomad observation", async () => {
  const ctx = await context();
  ctx.store.put("apple_jobs", "j", {
    id: "j",
    project_id: "p",
    machine_id: "m",
    status: "running",
    attempt: "attempt",
    nomad_job_id: "pc-apple-j",
  });
  await handleAppleJobs(
    request(
      "agent/m/apple-jobs/j",
      "POST",
      { status: "succeeded", log: "done" },
      agentHeaders,
    ),
    ctx,
  );
  assert.equal(ctx.store.get("apple_jobs", "j").status, "running");
  ctx.requestNomad = async () => [{ ID: "alloc", ClientStatus: "complete" }];
  await reconcileAppleJobs(ctx);
  assert.equal(ctx.store.get("apple_jobs", "j").status, "succeeded");
  await assert.rejects(
    handleAppleJobs(
      request(
        "agent/m/apple-jobs/j",
        "POST",
        { status: "failed", log: "late" },
        agentHeaders,
      ),
      ctx,
    ),
    /already finished/,
  );
  ctx.store.put("apple_jobs", "j", {
    ...ctx.store.get("apple_jobs", "j"),
    status: "queued",
  });
  await handleAppleJobs(request("projects/p/apple-jobs/j", "DELETE"), ctx);
  assert.equal(ctx.store.get("apple_jobs", "j").status, "cancelling");
});
test("legacy claim loop is rejected and old jobs never silently resubmit", async () => {
  const ctx = await context();
  await assert.rejects(
    handleAppleJobs(
      request("agent/m/apple-jobs", "POST", {}, agentHeaders),
      ctx,
    ),
    /removed/,
  );
  ctx.store.put("apple_jobs", "old", { id: "old", status: "queued" });
  await reconcileAppleJobs(ctx);
  assert.equal(ctx.store.get("apple_jobs", "old").status, "interrupted");
});
test("native jobs pin Darwin, disable retries, and contain no source or machine credentials", () => {
  const node = {
    ID: "node",
    Status: "ready",
    SchedulingEligibility: "eligible",
    Attributes: { "kernel.name": "darwin" },
    Drivers: { raw_exec: { Healthy: true } },
    Meta: {
      pc_apple: "true",
      pc_apple_agent: "/opt/agent",
      pc_apple_state: "/private/state",
      pc_apple_work: "/private/jobs",
    },
  };
  assert(appleNode(node));
  assert(!appleNode({ ...node, Drain: true }));
  assert(!appleNode({ ...node, Attributes: { "kernel.name": "linux" } }));
  const job = appleNomadJob(
    { id: "job", nomad_job_id: "pc-apple-job", attempt: "attempt" },
    node,
    "https://local.test",
  );
  assert.equal(job.Job.Type, "batch");
  assert.equal(job.Job.TaskGroups[0].Tasks[0].Driver, "raw_exec");
  assert.equal(job.Job.TaskGroups[0].RestartPolicy.Attempts, 0);
  assert.equal(job.Job.TaskGroups[0].ReschedulePolicy.Unlimited, false);
  assert.equal(job.Job.Constraints[0].RTarget, "node");
  assert(!JSON.stringify(job).includes("source_token"));
});
test("machine credentials cannot read owner job history or forge another machine result", async () => {
  const ctx = await context();
  ctx.userId = null;
  await assert.rejects(handleAppleJobs(request("projects/p/apple-jobs"), ctx));
  await assert.rejects(
    handleAppleJobs(
      request("agent/other/apple-jobs", "POST", {}, agentHeaders),
      ctx,
    ),
    /authentication/,
  );
});
