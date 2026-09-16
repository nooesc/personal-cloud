import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationJob,
  buildJob,
  databaseJob,
  databaseProbe,
  immutableImage,
  placement,
  privateAddress,
  redact,
  validateService,
} from "./jobs.ts";
import {
  stopJob,
  publicDatabase,
  publicDeployment,
  environment,
} from "./common.ts";

function store() {
  const rows = new Map();
  return {
    get: (c, id) => structuredClone(rows.get(`${c}:${id}`)),
    put: (c, id, value) => rows.set(`${c}:${id}`, structuredClone(value)),
    delete: (c, id) => rows.delete(`${c}:${id}`),
    list: (c) =>
      [...rows]
        .filter(([key]) => key.startsWith(`${c}:`))
        .map(([, v]) => structuredClone(v)),
    transaction: (fn) => fn(),
  };
}
const digest = `registry.example/personal-cloud/tenant/service@sha256:${"a".repeat(64)}`;
test("only immutable images and safe service root/placement are accepted", () => {
  assert.equal(immutableImage(digest), digest);
  assert.throws(() => immutableImage("registry/app:latest"));
  assert.throws(() => validateService({ root_directory: "../../etc" }));
  assert.throws(() => validateService({ port: 0 }));
  assert.throws(() =>
    placement({ kind: "machine", machine_id: "other/../../fleet" }),
  );
  assert.equal(
    validateService({ root_directory: "apps/site", health_path: "/health" })
      .port,
    3000,
  );
});
test("application jobs preserve architecture, explicit placement and health readiness", () => {
  const service = {
    id: "service",
    ...validateService({
      port: 8080,
      placement: {
        kind: "machine",
        machine_id: "00000000-0000-4000-8000-000000000001",
      },
      health_path: "/ready",
    }),
  };
  const spec = applicationJob(
    { job_id: "candidate", architecture: "arm64", image_digest: digest },
    service,
    { SECRET: "secret" },
    {
      registry_url: "https://registry.example",
      registry_username: "tenant",
      registry_password: "password",
    },
  ).Job;
  assert.deepEqual(
    spec.Constraints.map((c) => c.RTarget),
    ["arm64", "true", service.placement.machine_id],
  );
  assert.equal(
    spec.TaskGroups[0].Tasks[0].Services[0].Checks[0].Path,
    "/ready",
  );
  assert.equal(spec.TaskGroups[0].Tasks[0].Env.PORT, "8080");
  assert.equal(spec.TaskGroups[0].Tasks[0].Config.auth.username, "tenant");
});
test("build jobs use the tenant registry prefix and immutable source revision", () => {
  const spec = buildJob(
    {
      id: "deploy",
      build_job_id: "build",
      commit_sha: "b".repeat(40),
      architecture: "amd64",
      builder_node_id: "node",
    },
    { id: "service", root_directory: "." },
    { repository: "owner/repo" },
    {
      registry_url: "https://registry.example",
      repository_prefix: "personal-cloud/tenant",
    },
    "source-secret",
  ).Job;
  assert.equal(
    spec.TaskGroups[0].Tasks[0].Env.PC_IMAGE_TAG,
    "registry.example/personal-cloud/tenant/service:deploy",
  );
  assert.equal(
    spec.TaskGroups[0].Tasks[0].Env.PC_SOURCE_TOKEN,
    "source-secret",
  );
  assert.equal(spec.Constraints[2].RTarget, "node");
  assert.equal(spec.TaskGroups[0].ReschedulePolicy.Unlimited, false);
});
test("database jobs pin original node, machine and named volume with no automatic replacement", () => {
  const db = {
    id: "db",
    job_id: "pc-db-db",
    machine_id: "machine",
    nomad_node_id: "node",
    volume_name: "persistent",
    port: 24500,
    probe_job_id: "probe",
  };
  const uri = "postgresql://pc:secret@10.77.0.2:24500/app?sslmode=disable";
  const spec = databaseJob(db, uri).Job,
    group = spec.TaskGroups[0];
  assert.deepEqual(
    spec.Constraints.map((c) => c.RTarget),
    ["node", "machine", "true"],
  );
  assert.equal(group.Disconnect.Replace, false);
  assert.equal(group.ReschedulePolicy.Unlimited, false);
  assert.deepEqual(group.Tasks[0].Config.volumes, [
    "persistent:/var/lib/postgresql/data",
  ]);
  assert.equal(group.Networks[0].ReservedPorts[0].Value, 24500);
  const probe = databaseProbe(db, uri).Job.TaskGroups[0].Tasks[0];
  assert.equal(probe.Config.command, "psql");
  assert.equal(probe.Env.PGPASSWORD, "secret");
});
test("database endpoint publication rejects public addresses", () => {
  for (const ip of [
    "10.77.0.2",
    "192.168.1.4",
    "172.16.1.2",
    "127.0.0.1",
    "fd00::4",
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ["1.1.1.1", "172.15.0.1", "10.400.0.1", "example.com"])
    assert.equal(privateAddress(ip), false, ip);
});
test("public snapshots omit encrypted runtime secrets and redact longest values first", () => {
  assert.deepEqual(
    publicDeployment({
      id: "d",
      job_encrypted: "x",
      secrets_encrypted: "x",
      config_encrypted: "x",
      log_seen: [],
      service_snapshot: {},
      project_snapshot: {},
    }),
    { id: "d" },
  );
  assert.deepEqual(
    publicDatabase({ id: "db", connection_encrypted: "x", job_encrypted: "x" }),
    { id: "db" },
  );
  assert.equal(
    redact("url postgresql://secret@db secret", [
      "secret",
      "postgresql://secret@db",
    ]),
    "url [redacted] [redacted]",
  );
});
test("job removal waits for captured allocations to stop after registration is purged", async () => {
  const rows = store();
  let running = true,
    deleted = false;
  const ctx = {
    store: rows,
    requestNomad: async (method, path) => {
      if (method === "DELETE") {
        deleted = true;
        return {};
      }
      if (path.endsWith("/allocations")) {
        assert.equal(deleted, false);
        return [{ ID: "allocation", ClientStatus: "running" }];
      }
      assert.equal(path, "/v1/allocation/allocation");
      return { ClientStatus: running ? "running" : "complete" };
    },
  };
  await assert.rejects(stopJob(ctx, "job"), (e) => e.pending === true);
  assert.equal(rows.get("runtime_stops", "job").phase, "observe");
  running = false;
  await stopJob(ctx, "job");
  assert.equal(rows.get("runtime_stops", "job").phase, "done");
});
test("degraded database credentials remain available for redaction but block new deployment", async () => {
  const rows = store();
  rows.put("bindings", "service", { database_id: "db" });
  rows.put("databases", "db", {
    id: "db",
    status: "degraded",
    connection_encrypted: "encrypted",
  });
  const ctx = { store: rows, open: async () => "postgresql://secret@database" };
  await assert.rejects(environment(ctx, "project", "service"), /not healthy/);
  assert.equal(
    (await environment(ctx, "project", "service", false)).DATABASE_URL,
    "postgresql://secret@database",
  );
});

const { queueDeployment, reconcileDeployment } = await import("./deploy.ts");
function deploymentFixture() {
  const rows = store(),
    jobs = new Map(),
    calls = [];
  const node = {
    ID: "node",
    Status: "ready",
    SchedulingEligibility: "eligible",
    Meta: { pc_compute: "true", pc_machine_id: "machine" },
    Attributes: { "cpu.arch": "amd64" },
    Drivers: { docker: { Healthy: true } },
  };
  rows.put("machines", "machine", { id: "machine" });
  rows.put("projects", "project", {
    id: "project",
    repository: "owner/repo",
    branch: "main",
  });
  rows.put("services", "service", {
    id: "service",
    project_id: "project",
    name: "App",
    status: "healthy",
    current_deployment_id: "old",
    address: "http://10.77.0.2:8000",
    ...validateService({}),
  });
  rows.put("deployments", "old", {
    id: "old",
    service_id: "service",
    status: "healthy",
    phase: "done",
    image_digest: digest,
    job_id: "old-job",
  });
  const ctx = {
    store: rows,
    env: { PUBLIC_URL: "https://registry.example" },
    workspaceId: "tenant",
    seal: async (_purpose, value) => value,
    open: async (_purpose, value) => value,
    schedule: async () => {},
    broadcast: () => {},
    event: () => {},
    requestNomad: async (method, path, value) => {
      calls.push([method, path]);
      if (path === "/v1/nodes") return [{ ID: "node" }];
      if (path === "/v1/node/node") return node;
      if (method === "POST" && path === "/v1/jobs") {
        jobs.set(value.Job.ID, value.Job);
        return { EvalID: "evaluation" };
      }
      if (method === "GET" && path.endsWith("/allocations"))
        return path.includes("old-job")
          ? []
          : [
              {
                ID: "candidate-allocation",
                NodeID: "node",
                ClientStatus: "running",
                DesiredStatus: "run",
              },
            ];
      if (method === "GET" && path === "/v1/allocation/candidate-allocation")
        return {
          ID: "candidate-allocation",
          NodeID: "node",
          ClientStatus: "running",
          TaskStates: { app: { State: "running" } },
        };
      if (path.endsWith("/checks")) return { ready: { Status: "success" } };
      if (path.endsWith("/services"))
        return [
          { AllocID: "candidate-allocation", Address: "10.77.0.2", Port: 9000 },
        ];
      if (method === "DELETE") {
        jobs.delete(path.split("/")[3].split("?")[0]);
        return {};
      }
      if (method === "GET" && path.startsWith("/v1/job/")) {
        const job = jobs.get(path.split("/")[3]);
        if (job) return job;
        throw Object.assign(new Error("Not found"), { status: 404 });
      }
      throw new Error(`Unexpected call ${method} ${path}`);
    },
  };
  return { ctx, rows, jobs, calls };
}
test("durable immutable deployment retains old current until observed health then atomically promotes", async () => {
  const { ctx, rows, calls } = deploymentFixture();
  const queued = await queueDeployment(ctx, "service", { image: digest });
  await assert.rejects(
    queueDeployment(ctx, "service", { image: digest }),
    /already active/,
  );
  for (const expected of [
    "app_prepare",
    "app_submit",
    "observing",
    "routing",
  ]) {
    await reconcileDeployment(ctx, rows.get("deployments", queued.id));
    assert.equal(rows.get("deployments", queued.id).phase, expected);
    assert.equal(rows.get("services", "service").current_deployment_id, "old");
  }
  await reconcileDeployment(ctx, rows.get("deployments", queued.id));
  assert.equal(
    rows.get("services", "service").current_deployment_id,
    queued.id,
  );
  assert.equal(rows.get("deployments", queued.id).status, "healthy");
  assert.equal(
    rows.get("services", "service").address,
    "http://10.77.0.2:9000",
  );
  await reconcileDeployment(ctx, rows.get("deployments", queued.id));
  assert.equal(rows.get("deployments", queued.id).phase, "done");
  assert.equal(
    calls.filter(([method, path]) => method === "POST" && path === "/v1/jobs")
      .length,
    1,
  );
});
test("uncertain job submission reconciles existing deterministic job rather than submit twice", async () => {
  const { ctx, rows, calls } = deploymentFixture(),
    original = ctx.requestNomad;
  let uncertain = true;
  ctx.requestNomad = async (...args) => {
    const result = await original(...args);
    if (args[0] === "POST" && args[1] === "/v1/jobs" && uncertain) {
      uncertain = false;
      throw Object.assign(new Error("Relay response interrupted"), {
        pending: true,
      });
    }
    return result;
  };
  const queued = await queueDeployment(ctx, "service", { image: digest });
  for (let i = 0; i < 3; i++)
    await reconcileDeployment(ctx, rows.get("deployments", queued.id));
  assert.equal(rows.get("deployments", queued.id).phase, "app_submit");
  await reconcileDeployment(ctx, rows.get("deployments", queued.id));
  assert.equal(rows.get("deployments", queued.id).phase, "observing");
  assert.equal(
    calls.filter(([method, path]) => method === "POST" && path === "/v1/jobs")
      .length,
    1,
  );
});
test("candidate health timeout cannot replace previous healthy current", async () => {
  const { ctx, rows } = deploymentFixture(),
    queued = await queueDeployment(ctx, "service", { image: digest });
  const d = rows.get("deployments", queued.id);
  Object.assign(d, {
    phase: "observing",
    status: "deploying",
    phase_started_at: new Date(Date.now() - 400000).toISOString(),
    job_id: "candidate",
  });
  rows.put("deployments", d.id, d);
  await reconcileDeployment(ctx, d);
  assert.equal(rows.get("services", "service").current_deployment_id, "old");
  assert.equal(rows.get("deployments", d.id).phase, "failure_cleanup");
});
test("late predecessor cleanup never stops a newer current release", async () => {
  const { ctx, rows, calls } = deploymentFixture();
  rows.put("deployments", "A", {
    id: "A",
    service_id: "service",
    status: "healthy",
    phase: "cleanup",
    previous_deployment_id: "old",
    job_id: "job-A",
  });
  rows.put("deployments", "B", {
    id: "B",
    service_id: "service",
    status: "healthy",
    phase: "done",
    previous_deployment_id: "A",
    job_id: "job-B",
  });
  rows.put("services", "service", {
    ...rows.get("services", "service"),
    current_deployment_id: "B",
  });
  await reconcileDeployment(ctx, rows.get("deployments", "A"));
  assert.equal(rows.get("deployments", "A").phase, "done");
  assert.equal(rows.get("services", "service").current_deployment_id, "B");
  assert.equal(
    calls.some(
      ([method, path]) => method === "DELETE" && path.includes("job-B"),
    ),
    false,
  );
});
const { reconcileServiceHealth } = await import("./deploy.ts");
test("only a running unhealthy release triggers immutable automatic rollback", async () => {
  for (const running of [true, false]) {
    const { ctx, rows } = deploymentFixture(),
      original = ctx.requestNomad;
    rows.put("services", "service", {
      ...rows.get("services", "service"),
      current_deployment_id: "current",
      unhealthy_since: new Date(Date.now() - 60000).toISOString(),
    });
    rows.put("deployments", "current", {
      id: "current",
      service_id: "service",
      status: "healthy",
      phase: "done",
      previous_deployment_id: "old",
      job_id: "current-job",
    });
    ctx.requestNomad = async (method, path, value) => {
      if (path.endsWith("/checks")) return { ready: { Status: "failure" } };
      if (path === "/v1/job/current-job/allocations")
        return [
          {
            ID: "candidate-allocation",
            ClientStatus: running ? "running" : "lost",
            DesiredStatus: "run",
          },
        ];
      return original(method, path, value);
    };
    await reconcileServiceHealth(ctx, rows.get("services", "service"));
    assert.equal(
      rows.list("deployments").filter((d) => d.status === "queued").length,
      running ? 1 : 0,
    );
    if (running)
      assert.equal(
        rows.list("deployments").find((d) => d.status === "queued").rollback_of,
        "old",
      );
    assert.equal(
      rows.get("services", "service").current_deployment_id,
      "current",
    );
  }
});
const { observeService } = await import("./deploy.ts");
test("running allocation logs redact the deployed secret snapshot after project secrets rotate", async () => {
  const { ctx, rows } = deploymentFixture(),
    original = ctx.requestNomad;
  rows.put("environment", "project:SECRET", {
    project_id: "project",
    key: "SECRET",
    value_encrypted: "new-secret",
  });
  rows.put("deployments", "old", {
    ...rows.get("deployments", "old"),
    allocation_id: "candidate-allocation",
    secrets_encrypted: JSON.stringify({ SECRET: "old-secret" }),
  });
  ctx.requestNomad = async (method, path, value) => {
    if (path.startsWith("/v1/client/fs/logs/"))
      return { raw: "old-secret new-secret" };
    if (path.endsWith("/stats")) return {};
    return original(method, path, value);
  };
  const result = await observeService(ctx, rows.get("services", "service"));
  assert.deepEqual(
    result.lines.map((line) => line.message),
    ["[redacted] [redacted]", "[redacted] [redacted]"],
  );
});
const { deploymentRegistry } = await import("./deploy.ts");
function legacyFixture() {
  const fixture = deploymentFixture();
  fixture.rows.put("settings", "legacy-runtime", {
    encrypted: JSON.stringify({
      registry_url: "http://10.77.0.2:5000",
      registry_username: "legacy",
      registry_password: "old-pull-secret",
      allow_insecure_registry: true,
    }),
  });
  const image = `10.77.0.2:5000/personal-cloud/service@sha256:${"c".repeat(64)}`;
  fixture.rows.put("deployments", "imported", {
    id: "imported",
    service_id: "service",
    status: "healthy",
    phase: "done",
    imported_from: "self-hosted",
    architecture: "amd64",
    image_digest: image,
  });
  return { ...fixture, image };
}
test("exact imported immutable rollback uses only matching legacy registry credentials", async () => {
  const { ctx, rows, image } = legacyFixture(),
    d = { service_id: "service", image_digest: image, rollback_of: "imported" };
  const config = await deploymentRegistry(ctx, d);
  assert.equal(config.registry_password, "old-pull-secret");
  assert.equal(config.registry_url, "http://10.77.0.2:5000");
  assert.equal(d.legacy_image_origin, "imported");
  assert.equal(
    rows.get("settings", "registry-credential"),
    undefined,
    "legacy rollback never issues a managed credential",
  );
  const queued = await queueDeployment(ctx, "service", {
    image,
    rollback_of: "imported",
  });
  await reconcileDeployment(ctx, rows.get("deployments", queued.id));
  await reconcileDeployment(ctx, rows.get("deployments", queued.id));
  const result = rows.get("deployments", queued.id);
  assert.equal(result.phase, "app_submit");
  assert.equal(result.architecture, "amd64");
  assert.equal(
    JSON.parse(result.job_encrypted).Job.TaskGroups[0].Tasks[0].Config.auth
      .password,
    "old-pull-secret",
  );
});
test("legacy pull secret cannot follow an arbitrary image host, altered digest, or nonimported history", async () => {
  const { ctx, rows, image } = legacyFixture();
  await assert.rejects(
    deploymentRegistry(ctx, { service_id: "service", image_digest: image }),
    /previously healthy rollback/,
  );
  await assert.rejects(
    deploymentRegistry(ctx, {
      service_id: "service",
      image_digest: image.replace("c".repeat(64), "d".repeat(64)),
      rollback_of: "imported",
    }),
    /previously healthy rollback/,
  );
  rows.put("deployments", "foreign", {
    id: "foreign",
    service_id: "other-service",
    status: "healthy",
    imported_from: "self-hosted",
    image_digest: image,
  });
  await assert.rejects(
    deploymentRegistry(ctx, {
      service_id: "service",
      image_digest: image,
      rollback_of: "foreign",
    }),
    /previously healthy rollback/,
  );
  rows.put("deployments", "unknown", {
    id: "unknown",
    service_id: "service",
    status: "healthy",
    image_digest: image,
  });
  await assert.rejects(
    deploymentRegistry(ctx, {
      service_id: "service",
      image_digest: image,
      rollback_of: "unknown",
    }),
    /imported image provenance/,
  );
  const evil = image.replace("10.77.0.2:5000", "evil.example");
  rows.put("deployments", "tampered", {
    id: "tampered",
    service_id: "service",
    status: "healthy",
    imported_from: "self-hosted",
    image_digest: evil,
  });
  await assert.rejects(
    deploymentRegistry(ctx, {
      service_id: "service",
      image_digest: evil,
      rollback_of: "tampered",
    }),
    /imported registry/,
  );
  const spec = applicationJob(
    { job_id: "evil", architecture: "amd64", image_digest: evil },
    { id: "service", ...validateService({}) },
    {},
    {
      registry_url: "http://10.77.0.2:5000",
      registry_username: "legacy",
      registry_password: "old-pull-secret",
    },
  );
  assert.equal(spec.Job.TaskGroups[0].Tasks[0].Config.auth, undefined);
});
test("new builds always choose managed storage despite imported legacy registry settings", async () => {
  const { ctx } = legacyFixture();
  const registry = await deploymentRegistry(ctx, { service_id: "service" });
  assert.equal(registry.registry_url, "https://registry.example");
  assert.equal(registry.repository_prefix, "personal-cloud/tenant");
  assert.notEqual(registry.registry_password, "old-pull-secret");
});
