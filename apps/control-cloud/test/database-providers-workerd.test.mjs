import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  wr = createRequire(require.resolve("wrangler/package.json"));
const { build } = wr("esbuild"),
  { Miniflare, convertV4MiniflareOptions } = wr("miniflare");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("workspace provider accounts discover, link, bind and unlink without leaking organization keys or changing provider data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dinghy-db-providers-"));
  const bundle = await build({
    stdin: {
      contents: `export {Workspace} from './src/workspace.ts'; export default {fetch(r,env){return env.WORKSPACES.getByName(r.headers.get('x-pc-workspace-id')).fetch(r)}};`,
      resolveDir: root,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    write: false,
  });
  const calls = [];
  let reject = false;
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-09-15",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        WORKSPACES: { className: "Workspace", useSQLite: true },
      },
      durableObjectsPersist: join(dir, "do"),
      d1Databases: ["DIRECTORY"],
      d1Persist: join(dir, "d1"),
      bindings: {
        MAX_PROJECTS_PER_WORKSPACE: "100",
        MAX_MACHINES_PER_WORKSPACE: "100",
        ENCRYPTION_KEY: "local-only-test-encryption-key-32-characters",
        PUBLIC_URL: "https://local.test",
      },
      outboundService: async (req) => {
        const u = new URL(req.url);
        calls.push([req.method, u.origin, u.pathname, u.search]);
        assert.equal(
          req.method,
          "GET",
          "No remote writes in an account integration",
        );
        if (reject)
          return Response.json(
            { error: "do not reflect provider-secret" },
            { status: 403 },
          );
        const h = req.headers.get("authorization");
        if (u.origin === "https://console.neon.tech") {
          assert.ok(
            ["Bearer neon-fixture-key", "Bearer neon-rotated-key"].includes(h),
          );
          if (u.pathname === "/api/v2/projects") {
            assert.equal(u.searchParams.get("org_id"), "org-fixture");
            return Response.json({
              projects: [
                {
                  id: u.searchParams.has("cursor") ? "second" : "project-a",
                  name: "Neon project",
                },
              ],
              pagination: u.searchParams.has("cursor")
                ? {}
                : { cursor: "page-2" },
            });
          }
          if (/\/projects\/[^/]+$/.test(u.pathname))
            return Response.json({
              project: {
                id: "project-a",
                org_id: u.pathname.endsWith("foreign")
                  ? "org-other"
                  : "org-fixture",
              },
            });
          if (u.pathname.endsWith("/branches"))
            return Response.json({
              branches: [
                { id: "br-fixture", name: "production", default: true },
              ],
              pagination: {},
            });
          if (u.pathname.endsWith("/databases"))
            return Response.json({ databases: [{ name: "app" }] });
          if (u.pathname.endsWith("/roles"))
            return Response.json({
              roles: [
                { name: "app_role", protected: false },
                {
                  name: "internal",
                  protected: true,
                  password: "never expose this",
                },
              ],
            });
          if (u.pathname.endsWith("/connection_uri")) {
            assert.equal(u.searchParams.get("role_name"), "app_role");
            assert.equal(u.searchParams.get("pooled"), "true");
            return Response.json({
              uri: "postgresql://app_role:db-secret@ep-fixture-pooler.us-east-2.aws.neon.tech/app?sslmode=require",
            });
          }
        }
        if (u.origin === "https://api.convex.dev") {
          assert.equal(h, "Bearer convex-fixture-key");
          if (u.pathname === "/v1/teams/42/projects")
            return Response.json({
              items: [{ id: 7, name: "Convex project", teamId: 42 }],
              pagination: { hasMore: false },
            });
          if (u.pathname === "/v1/projects/7")
            return Response.json({ id: 7, teamId: 42 });
          if (u.pathname.endsWith("/list_deployments"))
            return Response.json([
              {
                kind: "cloud",
                name: "fixture-123",
                deploymentType: "prod",
                deploymentUrl: "https://fixture-123.convex.cloud",
              },
              { kind: "local", name: "local-private", port: 3210 },
            ]);
        }
        if (u.origin === "https://convex.example.com") {
          assert.equal(u.pathname, "/api/v1/list_environment_variables");
          assert.equal(h, "Convex selfhost-fixture-key");
          return Response.json([
            { name: "SECRET", value: "discarded-selfhost-secret" },
          ]);
        }
        throw new Error("Unexpected provider read: " + req.url);
      },
    }),
    resourcePersistencePath: dir,
  });
  try {
    const directory = (await mf.getBindings()).DIRECTORY;
    await directory.exec(
      "CREATE TABLE github_installations(workspace_id TEXT)",
    );
    const workspace = crypto.randomUUID();
    async function call(
      path,
      value,
      method = value ? "POST" : "GET",
      status = 200,
      scope = workspace,
      user = true,
    ) {
      const response = await mf.dispatchFetch("https://local.test/api" + path, {
        method,
        headers: {
          "x-pc-workspace-id": scope,
          ...(user ? { "x-pc-user-id": "local-test-member" } : {}),
          "Content-Type": "application/json",
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    }
    const a = await call(
      "/database-providers/accounts",
      {
        provider: "neon",
        scope_id: "org-fixture",
        name: "Neon team",
        api_key: "neon-fixture-key",
      },
      "POST",
      201,
    );
    assert.equal(a.credential_encrypted, undefined);
    const page = await call(`/database-providers/accounts/${a.id}/projects`);
    assert.equal(page.next_cursor, "page-2");
    const page2 = await call(
      `/database-providers/accounts/${a.id}/projects?cursor=page-2`,
    );
    assert.equal(page2.items[0].id, "second");
    await call(
      `/database-providers/accounts/${a.id}/projects`,
      undefined,
      "GET",
      404,
      crypto.randomUUID(),
    );
    await call(
      `/database-providers/accounts/${a.id}/resources?project_id=foreign`,
      undefined,
      "GET",
      403,
    );
    const p = await call(
      "/projects",
      { name: "Fixture app", repository: "fixture/app" },
      "POST",
      201,
    );
    const p2 = await call(
      "/projects",
      { name: "Other app", repository: "fixture/app" },
      "POST",
      201,
    );
    const service = await call(
      `/projects/${p.id}/services`,
      {
        project_id: p.id,
        name: "web",
        port: 3000,
        placement: { kind: "automatic" },
      },
      "POST",
      201,
    );
    const foreign = await call(
      `/projects/${p2.id}/services`,
      {
        project_id: p2.id,
        name: "foreign",
        port: 3000,
        placement: { kind: "automatic" },
      },
      "POST",
      201,
    );
    const link = await call(
      "/database-providers/resources",
      {
        account_id: a.id,
        provider_project_id: "project-a",
        project_id: p.id,
        name: "Neon app",
        branch_id: "br-fixture",
        database_name: "app",
        role_name: "app_role",
      },
      "POST",
      201,
    );
    assert.equal(link.connection_encrypted, undefined);
    assert.equal(link.status, "linked");
    await call(
      `/database-providers/resources/${link.id}/attach`,
      { service_id: foreign.id },
      "POST",
      400,
    );
    await call(`/database-providers/resources/${link.id}/attach`, {
      service_id: service.id,
    });
    await call(
      `/database-providers/resources/${link.id}`,
      undefined,
      "DELETE",
      409,
    );
    await call(
      `/database-providers/accounts/${a.id}`,
      undefined,
      "DELETE",
      409,
    );
    await call(`/projects/${p.id}`, undefined, "DELETE", 409);
    const c = await call(
      "/database-providers/accounts",
      {
        provider: "convex",
        scope_id: "42",
        name: "Convex team",
        api_key: "convex-fixture-key",
      },
      "POST",
      201,
    );
    const options = await call(
      `/database-providers/accounts/${c.id}/resources?project_id=7`,
    );
    assert.equal(options.items.length, 1);
    const convex = await call(
      "/database-providers/resources",
      {
        account_id: c.id,
        provider_project_id: "7",
        project_id: p.id,
        name: "Convex app",
        deployment: "fixture-123",
      },
      "POST",
      201,
    );
    await call(
      `/database-providers/resources/${convex.id}/attach`,
      { service_id: service.id, variable: "CONVEX_DEPLOY_KEY" },
      "POST",
      400,
    );
    await call(`/database-providers/resources/${convex.id}/attach`, {
      service_id: service.id,
      variable: "VITE_CONVEX_URL",
    });
    await call(
      "/database-providers/resources",
      {
        provider: "convex_self_hosted",
        project_id: p.id,
        name: "local",
        url: "http://127.0.0.1:3210",
        admin_key: "selfhost-fixture-key",
      },
      "POST",
      400,
    );
    const self = await call(
      "/database-providers/resources",
      {
        provider: "convex_self_hosted",
        project_id: p.id,
        name: "self",
        url: "https://convex.example.com",
        admin_key: "selfhost-fixture-key",
      },
      "POST",
      201,
    );
    await call(
      `/database-providers/resources/${self.id}/attach`,
      { service_id: service.id },
      "POST",
      409,
    );
    const snapshot = await call("/snapshot");
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      "neon-fixture-key",
      "convex-fixture-key",
      "selfhost-fixture-key",
      "db-secret",
      "discarded-selfhost-secret",
      "credential_encrypted",
      "connection_encrypted",
      "admin_encrypted",
    ])
      assert.ok(!serialized.includes(secret), secret);
    assert.equal(snapshot.database_providers.bindings.length, 2);
    const uri = await call(
      `/database-providers/resources/${link.id}/connection`,
    );
    assert.match(uri.DATABASE_URL, /db-secret/);
    reject = true;
    const error = await call(
      `/database-providers/accounts/${a.id}/projects`,
      undefined,
      "GET",
      403,
    );
    assert.ok(!JSON.stringify(error).includes("provider-secret"));
    reject = false;
    await call(
      `/database-providers/accounts/${a.id}/credential`,
      { api_key: "neon-rotated-key" },
      "PUT",
    );
    await call(`/database-providers/resources/${link.id}/detach`, {
      service_id: service.id,
    });
    const removed = await call(
      `/database-providers/resources/${link.id}`,
      undefined,
      "DELETE",
    );
    assert.equal(removed.remote_data_preserved, true);
    await call(`/database-providers/accounts/${a.id}`, undefined, "DELETE");
    assert.ok(calls.length > 10);
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
