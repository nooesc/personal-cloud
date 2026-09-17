import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveReadiness,
  deploymentTargets,
  observeReadiness,
} from "../src/readiness.ts";
const at = Date.now();
const machine = (id, extra = {}) => ({
  id,
  last_seen: new Date(at).toISOString(),
  report: { docker: true, nomad: true },
  ...extra,
});
const node = (id, arch = "amd64", roles = ["compute", "builder"]) => ({
  ID: id,
  Status: "ready",
  SchedulingEligibility: "eligible",
  Drain: false,
  Drivers: { docker: { Healthy: true } },
  Attributes: { "cpu.arch": arch },
  Meta: {
    pc_machine_id: id,
    ...Object.fromEntries(roles.map((r) => ["pc_" + r, "true"])),
  },
});
const observation = (nodes, extra = {}) => ({
  runtime: "agent://linux",
  checked_at: new Date(at).toISOString(),
  status: "connected",
  nodes,
  ...extra,
});
test("inventory-only machines are connected, never deployment-ready, and recommend first builder", () => {
  const r = deriveReadiness(
    [
      machine("mac", { report: { docker: false, nomad: false } }),
      machine("home", { report: { docker: true, nomad: false } }),
    ],
    null,
    undefined,
    true,
    at,
  );
  assert.deepEqual(r.counts, {
    connected: 2,
    ready_to_run: 0,
    ready_to_build: 0,
  });
  assert.equal(r.status, "blocked");
  assert.equal(r.blockers[0].code, "runtime_missing");
  assert.deepEqual(r.recommended_roles, ["compute", "builder"]);
});
test("only fresh scheduler eligibility for this workspace establishes readiness", () => {
  const machines = [machine("linux")];
  const nodes = [node("linux"), node("foreign")];
  const r = deriveReadiness(
    machines,
    "agent://linux",
    observation(nodes),
    true,
    at,
  );
  assert.equal(r.status, "ready");
  assert.equal(r.counts.ready_to_run, 1);
  for (const obs of [
    observation(nodes, { checked_at: new Date(at - 31000).toISOString() }),
    observation(nodes, { runtime: "agent://removed" }),
    observation(nodes, { status: "unreachable" }),
  ]) {
    const result = deriveReadiness(machines, "agent://linux", obs, true, at);
    assert.notEqual(result.status, "ready");
    assert.equal(result.counts.ready_to_run, 0);
  }
});
test("drained, ineligible, unhealthy, stale and invalid-heartbeat machines cannot deploy", () => {
  for (const change of [
    { Drain: true },
    { SchedulingEligibility: "ineligible" },
    { Drivers: { docker: { Healthy: false } } },
    { Status: "down" },
  ]) {
    const r = deriveReadiness(
      [machine("linux")],
      "agent://linux",
      observation([{ ...node("linux"), ...change }]),
      true,
      at,
    );
    assert.equal(r.counts.ready_to_run, 0);
  }
  for (const last_seen of ["invalid", new Date(at - 46000).toISOString()]) {
    const r = deriveReadiness(
      [machine("linux", { last_seen })],
      "agent://linux",
      observation([node("linux")]),
      true,
      at,
    );
    assert.equal(r.counts.connected, 0);
    assert.equal(r.status, "blocked");
  }
});
test("automatic placement finds a matching build pair instead of failing on the first CPU", () => {
  const inventory = [
    node("arm", "arm64", ["compute"]),
    node("x86", "amd64", ["compute"]),
    node("builder", "amd64", ["builder"]),
  ];
  assert.equal(
    deploymentTargets(inventory, { architecture: "auto" }).target.ID,
    "x86",
  );
  assert.equal(
    deploymentTargets(inventory, { architecture: "arm64" }).target,
    undefined,
  );
  assert.equal(
    deploymentTargets(inventory, { architecture: "arm64" }, false).target.ID,
    "arm",
  );
  assert.equal(
    deploymentTargets(inventory, {
      placement: { kind: "machine", machine_id: "arm" },
    }).target,
    undefined,
  );
});
test("repository access remains a separate actionable blocker", () => {
  const r = deriveReadiness(
    [machine("linux")],
    "agent://linux",
    observation([node("linux")]),
    false,
    at,
  );
  assert.equal(r.counts.ready_to_run, 1);
  assert.equal(r.status, "blocked");
  assert.equal(r.blockers[0].action, "connect_github");
});
test("observation cannot resurrect a coordinator removed during I/O", async () => {
  let config = { nomad_url: "agent://linux" };
  const writes = [];
  const ctx = {
    store: {
      get: (c, id) => (c === "settings" ? config : machine(id)),
      put: (...v) => writes.push(v),
    },
    requestNomad: async () => {
      config = undefined;
      return [];
    },
    broadcast: () => {},
  };
  await observeReadiness(ctx);
  assert.equal(writes.length, 0);
});

test("agent loss of runtime cannot contradict a cached ready scheduler node", () => {
  const r = deriveReadiness(
    [machine("linux", { report: { docker: true, nomad: false } })],
    "agent://linux",
    observation([node("linux")]),
    true,
    at,
  );
  assert.equal(r.machines[0].state, "reporting_only");
  assert.equal(r.machines[0].can_run, false);
  assert.equal(r.status, "blocked");
});

