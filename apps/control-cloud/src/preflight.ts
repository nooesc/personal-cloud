import { HttpError, type Doc, type WorkspaceContext } from "./core";
import { sourceToken } from "./github";
import { integrationStatus } from "./integrations";
import {
  observeReadiness,
  workspaceReadiness,
  deploymentTargets,
  type Blocker,
  type Observation,
} from "./readiness";

/** Read-only eligibility check. Repository tokens stay server-side and are never returned. */
export async function servicePreflight(
  ctx: WorkspaceContext,
  service: Doc,
): Promise<Doc> {
  const integrations = await integrationStatus(ctx);
  await observeReadiness(ctx);
  const readiness = workspaceReadiness(
    ctx,
    integrations.github.status === "connected",
  );
  const blockers: Blocker[] = [...readiness.blockers];
  const project = ctx.store.get("projects", service.project_id);
  if (readiness.status === "ready") {
    const observation = ctx.store.get<Observation>("observations", "readiness");
    const eligibleIds = new Set(
      readiness.machines
        .filter((m) => m.can_run || m.can_build)
        .map((m) => m.machine_id),
    );
    const pair = deploymentTargets(
      (observation?.nodes ?? []).filter((n) =>
        eligibleIds.has(n.Meta?.pc_machine_id),
      ),
      service,
    );
    if (!pair.target)
      blockers.push({
        code: pair.hasCompute ? "service_builder_missing" : "service_placement",
        message: pair.hasCompute
          ? "No ready builder matches this service's architecture."
          : "No ready machine matches this service's placement and architecture.",
        action: "check_machine",
      });
  }
  // Check selected repository, not just whether any installation exists. Avoid provider work
  // when infrastructure is already blocked; the UI will recheck after resolving prerequisites.
  if (blockers.length === 0 && project) {
    try {
      const token = await sourceToken(
        ctx.env,
        ctx.workspaceId,
        project.repository,
      );
      const response = await fetch(
        `https://api.github.com/repos/${project.repository}/commits/${encodeURIComponent(project.branch ?? "main")}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "dinghy",
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      await response.body?.cancel();
      if (!response.ok)
        blockers.push({
          code: "repository_branch",
          message:
            "The selected repository or branch is unavailable. Check repository access and the production branch.",
          action: "connect_github",
        });
    } catch (error) {
      const denied =
        error instanceof HttpError && [401, 403, 404].includes(error.status);
      blockers.push({
        code: denied ? "repository_access" : "github_unavailable",
        message: denied
          ? "Grant dinghy access to this repository before deploying."
          : "Repository access could not be checked. Try again.",
        action: denied ? "connect_github" : "retry",
      });
    }
  }
  return {
    ...readiness,
    status: blockers.length
      ? readiness.status === "checking"
        ? "checking"
        : "blocked"
      : "ready",
    blockers,
    service_id: service.id,
  };
}
