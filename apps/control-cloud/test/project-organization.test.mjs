import { test } from "node:test";
import assert from "node:assert/strict";
import {
  organize,
  organization,
  createProject,
  updateProject,
  releaseProjectResources,
  withOrganization,
} from "../src/project-organization.ts";
const account = "a".repeat(32);
const inventory = {
  account_id: account,
  workers: [
    { name: "intake-api" },
    { name: "intake-api-dev" },
    { name: "site" },
  ],
  pages: [{ name: "site" }],
  status: "connected",
};
function context() {
  let data = new Map();
  return {
    userId: "owner",
    env: { MAX_PROJECTS_PER_WORKSPACE: "10" },
    broadcast() {},
    event() {},
    store: {
      get: (c, k) => data.get(c + ":" + k),
      put: (c, k, v) => data.set(c + ":" + k, structuredClone(v)),
      delete: (c, k) => data.delete(c + ":" + k),
      list: (c) =>
        [...data]
          .filter(([k]) => k.startsWith(c + ":"))
          .map(([, v]) => structuredClone(v)),
      transaction(fn) {
        const previous = structuredClone(data);
        try {
          return fn();
        } catch (e) {
          data = previous;
          throw e;
        }
      },
    },
  };
}
const assign = (name, more = {}) => ({
  kind: "worker",
  name,
  project_name: "Intake",
  environment: "production",
  ...more,
});
function save(ctx, assignments, extra = {}) {
  return organize(
    ctx,
    {
      account_id: account,
      revision: organization(ctx).revision,
      assignments,
      ...extra,
    },
    inventory,
  );
}
const rejects = (fn, status) => assert.throws(fn, (e) => e.status === status);
test("bulk import creates one project, preserves observed metrics, and persists environment links", () => {
  const ctx = context();
  const result = save(ctx, [
    assign("intake-api"),
    assign("intake-api-dev", {
      project_name: "intake",
      environment: "development",
    }),
  ]);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].repository, "");
  assert.equal(result.organization.resources.length, 2);
  assert.notEqual(result.organization.revision, "0");
  assert.equal(result.organization.resources[1].environment, "development");
  assert.equal(
    new Set(result.organization.resources.map((r) => r.project_id)).size,
    1,
  );
  assert.equal(withOrganization(ctx, inventory).workers, inventory.workers);
});
test("all-or-nothing validation prevents partial import and project creation", () => {
  const ctx = context();
  rejects(() => save(ctx, [assign("intake-api"), assign("invented")]), 409);
  assert.equal(ctx.store.list("projects").length, 0);
  assert.equal(organization(ctx).revision, "0");
  rejects(() => save(ctx, [assign("intake-api"), assign("intake-api")]), 400);
  assert.equal(ctx.store.list("project_resources").length, 0);
});
test("workspace identity, account identity, membership and revision guard every batch", () => {
  const a = context(),
    b = context();
  const result = save(a, [assign("intake-api")]);
  rejects(
    () =>
      save(b, [
        assign("intake-api", {
          project_name: undefined,
          project_id: result.projects[0].id,
        }),
      ]),
    404,
  );
  rejects(
    () => save(a, [assign("intake-api")], { account_id: "b".repeat(32) }),
    409,
  );
  rejects(() => save(a, [assign("intake-api")], { revision: "0" }), 409);
  a.userId = null;
  rejects(() => save(a, [assign("intake-api")]), 403);
  assert.equal(organization(b).resources.length, 0);
});
test("worker and Pages with identical names remain distinct; separate accounts remain distinct", () => {
  const ctx = context();
  save(ctx, [assign("site"), assign("site", { kind: "pages" })]);
  assert.equal(organization(ctx).resources.length, 2);
  organize(
    ctx,
    {
      account_id: "b".repeat(32),
      revision: organization(ctx).revision,
      assignments: [assign("site")],
    },
    { ...inventory, account_id: "b".repeat(32) },
  );
  assert.equal(organization(ctx).resources.length, 3);
  assert.equal(
    withOrganization(ctx, inventory).organization.resources.length,
    2,
  );
  assert.equal(
    withOrganization(ctx, { account_id: null }).organization.resources.length,
    0,
  );
});
test("ignore, restore, reassign and unassign never delete projects or resources upstream", () => {
  const ctx = context();
  save(ctx, [assign("intake-api")]);
  save(ctx, [assign("intake-api", { project_name: undefined, ignored: true })]);
  assert.equal(organization(ctx).resources[0].project_id, null);
  assert.equal(organization(ctx).resources[0].ignored, true);
  const p = createProject(ctx, { name: "Other" });
  save(ctx, [
    assign("intake-api", { project_name: undefined, project_id: p.id }),
  ]);
  assert.equal(organization(ctx).resources[0].project_id, p.id);
  save(ctx, [
    assign("intake-api", { project_name: undefined, project_id: null }),
  ]);
  assert.equal(organization(ctx).resources.length, 1);
  assert.equal(organization(ctx).resources[0].project_id, null);
  assert.equal(organization(ctx).resources[0].ignored, false);
  assert.equal(ctx.store.list("projects").length, 2);
});
test("missing resources can be released but cannot gain ownership using stale evidence", () => {
  const ctx = context();
  save(ctx, [assign("intake-api")]);
  const failed = { ...inventory, status: "error", workers: [], pages: [] };
  rejects(
    () =>
      organize(
        ctx,
        {
          account_id: account,
          revision: organization(ctx).revision,
          assignments: [assign("intake-api")],
        },
        failed,
      ),
    409,
  );
  organize(
    ctx,
    {
      account_id: account,
      revision: organization(ctx).revision,
      assignments: [assign("intake-api", { project_name: undefined })],
    },
    failed,
  );
  assert.equal(organization(ctx).resources[0].project_id, null);
});
test("invalid assignments, ambiguous names and project quotas reject without writes", () => {
  const ctx = context();
  createProject(ctx, { name: "Intake" });
  createProject(ctx, { name: "intake" });
  rejects(() => save(ctx, [assign("intake-api")]), 409);
  for (const patch of [
    { environment: "unknown" },
    { ignored: "true" },
    { ignored: true },
    { project_id: "foreign" },
    { kind: "d1" },
  ])
    rejects(() => save(ctx, [assign("intake-api", patch)]), 400);
  const limited = context();
  limited.env.MAX_PROJECTS_PER_WORKSPACE = "1";
  rejects(
    () =>
      save(limited, [
        assign("intake-api"),
        assign("intake-api-dev", { project_name: "Second" }),
      ]),
    409,
  );
  assert.equal(limited.store.list("projects").length, 0);
});
test("projects without repositories can attach source later but running services prevent source swaps", () => {
  const ctx = context();
  const p = createProject(ctx, { name: "Imported" });
  assert.equal(p.repository, "");
  const updated = updateProject(ctx, p.id, {
    repository: "https://github.com/nooesc/personal-cloud.git",
  });
  assert.equal(updated.repository, "nooesc/personal-cloud");
  ctx.store.put("services", "s", { project_id: p.id });
  rejects(() => updateProject(ctx, p.id, { repository: "" }), 409);
  assert.equal(updateProject(ctx, p.id, { name: "Renamed" }).name, "Renamed");
  rejects(() => updateProject(ctx, "foreign", { name: "x" }), 404);
  rejects(
    () => createProject(ctx, { name: "Bad", repository: "not/a/repo" }),
    400,
  );
});
test("deleting project releases resource links and invalidates outstanding edits", () => {
  const ctx = context();
  const result = save(ctx, [assign("intake-api")]);
  releaseProjectResources(ctx, result.projects[0].id);
  assert.equal(organization(ctx).resources[0].project_id, null);
  assert.notEqual(organization(ctx).revision, result.organization.revision);
});