test("service preflight rejects explicit placement before requesting GitHub credentials", async () => {
  const { servicePreflight } = await import("../src/preflight.ts");
  const rows = new Map();
  rows.set("settings:runtime", { nomad_url: "agent://linux" });
  rows.set("machines:linux", machine("linux"));
  rows.set("projects:project", {
    id: "project",
    repository: "owner/app",
    branch: "main",
  });
  const ctx = {
    workspaceId: "tenant",
    env: {
      DIRECTORY: {
        prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }) }),
      },
    },
    store: {
      get: (c, id) => rows.get(c + ":" + id),
      put: (c, id, v) => rows.set(c + ":" + id, v),
      list: (c) =>
        [...rows].filter(([key]) => key.startsWith(c + ":")).map(([, v]) => v),
    },
    requestNomad: async (_method, path) =>
      path === "/v1/nodes" ? [{ ID: "linux" }] : node("linux"),
    broadcast: () => {},
  };
  const r = await servicePreflight(ctx, {
    id: "service",
    project_id: "project",
    placement: { kind: "machine", machine_id: "another-machine" },
  });
  assert.equal(r.status, "blocked");
  assert.equal(r.blockers[0].code, "service_placement");
  assert.equal(r.service_id, "service");
});

test("offline coordinator blocks a cached-ready worker with an actionable recovery", () => {
  const r = deriveReadiness(
    [
      machine("linux", { last_seen: new Date(at - 60000).toISOString() }),
      machine("worker"),
    ],
    "agent://linux",
    observation([node("worker")]),
    true,
    at,
  );
  assert.equal(r.status, "blocked");
  assert.equal(r.counts.ready_to_run, 0);
  assert.equal(r.blockers[0].code, "runtime_unreachable");
  assert.equal(r.blockers[0].action, "check_machine");
});

test("webhook queue retains durable history instead of retrying interactive preflight forever", async () => {
  const { handleRuntime } = await import("../src/runtime.ts");
  const rows = new Map([
    ["services:s", { id: "s", project_id: "p", name: "web" }],
    ["projects:p", { id: "p", repository: "owner/repo" }],
  ]);
  const ctx = {
    userId: "system",
    store: {
      get: (c, id) => rows.get(c + ":" + id),
      put: (c, id, v) => rows.set(c + ":" + id, v),
      list: (c) =>
        [...rows].filter(([key]) => key.startsWith(c + ":")).map(([, v]) => v),
      transaction: (fn) => fn(),
    },
    schedule: async () => {},
    broadcast: () => {},
    event: () => {},
  };
  const response = await handleRuntime(
    new Request("http://local/api/services/s/deploy", {
      method: "POST",
      body: JSON.stringify({ commit_sha: "a".repeat(40) }),
    }),
    ctx,
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "queued");
  assert.equal(ctx.store.list("deployments").length, 1);
});

test("revoking a pending enrollment is scoped and cannot disconnect a consumed grant", async () => {
  const { handleFleet } = await import("../src/fleet.ts");
  const id = "00000000-0000-4000-8000-000000000001";
  let grant = { id, token_hash: "hash", used_at: null };
  let deletes = 0;
  const ctx = {
    userId: "owner",
    workspaceId: "tenant",
    store: {
      list: () => [grant],
      put: (_c, _id, v) => {
        grant = v;
      },
    },
    broadcast: () => {},
    env: {
      DIRECTORY: {
        prepare: () => ({
          bind: (hash, workspace) => {
            assert.equal(hash, "hash");
            assert.equal(workspace, "tenant");
            return {
              run: async () => {
                deletes++;
              },
            };
          },
        }),
      },
    },
  };
  const request = () =>
    new Request("http://local/api/enrollment-tokens/" + id, {
      method: "DELETE",
    });
  assert.equal((await handleFleet(request(), ctx)).status, 200);
  assert.ok(grant.revoked_at);
  assert.equal(deletes, 1);
  grant = { id, token_hash: "hash", used_at: new Date().toISOString() };
  await assert.rejects(
    () => handleFleet(request(), ctx),
    (e) => e.status === 409,
  );
  assert.equal(deletes, 1);
  await assert.rejects(
    () => handleFleet(request(), { ...ctx, store: { list: () => [] } }),
    (e) => e.status === 404,
  );
});

test("requested runtime setup waits without pretending ready, then exposes an overdue setup", () => {
  const initial = machine("new", {
    created_at: new Date(at).toISOString(),
    setup_intent: "runtime",
    report: { docker: true, nomad: false },
  });
  const r = deriveReadiness([initial], null, undefined, true, at);
  assert.equal(r.machines[0].state, "checking");
  assert.equal(r.status, "checking");
  assert.equal(r.counts.ready_to_run, 0);
  const overdue = deriveReadiness(
    [{ ...initial, created_at: new Date(at - 16 * 60000).toISOString() }],
    null,
    undefined,
    true,
    at,
  );
  assert.equal(overdue.machines[0].state, "needs_setup");
  assert.match(overdue.machines[0].reasons[0], /installer/);
  const stopped = deriveReadiness(
    [{ ...initial, last_seen: new Date(at - 60000).toISOString() }],
    null,
    undefined,
    true,
    at,
  );
  assert.equal(stopped.machines[0].state, "offline");
});
