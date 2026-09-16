import { fail, id, now, type Doc, type WorkspaceContext } from "../core";
import { sourceToken } from "../github";
import { registryCredentials, refreshServiceDomains } from "../integrations";
import {
  applicationJob,
  buildJob,
  fits,
  immutableImage,
  ready,
  redact,
} from "./jobs";
import {
  ACTIVE,
  allocations,
  code,
  endpoint,
  ensureJob,
  environment,
  get,
  healthy,
  logs,
  nodes,
  pending,
  publicDeployment,
  redactBuildLogs,
  safeError,
  save,
  secretValues,
  step,
  stopJob,
} from "./common";

export async function queueDeployment(
  ctx: WorkspaceContext,
  serviceId: string,
  input: Doc = {},
): Promise<Doc> {
  const service = get(ctx, "services", serviceId);
  const project = get(ctx, "projects", service.project_id);
  if (service.status === "deleting") fail(409, "Service is being removed");
  if (input.image) immutableImage(input.image);
  if (input.commit_sha && !/^[a-f0-9]{40}$/i.test(input.commit_sha))
    fail(400, "Invalid source commit");
  const deployment: Doc = {
    id: id(),
    service_id: serviceId,
    status: "queued",
    phase: "prepare",
    created_at: now(),
    step: "queued",
    commit_sha: input.commit_sha ?? null,
    image_digest: input.image ?? null,
    previous_deployment_id: service.current_deployment_id ?? null,
    rollback_of: input.rollback_of ?? null,
    service_snapshot: structuredClone(service),
    project_snapshot: structuredClone(project),
    steps: [],
  };
  ctx.store.transaction(() => {
    if (
      ctx.store
        .list("deployments")
        .some((d) => d.service_id === serviceId && ACTIVE.includes(d.status))
    )
      fail(409, "A deployment is already active for this service");
    step(ctx, deployment, "queued", "Deployment queued");
    save(ctx, "deployments", deployment);
  });
  await ctx.schedule(1);
  return publicDeployment(deployment);
}
/** Pull credentials are selected from trusted deployment provenance, never from an arbitrary image URL. */
export async function deploymentRegistry(
  ctx: WorkspaceContext,
  d: Doc,
): Promise<Doc> {
  if (!d.image_digest) return registryCredentials(ctx);
  const image = immutableImage(d.image_digest);
  const managedHost = new URL(ctx.env.PUBLIC_URL).host;
  const prefix = `${managedHost}/personal-cloud/${ctx.workspaceId}/${d.service_id}@`;
  if (image.startsWith(prefix)) return registryCredentials(ctx);
  const prior = d.rollback_of
    ? ctx.store.get("deployments", d.rollback_of)
    : undefined;
  if (
    !prior ||
    prior.service_id !== d.service_id ||
    !["healthy", "rolled_back"].includes(prior.status) ||
    prior.image_digest !== image
  )
    fail(
      400,
      "Choose an image from this workspace registry or an exact previously healthy rollback",
    );
  const origin =
    prior.imported_from === "self-hosted"
      ? prior
      : prior.legacy_image_origin
        ? ctx.store.get("deployments", prior.legacy_image_origin)
        : undefined;
  if (
    !origin ||
    origin.imported_from !== "self-hosted" ||
    origin.service_id !== d.service_id ||
    origin.image_digest !== image ||
    !["healthy", "rolled_back"].includes(origin.status)
  )
    fail(400, "Rollback has no verified imported image provenance");
  const stored = ctx.store.get("settings", "legacy-runtime");
  if (!stored?.encrypted)
    fail(409, "Legacy registry configuration is unavailable for this rollback");
  const legacy = JSON.parse(await ctx.open("legacy-runtime", stored.encrypted));
  let registry: URL;
  try {
    registry = new URL(legacy.registry_url);
  } catch {
    fail(409, "Legacy registry configuration is invalid");
  }
  const imageHost = image.slice(0, image.indexOf("/"));
  if (
    !["http:", "https:"].includes(registry.protocol) ||
    registry.username ||
    registry.password ||
    registry.search ||
    registry.hash ||
    registry.host !== imageHost
  )
    fail(400, "Rollback image does not belong to the imported registry");
  d.legacy_image_origin = origin.id;
  return {
    registry_url: registry.origin,
    registry_username:
      typeof legacy.registry_username === "string"
        ? legacy.registry_username
        : undefined,
    registry_password:
      typeof legacy.registry_password === "string"
        ? legacy.registry_password
        : undefined,
    allow_insecure_registry: legacy.allow_insecure_registry === true,
  };
}
async function prepare(ctx: WorkspaceContext, d: Doc): Promise<void> {
  const s = d.service_snapshot,
    p = d.project_snapshot,
    inventory = await nodes(ctx);
  const rollback = d.rollback_of
    ? ctx.store.get("deployments", d.rollback_of)
    : undefined;
  const architecture = rollback?.architecture ?? s.architecture;
  const target = inventory.find(
    (n) =>
      ready(n, "compute") &&
      fits(n, s.placement) &&
      (architecture === "auto" || architecture === n.Attributes?.["cpu.arch"]),
  );
  if (!target)
    fail(409, "No healthy compute machine matches placement and architecture");
  d.architecture = target.Attributes?.["cpu.arch"];
  d.datacenter = target.Datacenter ?? "dc1";
  d.job_id = `pc-deploy-${d.id}`;
  if (!["amd64", "arm64"].includes(d.architecture))
    fail(409, "Unsupported machine architecture");
  const registry = await deploymentRegistry(ctx, d);
  const cfg = { ...ctx.store.get<Doc>("settings", "runtime"), ...registry };
  d.config_encrypted = await ctx.seal(
    `deployment:${d.id}:config`,
    JSON.stringify(cfg),
  );
  if (d.image_digest) {
    d.phase = "app_prepare";
    d.status = "deploying";
    d.phase_started_at = now();
    return;
  }
  const builder = inventory.find(
    (n) => ready(n, "builder") && n.Attributes?.["cpu.arch"] === d.architecture,
  );
  if (!builder)
    fail(409, "No healthy builder matches the deployment architecture");
  d.builder_node_id = builder.ID;
  d.builder_datacenter = builder.Datacenter ?? "dc1";
  d.build_job_id = `pc-build-${d.id}`;
  const source = await sourceToken(ctx.env, ctx.workspaceId, p.repository);
  if (!d.commit_sha) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(p.repository))
      fail(400, "Invalid GitHub repository");
    const res = await fetch(
      `https://api.github.com/repos/${p.repository}/commits/${encodeURIComponent(p.branch ?? "main")}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${source}`,
          "User-Agent": "Personal-Cloud",
        },
      },
    );
    if (!res.ok) fail(409, "GitHub could not resolve the production branch");
    const commit = (await res.json()) as Doc;
    d.commit_sha = commit.sha;
  }
  if (!/^[a-f0-9]{40}$/i.test(d.commit_sha))
    fail(400, "GitHub returned an invalid source commit");
  const spec = buildJob(d, s, p, cfg, source);
  d.secrets_encrypted = await ctx.seal(
    `deployment:${d.id}:secrets`,
    JSON.stringify(spec.Job.TaskGroups[0].Tasks[0].Env),
  );
  d.job_encrypted = await ctx.seal(
    `deployment:${d.id}:job`,
    JSON.stringify(spec),
  );
  d.phase = "build_submit";
  d.status = "building";
  d.phase_started_at = now();
  step(ctx, d, "clone", "Scheduling source build on a builder machine");
}
async function build(ctx: WorkspaceContext, d: Doc): Promise<void> {
  const list = await allocations(ctx, d.build_job_id),
    allocation = list.find((a) => a.DesiredStatus !== "stop");
  if (!allocation) return;
  let stdout = "",
    stderr = "";
  try {
    stdout = await logs(ctx, allocation.ID, "build", "stdout");
    stderr = await logs(ctx, allocation.ID, "build", "stderr");
  } catch (error) {
    if (pending(error)) throw error;
  }
  await redactBuildLogs(ctx, d, stdout, stderr);
  if (["failed", "lost"].includes(allocation.ClientStatus))
    fail(409, "Application build failed; inspect deployment logs");
  if (allocation.ClientStatus !== "complete") return;
  const image = stdout
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("PC_IMAGE="))
    ?.slice(9)
    .trim();
  immutableImage(image);
  const cfg = JSON.parse(
    await ctx.open(`deployment:${d.id}:config`, d.config_encrypted),
  );
  const expected = `${new URL(cfg.registry_url).host}/${cfg.repository_prefix ?? `personal-cloud/${ctx.workspaceId}`}/${d.service_id}@`;
  if (!image?.startsWith(expected))
    fail(409, "Builder returned an unexpected image repository");
  d.image_digest = image;
  d.phase = "app_prepare";
  d.status = "deploying";
  d.phase_started_at = now();
  step(ctx, d, "upload", "Immutable image uploaded to registry");
}
async function prepareApplication(
  ctx: WorkspaceContext,
  d: Doc,
): Promise<void> {
  const cfg = JSON.parse(
      await ctx.open(`deployment:${d.id}:config`, d.config_encrypted),
    ),
    s = d.service_snapshot;
  const env = await environment(ctx, s.project_id, s.id);
  const spec = applicationJob(d, s, env, cfg);
  d.secrets_encrypted = await ctx.seal(
    `deployment:${d.id}:secrets`,
    JSON.stringify({ ...env, registry_password: cfg.registry_password }),
  );
  d.job_encrypted = await ctx.seal(
    `deployment:${d.id}:job`,
    JSON.stringify(spec),
  );
  d.phase = "app_submit";
  step(
    ctx,
    d,
    "schedule",
    "Scheduling the new version; previous version remains running",
  );
}
async function observeApplication(
  ctx: WorkspaceContext,
  d: Doc,
): Promise<void> {
  const allocation = await healthy(ctx, d.job_id, "app");
  if (!allocation) return;
  const address = await endpoint(ctx, d.job_id, allocation.ID);
  const node = await ctx.requestNomad("GET", `/v1/node/${allocation.NodeID}`),
    machine = node.Meta?.pc_machine_id;
  if (!machine || !ctx.store.get("machines", machine))
    fail(409, "Scheduler allocation belongs to an unknown machine");
  d.allocation_id = allocation.ID;
  d.machine_id = machine;
  d.address = `http://${address.Address.includes(":") ? `[${address.Address}]` : address.Address}:${address.Port}`;
  d.phase = "routing";
  step(ctx, d, "health", "Health check passed; switching service routing");
  const s = get(ctx, "services", d.service_id);
  s.promotion_deployment_id = d.id;
  s.promotion_address = d.address;
  save(ctx, "services", s);
}
async function promote(ctx: WorkspaceContext, d: Doc): Promise<void> {
  await refreshServiceDomains(ctx, d.service_id);
  // Service and deployment current pointers change in one durable transaction after observed routing.
  ctx.store.transaction(() => {
    const s = get(ctx, "services", d.service_id);
    if (s.promotion_deployment_id !== d.id)
      fail(409, "Deployment no longer owns the service promotion");
    Object.assign(s, {
      current_deployment_id: d.id,
      address: d.address,
      machine_id: d.machine_id,
      image_digest: d.image_digest,
      status: "healthy",
      promotion_deployment_id: null,
      promotion_address: null,
      unhealthy_since: null,
    });
    Object.assign(d, {
      status: "healthy",
      phase: "cleanup",
      finished_at: now(),
      error: null,
    });
    step(ctx, d, "healthy", "Deployment successful");
    save(ctx, "services", s);
    save(ctx, "deployments", d);
    ctx.event("deployment.healthy", `${s.name} deployed successfully`);
  });
}
async function cleanup(ctx: WorkspaceContext, d: Doc): Promise<void> {
  // Only predecessors of this release are eligible. A retry of A's housekeeping
  // must never stop B after B has become current in the meantime.
  const predecessors: Doc[] = [];
  const seen = new Set<string>();
  let previousId = d.previous_deployment_id;
  while (previousId && !seen.has(previousId)) {
    seen.add(previousId);
    const previous = ctx.store.get("deployments", previousId);
    if (!previous) break;
    predecessors.push(previous);
    previousId = previous.previous_deployment_id;
  }
  for (const previous of predecessors) {
    const current = ctx.store.get("services", d.service_id);
    if (
      !current ||
      [current.current_deployment_id, current.promotion_deployment_id].includes(
        previous.id,
      ) ||
      !previous.job_id
    )
      continue;
    await stopJob(ctx, previous.job_id);
    previous.status = "rolled_back";
    save(ctx, "deployments", previous);
  }
  if (d.build_job_id) await stopJob(ctx, d.build_job_id);
  d.phase = "done";
  delete d.job_encrypted;
  // Keep the deployed environment encrypted for historical log redaction after variables rotate.
  delete d.config_encrypted;
  delete d.log_seen;
}
async function failDeployment(
  ctx: WorkspaceContext,
  d: Doc,
  error: unknown,
): Promise<void> {
  d.error = safeError(error);
  d.phase = "failure_cleanup";
  d.status = "deploying";
  step(ctx, d, "error", d.error);
  save(ctx, "deployments", d);
}
async function cleanupFailure(ctx: WorkspaceContext, d: Doc): Promise<void> {
  const s = get(ctx, "services", d.service_id);
  if (s.current_deployment_id === d.id) {
    d.status = "healthy";
    d.phase = "cleanup";
    return;
  }
  if (s.promotion_deployment_id === d.id) {
    s.promotion_deployment_id = null;
    s.promotion_address = null;
    save(ctx, "services", s);
    // Keep failed candidate alive until the previous route has actually been restored.
    await refreshServiceDomains(ctx, s.id);
  } else if (
    d.address &&
    ctx.store.list("domains").some((domain) => domain.service_id === s.id)
  )
    await refreshServiceDomains(ctx, s.id);
  if (d.job_id) await stopJob(ctx, d.job_id);
  if (d.build_job_id) await stopJob(ctx, d.build_job_id);
  d.status = "failed";
  d.phase = "done";
  d.finished_at = now();
  delete d.job_encrypted;
  delete d.secrets_encrypted;
  delete d.config_encrypted;
  if (!s.current_deployment_id) {
    s.status = "failed";
    save(ctx, "services", s);
  }
  ctx.event("deployment.failed", `${s.name}: ${d.error}`);
}
export async function reconcileDeployment(
  ctx: WorkspaceContext,
  d: Doc,
): Promise<void> {
  if (d.phase === "done") return;
  try {
    if (
      ACTIVE.includes(d.status) &&
      d.phase !== "failure_cleanup" &&
      Date.now() - Date.parse(d.phase_started_at ?? d.created_at) >
        (d.status === "building" ? 1200000 : 300000)
    )
      fail(
        409,
        d.status === "building"
          ? "Build exceeded the 20-minute deadline"
          : "Deployment health deadline exceeded; previous version retained",
      );
    switch (d.phase) {
      case "prepare":
        await prepare(ctx, d);
        break;
      case "build_submit":
        await ensureJob(
          ctx,
          JSON.parse(await ctx.open(`deployment:${d.id}:job`, d.job_encrypted)),
        );
        d.phase = "building";
        break;
      case "building":
        await build(ctx, d);
        break;
      case "app_prepare":
        await prepareApplication(ctx, d);
        break;
      case "app_submit":
        await ensureJob(
          ctx,
          JSON.parse(await ctx.open(`deployment:${d.id}:job`, d.job_encrypted)),
        );
        d.phase = "observing";
        break;
      case "observing":
        await observeApplication(ctx, d);
        break;
      case "routing":
        await promote(ctx, d);
        break;
      case "cleanup":
        await cleanup(ctx, d);
        break;
      case "failure_cleanup":
        await cleanupFailure(ctx, d);
        break;
    }
    if (!ctx.store.get("deployments", d.id)) return;
    save(ctx, "deployments", d);
  } catch (error) {
    if (pending(error) || !ctx.store.get("deployments", d.id)) return;
    if (["cleanup", "failure_cleanup"].includes(d.phase)) {
      d.cleanup_error = safeError(error);
      save(ctx, "deployments", d);
      return;
    }
    if (
      code(error) >= 500 &&
      Date.now() - Date.parse(d.phase_started_at ?? d.created_at) < 1200000
    ) {
      d.last_runtime_error = safeError(error);
      save(ctx, "deployments", d);
      return;
    }
    await failDeployment(ctx, d, error);
  }
}
export async function observeService(
  ctx: WorkspaceContext,
  s: Doc,
): Promise<Doc> {
  const d = get(ctx, "deployments", s.current_deployment_id ?? "");
  if (!d.allocation_id) fail(409, "No running deployment");
  const env = await environment(ctx, s.project_id, s.id, false),
    lines: Doc[] = [];
  const redactions = [...Object.values(env), ...(await secretValues(ctx, d))];
  for (const stream of ["stdout", "stderr"]) {
    const output = await logs(ctx, d.allocation_id, "app", stream);
    for (const line of output.split("\n").filter(Boolean))
      lines.push({ stream, message: redact(line, redactions) });
  }
  const metrics = await ctx.requestNomad(
    "GET",
    `/v1/client/allocation/${d.allocation_id}/stats`,
  );
  if (d.machine_id) {
    try {
      metrics.Network = await ctx.requestNomad(
        "GET",
        `/v1/personal-cloud/allocation/${d.allocation_id}/network`,
        undefined,
        d.machine_id,
      );
    } catch (error) {
      if (pending(error)) throw error;
    }
  }
  const allocation = await ctx.requestNomad(
    "GET",
    `/v1/allocation/${d.allocation_id}`,
  );
  return {
    type: "observability",
    allocation_id: d.allocation_id,
    lines,
    metrics,
    restarts: allocation.TaskStates?.app?.Restarts ?? 0,
    at: now(),
  };
}
export async function reconcileServiceHealth(
  ctx: WorkspaceContext,
  s: Doc,
): Promise<void> {
  if (!s.current_deployment_id || s.status === "deleting") return;
  if (s.promotion_deployment_id) {
    if (s.promotion_deployment_id !== s.current_deployment_id) return;
    await refreshServiceDomains(ctx, s.id);
    s.address = s.promotion_address;
    s.promotion_deployment_id = null;
    s.promotion_address = null;
    save(ctx, "services", s);
  }
  const d = get(ctx, "deployments", s.current_deployment_id),
    allocation = await healthy(ctx, d.job_id, "app");
  if (!allocation) {
    const current = ctx.store.get("services", s.id);
    if (
      !current ||
      current.status === "deleting" ||
      current.current_deployment_id !== d.id
    )
      return;
    current.status = "degraded";
    current.unhealthy_since ??= now();
    save(ctx, "services", current);
    if (
      !d.rollback_of &&
      Date.now() - Date.parse(current.unhealthy_since) > 45000
    ) {
      const running = (await allocations(ctx, d.job_id)).some(
        (a) => a.ClientStatus === "running" && a.DesiredStatus !== "stop",
      );
      const prior = ctx.store.get(
        "deployments",
        d.previous_deployment_id ?? "",
      );
      if (
        running &&
        prior?.image_digest &&
        ["healthy", "rolled_back"].includes(prior.status) &&
        !ctx.store
          .list("deployments")
          .some((v) => v.service_id === s.id && ACTIVE.includes(v.status))
      ) {
        const queued = await queueDeployment(ctx, s.id, {
          image: prior.image_digest,
          commit_sha: prior.commit_sha,
          rollback_of: prior.id,
        });
        const rollback = get(ctx, "deployments", queued.id);
        step(
          ctx,
          rollback,
          "rollback",
          "Current release failed health checks; restoring the previous immutable image",
        );
        save(ctx, "deployments", rollback);
      }
    }
    return;
  }
  const svc = await endpoint(ctx, d.job_id, allocation.ID),
    address = `http://${svc.Address.includes(":") ? `[${svc.Address}]` : svc.Address}:${svc.Port}`;
  if (address !== s.address) {
    const latest = ctx.store.get("services", s.id);
    if (
      !latest ||
      latest.status === "deleting" ||
      latest.current_deployment_id !== d.id ||
      latest.promotion_deployment_id
    )
      return;
    Object.assign(s, latest);
    s.promotion_deployment_id = d.id;
    s.promotion_address = address;
    save(ctx, "services", s);
    await refreshServiceDomains(ctx, s.id);
    s.promotion_deployment_id = null;
    s.promotion_address = null;
    s.address = address;
    const node = await ctx.requestNomad("GET", `/v1/node/${allocation.NodeID}`);
    s.machine_id = node.Meta?.pc_machine_id ?? null;
  }
  d.allocation_id = allocation.ID;
  d.machine_id = s.machine_id;
  save(ctx, "deployments", d);
  const current = ctx.store.get("services", s.id);
  if (
    !current ||
    current.status === "deleting" ||
    current.current_deployment_id !== d.id
  )
    return;
  Object.assign(current, {
    address: s.address,
    machine_id: s.machine_id,
    status: "healthy",
    unhealthy_since: null,
    promotion_deployment_id: null,
    promotion_address: null,
  });
  save(ctx, "services", current);
}
