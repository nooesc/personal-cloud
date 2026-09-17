import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("real workerd SQLite persists organized apps, rejects foreign projects, and releases links on project deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dinghy-organization-"));
  const bundle = await build({
    stdin: {
      contents: `export {Workspace} from './src/workspace.ts'; export default {fetch(r,env){ const w=r.headers.get('x-pc-workspace-id'); return env.WORKSPACES.getByName(w).fetch(r); }};`,
      resolveDir: root,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    write: false,
  });
  const calls = [];
  const options = {
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-15",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { WORKSPACES: { className: "Workspace", useSQLite: true } },
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
      calls.push([req.method, u.pathname]);
      assert.equal(u.origin, "https://api.cloudflare.com");
      if (u.pathname.endsWith("/workers/scripts"))
        return Response.json({
          success: true,
          result: [{ id: "intake-api" }, { id: "intake-api-dev" }],
        });
      if (u.pathname.endsWith("/pages/projects"))
        return Response.json({ success: true, result: [] });
      if (u.pathname.endsWith("/graphql"))
        return Response.json({
          data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } },
        });
      throw new Error("Unexpected provider operation " + u.pathname);
    },
  };
  let mf;
  try {
    mf = new Miniflare({
      ...convertV4MiniflareOptions(options),
      resourcePersistencePath: dir,
    });
    const db = (await mf.getBindings()).DIRECTORY;
    await db.exec("CREATE TABLE github_installations(workspace_id TEXT)");
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    const call = async (
      path,
      body,
      workspace = a,
      method = body ? "POST" : "GET",
      status = 200,
    ) => {
      const r = await mf.dispatchFetch("https://local.test/api" + path, {
        method,
        headers: {
          "x-pc-workspace-id": workspace,
          "x-pc-user-id": "local-test-member",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await r.json();
      assert.equal(r.status, status, JSON.stringify(value));
      return value;
    };
    const account = "a".repeat(32);
    const connected = await call("/integrations/cloudflare/account", {
      account_id: account,
      api_token: "local-provider-fixture-only",
    });
    const saved = await call("/integrations/cloudflare/organize", {
      account_id: account,
      revision: connected.organization.revision,
      assignments: [
        {
          kind: "worker",
          name: "intake-api",
          project_name: "Intake",
          environment: "production",
        },
        {
          kind: "worker",
          name: "intake-api-dev",
          project_name: "Intake",
          environment: "development",
        },
      ],
    });
    assert.equal(saved.projects.length, 1);
    assert.equal(saved.projects[0].repository, "");
    assert.equal((await call("/snapshot")).project_resources.length, 2);
    assert.equal(
      (await call("/snapshot", undefined, b)).project_resources.length,
      0,
    );
    const other = await call(
      "/integrations/cloudflare/account",
      { account_id: account, api_token: "local-provider-fixture-only" },
      b,
    );
    await call(
      "/integrations/cloudflare/organize",
      {
        account_id: account,
        revision: other.organization.revision,
        assignments: [
          {
            kind: "worker",
            name: "intake-api",
            project_id: saved.projects[0].id,
          },
        ],
      },
      b,
      "POST",
      404,
    );
    await mf.dispose();
    mf = new Miniflare({
      ...convertV4MiniflareOptions(options),
      resourcePersistencePath: dir,
    });
    const reloaded = await call("/integrations/cloudflare/overview");
    assert.equal(reloaded.organization.resources.length, 2);
    assert.equal(reloaded.organization.revision, saved.organization.revision);
    await call(
      "/projects/" + saved.projects[0].id,
      undefined,
      a,
      "DELETE",
      202,
    );
    let view;
    for (let i = 0; i < 50; i++) {
      view = await call("/snapshot");
      if (!view.projects.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(view.projects.length, 0);
    assert.equal(view.project_resources.length, 2);
    assert(
      view.project_resources.every((r) => r.project_id === null && !r.ignored),
    );
    assert(
      calls.every(
        ([method, path]) =>
          method === "GET" || (method === "POST" && path.endsWith("/graphql")),
      ),
    );
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
