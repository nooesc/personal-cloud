import {
  fail,
  id,
  now,
  requireUser,
  text,
  type Doc,
  type WorkspaceContext,
} from "./core";

const COLLECTION = "project_resources";
const REVISION = "project-organization";
const environments = new Set([
  "production",
  "development",
  "staging",
  "preview",
]);
export function organization(ctx: WorkspaceContext, account?: string | null) {
  return {
    revision: ctx.store.get("settings", REVISION)?.revision ?? "0",
    resources: ctx.store
      .list(COLLECTION)
      .filter((r) => !account || r.account_id === account),
  };
}
export function withOrganization(ctx: WorkspaceContext, overview: Doc) {
  const state = organization(ctx, overview.account_id);
  return {
    ...overview,
    organization: {
      ...state,
      // Disconnect must not expose a previously connected account as current inventory.
      resources: overview.account_id ? state.resources : [],
    },
  };
}

function bump(ctx: WorkspaceContext) {
  ctx.store.put("settings", REVISION, { revision: id() });
}
export function releaseProjectResources(
  ctx: WorkspaceContext,
  projectId: string,
) {
  const rows = ctx.store
    .list(COLLECTION)
    .filter((r) => r.project_id === projectId);
  for (const r of rows)
    ctx.store.put(COLLECTION, r.id, {
      ...r,
      project_id: null,
      updated_at: now(),
    });
  if (rows.length) bump(ctx);
}
export function repository(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const repo = text(value, 200)
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes(".."))
    fail(400, "Use a GitHub owner/repository");
  return repo;
}
export function createProject(ctx: WorkspaceContext, input: Doc) {
  requireUser(ctx);
  const project = {
    id: id(),
    name: text(input.name, 80),
    repository: repository(input.repository),
    branch: text(input.branch ?? "main", 200),
    created_at: now(),
  };
  if (
    ctx.store.list("projects").length >=
    Number(ctx.env.MAX_PROJECTS_PER_WORKSPACE)
  )
    fail(409, "Workspace project limit reached");
  ctx.store.put("projects", project.id, project);
  ctx.event("project.created", `${project.name} added to your cloud`);
  ctx.broadcast();
  return project;
}
export function updateProject(
  ctx: WorkspaceContext,
  projectId: string,
  input: Doc,
) {
  requireUser(ctx);
  const previous = ctx.store.get("projects", projectId);
  if (!previous) fail(404, "Project not found");
  if (previous.status === "deleting") fail(409, "Project is being removed");
  const next = {
    ...previous,
    ...(input.name !== undefined ? { name: text(input.name, 80) } : {}),
    ...(input.repository !== undefined
      ? { repository: repository(input.repository) }
      : {}),
    ...(input.branch !== undefined ? { branch: text(input.branch, 200) } : {}),
  };
  // Source changes on deployed services need a separate, explicit migration workflow.
  if (
    (next.repository !== previous.repository ||
      next.branch !== previous.branch) &&
    ctx.store.list("services").some((s) => s.project_id === projectId)
  )
    fail(
      409,
      "Repository and branch cannot be changed while the project has machine services",
    );
  ctx.store.put("projects", projectId, next);
  ctx.event("project.updated", `${next.name} updated`);
  ctx.broadcast();
  return next;
}

/** Only local workspace metadata changes. No provider calls; all validation precedes writes. */
export function organize(ctx: WorkspaceContext, input: Doc, overview: Doc) {
  requireUser(ctx);
  const state = organization(ctx);
  if (typeof input.revision !== "string" || input.revision !== state.revision)
    fail(409, "Project organization changed. Refresh and try again.");
  const account = text(input.account_id, 32).toLowerCase();
  if (
    !/^[a-f0-9]{32}$/.test(account) ||
    account !== overview.account_id?.toLowerCase()
  )
    fail(409, "Cloudflare account changed. Refresh and try again.");
  if (
    !Array.isArray(input.assignments) ||
    !input.assignments.length ||
    input.assignments.length > 1100
  )
    fail(400, "Choose between 1 and 1,100 resources");
  const projects = ctx.store.list("projects");
  const created: Doc[] = [],
    rows: Doc[] = [],
    seen = new Set<string>();
  const available = new Set([
    ...(overview.workers ?? []).map((w: Doc) => `worker:${w.name}`),
    ...(overview.pages ?? []).map((p: Doc) => `pages:${p.name}`),
  ]);
  for (const assignment of input.assignments) {
    if (
      !assignment ||
      typeof assignment !== "object" ||
      Array.isArray(assignment)
    )
      fail(400, "Invalid assignment");
    const { kind } = assignment,
      name = text(assignment.name, 200);
    if (kind !== "worker" && kind !== "pages")
      fail(400, "Invalid resource type");
    const resourceId = JSON.stringify([account, kind, name]);
    if (seen.has(resourceId)) fail(400, "Resource appears more than once");
    seen.add(resourceId);
    const environment = assignment.environment ?? "production";
    if (!environments.has(environment)) fail(400, "Invalid environment");
    if (
      assignment.ignored !== undefined &&
      typeof assignment.ignored !== "boolean"
    )
      fail(400, "Invalid ignore option");
    const ignored = assignment.ignored === true;
    const hasProject =
      assignment.project_id !== undefined && assignment.project_id !== null;
    const hasName =
      assignment.project_name !== undefined && assignment.project_name !== null;
    if (hasProject && hasName)
      fail(400, "Choose an existing project or a new project name");
    if (ignored && (hasProject || hasName))
      fail(400, "Ignored resources cannot belong to a project");
    const existing = ctx.store.get(COLLECTION, resourceId);
    // Allow releasing old links during provider failures, but never add invented resources.
    if (
      !available.has(`${kind}:${name}`) &&
      (!existing || hasProject || hasName)
    )
      fail(
        409,
        "Resource was not discovered in this account. Refresh Cloudflare and try again.",
      );
    let project: Doc | undefined;
    if (hasProject) {
      const projectId = text(assignment.project_id, 100);
      project = projects.find((p) => p.id === projectId);
      if (!project) fail(404, "Project not found in this workspace");
    } else if (hasName) {
      const projectName = text(assignment.project_name, 80);
      const matches = [...projects, ...created].filter(
        (p) => p.name.toLowerCase() === projectName.toLowerCase(),
      );
      if (matches.length > 1)
        fail(
          409,
          "Multiple projects have that name. Select the project instead.",
        );
      project = matches[0];
      if (!project) {
        project = {
          id: id(),
          name: projectName,
          repository: "",
          branch: "main",
          created_at: now(),
        };
        created.push(project);
      }
    }
    if (project?.status === "deleting") fail(409, "Project is being removed");
    rows.push({
      id: resourceId,
      account_id: account,
      kind,
      name,
      project_id: project?.id ?? null,
      environment,
      ignored,
      updated_at: now(),
    });
  }
  if (
    projects.length + created.length >
    Number(ctx.env.MAX_PROJECTS_PER_WORKSPACE)
  )
    fail(409, "Workspace project limit reached");
  ctx.store.transaction(() => {
    for (const project of created)
      ctx.store.put("projects", project.id, project);
    for (const row of rows) {
      // Preserve an explicit "leave unassigned" choice so later suggestions cannot undo it.
      ctx.store.put(COLLECTION, row.id, row);
    }
    bump(ctx);
    ctx.event(
      "projects.organized",
      `${rows.length} Cloudflare resource${rows.length === 1 ? "" : "s"} organized`,
    );
  });
  ctx.broadcast();
  return {
    projects: ctx.store.list("projects"),
    organization: organization(ctx, account),
  };
}
