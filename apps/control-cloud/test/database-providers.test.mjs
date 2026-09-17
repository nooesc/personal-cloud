import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleDatabaseProviders,
  providerEnvironment,
} from "../src/database-providers.ts";
import { environment } from "../src/runtime/common.ts";
function context() {
  const docs = new Map();
  const store = {
    get: (c, k) => docs.get(c + ":" + k),
    put: (c, k, v) => docs.set(c + ":" + k, v),
    delete: (c, k) => docs.delete(c + ":" + k),
    list: (c) =>
      [...docs.entries()]
        .filter(([k]) => k.startsWith(c + ":"))
        .map(([, v]) => v),
  };
  return {
    store,
    userId: "test",
    workspaceId: "workspace",
    broadcast() {},
    seal: async (_, v) => "sealed:" + v,
    open: async (_, v) => v.slice(7),
  };
}
function seed(ctx) {
  ctx.store.put("projects", "p", { id: "p" });
  ctx.store.put("services", "s", { id: "s", project_id: "p" });
  ctx.store.put("database_links", "l", {
    id: "l",
    project_id: "p",
    provider: "neon",
    connection_encrypted: "sealed:postgresql://role:db-secret@host/app",
  });
}
test("account keys and self-hosted admin keys never enter app environments; explicit URL conflicts fail", async () => {
  const ctx = context();
  seed(ctx);
  ctx.store.put("provider_bindings", "s:postgres", {
    id: "s:postgres",
    service_id: "s",
    resource_id: "l",
    variable: "DATABASE_URL",
  });
  ctx.store.put("database_links", "c", {
    id: "c",
    project_id: "p",
    provider: "convex_self_hosted",
    url: "https://convex.example.com",
    admin_encrypted: "sealed:admin-secret",
  });
  ctx.store.put("provider_bindings", "s:convex", {
    id: "s:convex",
    service_id: "s",
    resource_id: "c",
    variable: "VITE_CONVEX_URL",
  });
  const env = await providerEnvironment(ctx, "s");
  assert.deepEqual(env, {
    DATABASE_URL: "postgresql://role:db-secret@host/app",
    CONVEX_URL: "https://convex.example.com",
    VITE_CONVEX_URL: "https://convex.example.com",
  });
  assert.ok(!JSON.stringify(env).includes("admin-secret"));
  ctx.store.put("environment", "p:CONVEX_URL", {
    project_id: "p",
    key: "CONVEX_URL",
    value_encrypted: "sealed:https://other.example.com",
  });
  await assert.rejects(environment(ctx, "p", "s"), /conflicting CONVEX_URL/);
});
test("attach re-reads link after body IO and rejects deleting services/projects", async () => {
  for (const kind of ["removed-link", "deleting-service", "deleting-project"]) {
    const ctx = context();
    seed(ctx);
    const request = {
      url: "https://local.test/api/database-providers/resources/l/attach",
      method: "POST",
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true };
              done = true;
              if (kind === "removed-link")
                ctx.store.delete("database_links", "l");
              if (kind === "deleting-service")
                ctx.store.put("services", "s", {
                  id: "s",
                  project_id: "p",
                  status: "deleting",
                });
              if (kind === "deleting-project")
                ctx.store.put("projects", "p", { id: "p", status: "deleting" });
              return {
                done: false,
                value: new TextEncoder().encode('{"service_id":"s"}'),
              };
            },
          };
        },
      },
    };
    await assert.rejects(
      handleDatabaseProviders(request, ctx),
      /not found|being removed/,
    );
    assert.equal(ctx.store.list("provider_bindings").length, 0);
  }
});
