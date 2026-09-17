import { appleNode } from "./apple-nomad";
import { type Doc, type WorkspaceContext } from "./core";
import { nodes, pending } from "./runtime/common";
import { ready, fits } from "./runtime/jobs";

export const OBSERVATION_TTL = 30000;
export type Blocker = {
  code: string;
  message: string;
  action:
    | "connect_github"
    | "add_machine"
    | "configure_runtime"
    | "check_machine"
    | "retry";
};
export type Observation = {
  runtime: string | null;
  checked_at: string;
  status: "connected" | "checking" | "unreachable";
  nodes: Doc[];
};
export function connected(machine: Doc, at = Date.now()): boolean {
  const age = at - Date.parse(machine.last_seen);
  return Number.isFinite(age) && age >= -5000 && age < 45000;
}
/** Shared by preflight and actual placement: choose a compute/build pair, not the first mismatched CPU. */
export function deploymentTargets(
  inventory: Doc[],
  service: Doc,
  needsBuild = true,
) {
  const candidates = inventory.filter(
    (n) =>
      ready(n, "compute") &&
      fits(n, service.placement ?? { kind: "automatic" }) &&
      ["amd64", "arm64"].includes(n.Attributes?.["cpu.arch"]) &&
      (!service.architecture ||
        service.architecture === "auto" ||
        service.architecture === n.Attributes?.["cpu.arch"]),
  );
  for (const target of candidates) {
    const builder = inventory.find(
      (n) =>
        ready(n, "builder") &&
        n.Attributes?.["cpu.arch"] === target.Attributes?.["cpu.arch"],
    );
    if (!needsBuild || builder) return { target, builder, hasCompute: true };
  }
  return {
    target: undefined,
    builder: undefined,
    hasCompute: candidates.length > 0,
  };
}
export function deriveReadiness(
  machines: Doc[],
  runtime: string | null,
  observation: Observation | undefined,
  github: boolean,
  at = Date.now(),
) {
  const age = observation ? at - Date.parse(observation.checked_at) : Infinity;
  const fresh =
    observation?.runtime === runtime && age >= 0 && age < OBSERVATION_TTL;
  const coordinator = runtime?.startsWith("agent://")
    ? machines.find((m) => m.id === runtime.slice(8))
    : undefined;
  const coordinatorConnected = Boolean(
    coordinator && connected(coordinator, at),
  );
  const unreachable = Boolean(
    runtime &&
    (!coordinatorConnected || (fresh && observation?.status === "unreachable")),
  );
  const verified = Boolean(
    runtime &&
    coordinatorConnected &&
    fresh &&
    observation?.status === "connected",
  );
  const inventory = verified
    ? observation!.nodes.filter((n) =>
        machines.some(
          (m) =>
            m.id === n.Meta?.pc_machine_id &&
            connected(m, at) &&
            m.report?.nomad === true,
        ),
      )
    : [];
  const capabilities = machines.map((m) => {
    const contact = connected(m, at),
      node = inventory.find((n) => n.Meta?.pc_machine_id === m.id);
    const can_run = Boolean(node && ready(node, "compute")),
      can_build = Boolean(node && ready(node, "builder")),
      can_database = Boolean(node && ready(node, "database"));
    const awaitingRuntime =
      m.setup_intent === "runtime" && (!m.report?.docker || !m.report?.nomad);
    const setupAge = at - Date.parse(m.created_at);
    const setupWaiting =
      awaitingRuntime &&
      Number.isFinite(setupAge) &&
      setupAge >= 0 &&
      setupAge < 15 * 60000;
    const can_apple = Boolean(
      node &&
      appleNode(node) &&
      contact &&
      m.report?.apple?.enabled &&
      m.report.apple.xcode &&
      m.report.apple.simulators?.length,
    );
    const state = !contact
      ? "offline"
      : can_apple
        ? "apple_ready"
        : awaitingRuntime
          ? setupWaiting
            ? "checking"
            : "needs_setup"
          : !m.report?.docker || !m.report?.nomad
            ? "reporting_only"
            : !verified
              ? "checking"
              : can_run || can_build || can_database
                ? "ready"
                : "needs_setup";
    const reasons =
      contact && awaitingRuntime
        ? [
            setupWaiting
              ? "Waiting for runtime setup to finish on this machine."
              : "The runtime is unavailable. Check the installer output or agent logs on this machine.",
          ]
        : state === "offline"
          ? ["This machine has stopped checking in."]
          : state === "reporting_only"
            ? [
                "Connected for monitoring. Set up a supported Linux runtime to run applications.",
              ]
            : state === "checking"
              ? ["Deployment capabilities have not been verified yet."]
              : state === "needs_setup"
                ? [
                    "The runtime is not accepting workloads. Check machine setup and scheduling.",
                  ]
                : [];
    return {
      machine_id: m.id,
      state,
      can_run,
      can_build,
      can_database,
      can_apple,
      reasons,
    };
  });
  const blockers: Blocker[] = [];
  if (!github)
    blockers.push({
      code: "github_access",
      message: "Choose the GitHub repositories dinghy can deploy.",
      action: "connect_github",
    });
  if (
    !runtime &&
    capabilities.some(
      (c) =>
        c.state === "checking" &&
        machines.find((m) => m.id === c.machine_id)?.setup_intent === "runtime",
    )
  )
    blockers.push({
      code: "runtime_checking",
      message: "Waiting for your new server to finish runtime setup.",
      action: "check_machine",
    });
  else if (!runtime)
    blockers.push({
      code: "runtime_missing",
      message: "Connect a supported Linux server to run your applications.",
      action: "add_machine",
    });
  else if (!verified)
    blockers.push({
      code: unreachable ? "runtime_unreachable" : "runtime_checking",
      message: unreachable
        ? "Your fleet runtime could not be reached. Check the coordinating machine."
        : "Checking your fleet's deployment capabilities.",
      action: unreachable ? "check_machine" : "retry",
    });
  else {
    const pair = deploymentTargets(inventory, { architecture: "auto" });
    if (!pair.hasCompute)
      blockers.push({
        code: "compute_missing",
        message: "No connected machine is ready to run applications.",
        action: "check_machine",
      });
    else if (!pair.builder)
      blockers.push({
        code: "builder_missing",
        message:
          "Enable a builder matching your application machine's architecture.",
        action: "check_machine",
      });
  }
  return {
    status:
      blockers.length === 0
        ? ("ready" as const)
        : blockers.every((b) => b.code === "runtime_checking")
          ? ("checking" as const)
          : ("blocked" as const),
    checked_at: fresh ? observation!.checked_at : null,
    counts: {
      connected: machines.filter((m) => connected(m, at)).length,
      ready_to_run: capabilities.filter((m) => m.can_run).length,
      ready_to_build: capabilities.filter((m) => m.can_build).length,
    },
    blockers,
    machines: capabilities,
    recommended_roles: capabilities.some((m) => m.can_build)
      ? ["compute"]
      : ["compute", "builder"],
  };
}
export async function observeReadiness(ctx: WorkspaceContext): Promise<void> {
  const runtime = ctx.store.get("settings", "runtime")?.nomad_url ?? null;
  if (!runtime) return;
  let result: Observation;
  try {
    result = {
      runtime,
      status: "connected",
      nodes: await nodes(ctx),
      checked_at: new Date().toISOString(),
    };
  } catch (error) {
    result = {
      runtime,
      status: pending(error) ? "checking" : "unreachable",
      nodes: [],
      checked_at: new Date().toISOString(),
    };
  }
  // A removed/replaced coordinator must never resurrect a successful observation.
  if (ctx.store.get("settings", "runtime")?.nomad_url !== runtime) return;
  ctx.store.put("observations", "readiness", result);
  ctx.broadcast();
}
export function workspaceReadiness(ctx: WorkspaceContext, github: boolean) {
  return deriveReadiness(
    ctx.store.list("machines"),
    ctx.store.get("settings", "runtime")?.nomad_url ?? null,
    ctx.store.get<Observation>("observations", "readiness"),
    github,
  );
}
