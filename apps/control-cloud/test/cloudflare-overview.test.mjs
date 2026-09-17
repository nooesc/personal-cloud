import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CloudflareOverview,
  fetchCloudflareOverview,
} from "../src/cloudflare-overview.ts";
const account = "a".repeat(32);
const credential = { account_id: account, token: "private-test-token" };
function context() {
  const values = new Map();
  return {
    userId: "owner",
    env: { CF_API_TOKEN: "operator-secret", CF_ACCOUNT_ID: account },
    workspaceId: crypto.randomUUID(),
    store: {
      get: (c, k) => values.get(c + ":" + k),
      list: (c) =>
        [...values].filter(([k]) => k.startsWith(c + ":")).map(([, v]) => v),
      transaction: (fn) => fn(),
      put: (c, k, v) => values.set(c + ":" + k, v),
      delete: (c, k) => values.delete(c + ":" + k),
    },
    seal: async (_, s) => Buffer.from(s).toString("base64"),
    open: async (_, s) => Buffer.from(s, "base64").toString(),
    broadcast() {},
    event() {},
  };
}
function request(path = "overview", method = "GET", value) {
  return new Request("https://local.test/api/integrations/cloudflare/" + path, {
    method,
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
}
function mockProvider(t, options = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (options.wait) await options.wait;
    if (options.failAll || (options.failAnalytics && url.endsWith("/graphql")))
      return Response.json({ error: credential.token }, { status: 403 });
    if (url.endsWith("/workers/domains"))
      return options.failDomains
        ? Response.json({ error: credential.token }, { status: 403 })
        : Response.json({ success: true, result: options.domains ?? [{hostname: "app.example.com", service: "api", environment: "production", secret: "must-not-leak"}] });
    if (url.endsWith("/graphql")) {
      const body = JSON.parse(init.body);
      if (body.query.includes("datetimeHour")) {
        const hour = new Date(Math.floor(Date.now() / 3600e3) * 3600e3);
        return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: options.hourly ?? [
          { dimensions: { scriptName: "api", datetimeHour: hour.toISOString() }, sum: { requests: 100 } },
          { dimensions: { scriptName: "api", datetimeHour: new Date(hour.getTime() - 3600e3).toISOString() }, sum: { requests: 23 } },
          { dimensions: { scriptName: "api", datetimeHour: new Date(hour.getTime() - 48 * 3600e3).toISOString() }, sum: { requests: 999 } },
        ] }] } } });
      }
      return Response.json({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: options.rows ?? [
                  {
                    dimensions: { scriptName: "api" },
                    sum: { requests: 123, errors: 2, subrequests: 45 },
                  },
                ],
              },
            ],
          },
        },
      });
    }
    if (url.includes("/scripts/api/versions"))
      return Response.json({ success: true, result: { items: [
        { id: "v2", metadata: { created_on: new Date(Date.now() - 86400e3).toISOString(), author_email: "must-not-leak" } },
        { id: "v1", metadata: { created_on: new Date(Date.now() - 30 * 86400e3).toISOString() } },
      ] } });
    if (url.includes("/pages/projects/site/deployments"))
      return Response.json({ success: true, result: [
        { id: "d2", environment: "production", created_on: new Date(Date.now() - 2 * 86400e3).toISOString(), env_vars: { S: { value: "must-not-leak" } } },
        { id: "d1", environment: "preview", created_on: new Date(Date.now() - 3 * 86400e3).toISOString() },
      ] });
    if (url.endsWith("/workers/subdomain"))
      return options.failSubdomain
        ? Response.json({ error: credential.token }, { status: 403 })
        : Response.json({ success: true, result: { subdomain: "acme" } });
    if (url.endsWith("/scripts/api/subdomain"))
      return Response.json({ success: true, result: { enabled: options.workersDev ?? true, previews_enabled: true } });
    if (url.endsWith("/workers/scripts"))
      return Response.json({
        success: true,
        result: [
          {
            id: "api",
            modified_on: "2026-09-16T00:00:00Z",
            bindings: [{ secret: "must-not-leak" }],
          },
        ],
      });
    return Response.json({
      success: true,
      result: [
        {
          name: "site",
          subdomain: "site.pages.dev",
          domains: options.pageDomains ?? ["site.pages.dev", "www.example.org"],
          production_branch: "main",
          canonical_deployment: {
            modified_on: "2026-09-16T00:00:00Z",
            latest_stage: { status: "success" },
            env_vars: { SECRET: { value: "must-not-leak" } },
          },
        },
      ],
    });
  });
  return calls;
}
test("inventory is allowlisted and analytics represents provider observations", async (t) => {
  const calls = mockProvider(t);
  const r = await fetchCloudflareOverview(credential);
  assert.equal(r.status, "connected");
  assert.equal(r.workers[0].requests, 123);
  assert.equal(r.pages[0].deployment_status, "success");
  assert.equal(r.pages[0].url, "https://site.pages.dev");
  assert.equal(r.workers[0].dashboard_url, `https://dash.cloudflare.com/${account}/workers/services/view/api/production`);
  assert.equal(r.pages[0].dashboard_url, `https://dash.cloudflare.com/${account}/pages/view/site`);
  assert(!JSON.stringify(r).includes("must-not-leak"));
  assert.equal(calls.length, 9);
  assert(
    calls.every(
      (c) => c.init.headers.Authorization === "Bearer private-test-token",
    ),
  );
  assert.equal(Date.parse(r.window.end) - Date.parse(r.window.start), 86400000);
});
test("analytics denial stays null and partial, never fake zero or leaked error body", async (t) => {
  mockProvider(t, { failAnalytics: true });
  const r = await fetchCloudflareOverview(credential);
  assert.equal(r.status, "partial");
  assert.equal(r.workers[0].requests, null);
  assert(!JSON.stringify(r).includes(credential.token));
});
test("successful empty analytics is observed zero; malformed rows remain unavailable", async (t) => {
  const calls = mockProvider(t, { rows: [] });
  const r = await fetchCloudflareOverview(credential);
  assert.equal(r.workers[0].requests, 0);
});
test("shared platform credentials are never used for workspace inventory", async (t) => {
  const calls = mockProvider(t);
  const ctx = context();
  const response = await new CloudflareOverview().handle(request(), ctx);
  assert.equal((await response.json()).status, "not_connected");
  assert.equal(calls.length, 0);
});
test("connection is encrypted, cached, workspace isolated, and disconnect preserves hosting", async (t) => {
  const calls = mockProvider(t);
  const ctx = context();
  const overview = new CloudflareOverview();
  await overview.handle(
    request("account", "POST", {
      account_id: account,
      api_token: credential.token,
    }),
    ctx,
  );
  assert(
    !JSON.stringify(
      ctx.store.get("settings", "cloudflare-overview-account"),
    ).includes(credential.token),
  );
  await overview.handle(request(), ctx);
  assert.equal(calls.length, 9);
  assert.equal(
    (await (await new CloudflareOverview().handle(request(), context())).json())
      .status,
    "not_connected",
  );
  await overview.handle(request("account", "DELETE"), ctx);
  assert.equal(
    (await (await overview.handle(request(), ctx)).json()).status,
    "not_connected",
  );
  assert.equal(ctx.env.CF_API_TOKEN, "operator-secret");
});
test("workspace imported credentials work but disconnect suppresses fallback without deleting them", async (t) => {
  const calls = mockProvider(t);
  const ctx = context();
  const legacy = { encrypted: await ctx.seal("", JSON.stringify(credential)) };
  ctx.store.put("settings", "legacy-cloudflare", legacy);
  const api = new CloudflareOverview();
  assert.equal(
    (await (await api.handle(request(), ctx)).json()).status,
    "connected",
  );
  await api.handle(request("account", "DELETE"), ctx);
  assert.equal(
    (await (await api.handle(request(), ctx)).json()).status,
    "not_connected",
  );
  assert.deepEqual(ctx.store.get("settings", "legacy-cloudflare"), legacy);
  assert.equal(calls.length, 9);
});
test("disconnect during credential verification wins and cannot be resurrected", async (t) => {
  let release;
  const wait = new Promise((r) => (release = r));
  mockProvider(t, { wait });
  const ctx = context(),
    api = new CloudflareOverview();
  const pending = api.handle(
    request("account", "POST", {
      account_id: account,
      api_token: credential.token,
    }),
    ctx,
  );
  await new Promise((r) => setTimeout(r, 0));
  await api.handle(request("account", "DELETE"), ctx);
  release();
  await assert.rejects(pending, (e) => e.status === 409);
  assert.equal(
    (await (await api.handle(request(), ctx)).json()).status,
    "not_connected",
  );
});
test("bad credentials do not replace a working saved connection", async (t) => {
  mockProvider(t, { failAll: true });
  const ctx = context(),
    api = new CloudflareOverview();
  const prior = { revision: "prior", encrypted: "previous" };
  ctx.store.put("settings", "cloudflare-overview-account", prior);
  await assert.rejects(
    api.handle(
      request("account", "POST", {
        account_id: account,
        api_token: credential.token,
      }),
      ctx,
    ),
    (e) => e.status === 400,
  );
  assert.deepEqual(
    ctx.store.get("settings", "cloudflare-overview-account"),
    prior,
  );
});
test("machine credentials and malformed account IDs cannot access account routes", async (t) => {
  const calls = mockProvider(t);
  const ctx = context();
  ctx.userId = null;
  await assert.rejects(
    new CloudflareOverview().handle(request(), ctx),
    (e) => e.status === 403,
  );
  ctx.userId = "owner";
  await assert.rejects(
    new CloudflareOverview().handle(
      request("account", "POST", {
        account_id: "../other",
        api_token: "secret",
      }),
      ctx,
    ),
    (e) => e.status === 400,
  );
  assert.equal(calls.length, 0);
});
test("malformed analytics never becomes a successful zero", async (t) => {
  mockProvider(t, {
    rows: [
      {
        dimensions: { scriptName: "api" },
        sum: { requests: null, errors: 0, subrequests: 0 },
      },
    ],
  });
  const result = await fetchCloudflareOverview(credential);
  assert.equal(result.status, "partial");
  assert.equal(result.workers[0].requests, null);
});
test("concurrent reads share provider requests; disconnect invalidates a pending read", async (t) => {
  let release;
  const wait = new Promise((r) => (release = r));
  const calls = mockProvider(t, { wait });
  const ctx = context(),
    api = new CloudflareOverview();
  ctx.store.put("settings", "legacy-cloudflare", {
    encrypted: await ctx.seal("", JSON.stringify(credential)),
  });
  const reads = [api.handle(request(), ctx), api.handle(request(), ctx)];
  await new Promise((r) => setTimeout(r, 0));
  await api.handle(request("account", "DELETE"), ctx);
  release();
  const results = await Promise.allSettled(reads);
  assert(
    results.every((r) => r.status === "rejected" && r.reason.status === 409),
  );
  assert.equal(calls.length, 9);
  assert.equal(ctx.store.get("observations", "cloudflare-overview"), undefined);
});
test("Pages follows pagination and never exposes deployment environment variables", async (t) => {
  const pages = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/workers/scripts") || url.endsWith("/workers/domains"))
      return Response.json({ success: true, result: [] });
    if (url.includes("/deployments"))
      return Response.json({ success: true, result: [{ environment: "production", created_on: new Date().toISOString(), env_vars: { SECRET: "hidden" } }] });
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    assert.equal(new URL(url).searchParams.get("per_page"), "10");
    return Response.json({
      success: true,
      result: Array.from({ length: page === 1 ? 10 : 1 }, (_, i) => ({
        name: `page-${page}-${i}`,
        env_vars: { SECRET: "hidden" },
      })),
      result_info: { total_pages: 2 },
    });
  });
  const r = await fetchCloudflareOverview(credential);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(r.pages.length, 11);
  assert(!JSON.stringify(r).includes("hidden"));
});

test("provider requests use workerd-compatible manual redirects", async (t) => {
  const calls = mockProvider(t);
  await fetchCloudflareOverview(credential);
  assert(calls.every((call) => call.init.redirect === "manual"));
});

test("organization route persists a batch and decorates cached reads without provider mutations", async (t) => {
  const calls = mockProvider(t),
    ctx = context(),
    api = new CloudflareOverview();
  ctx.env.MAX_PROJECTS_PER_WORKSPACE = "10";
  const connected = await (
    await api.handle(
      request("account", "POST", {
        account_id: account,
        api_token: credential.token,
      }),
      ctx,
    )
  ).json();
  const payload = {
    account_id: account,
    revision: connected.organization.revision,
    assignments: [
      {
        kind: "worker",
        name: "api",
        project_name: "API",
        environment: "production",
      },
    ],
  };
  const result = await (
    await api.handle(request("organize", "POST", payload), ctx)
  ).json();
  assert.equal(result.projects.length, 1);
  assert.equal(
    result.organization.resources[0].project_id,
    result.projects[0].id,
  );
  const view = await (
    await new CloudflareOverview().handle(request(), ctx)
  ).json();
  assert.equal(view.organization.resources.length, 1);
  assert.equal(view.workers[0].requests, 123);
  assert.equal(calls.length, 9); // Only inventory, workers.dev checks and the read-only GraphQL query.
  await assert.rejects(
    api.handle(request("organize", "POST", payload), ctx),
    (e) => e.status === 409,
  );
  ctx.userId = null;
  await assert.rejects(
    api.handle(
      request("organize", "POST", {
        ...payload,
        revision: result.organization.revision,
      }),
      ctx,
    ),
    (e) => e.status === 403,
  );
});

test("disconnect during organization discovery prevents any project or association writes", async (t) => {
  let release;
  const wait = new Promise((r) => (release = r));
  mockProvider(t, { wait });
  const ctx = context(),
    api = new CloudflareOverview();
  ctx.store.put("settings", "legacy-cloudflare", {
    encrypted: await ctx.seal("", JSON.stringify(credential)),
  });
  const pending = api.handle(
    request("organize", "POST", {
      account_id: account,
      revision: "0",
      assignments: [{ kind: "worker", name: "api", project_name: "API" }],
    }),
    ctx,
  );
  await new Promise((r) => setTimeout(r, 0));
  await api.handle(request("account", "DELETE"), ctx);
  release();
  await assert.rejects(pending, (e) => e.status === 409);
  assert.equal(ctx.store.list("projects").length, 0);
  assert.equal(ctx.store.list("project_resources").length, 0);
});

test("addresses come from custom domains, workers.dev routes and Pages domains, each exact", async (t) => {
  mockProvider(t, {domains: [
    {hostname: "form.example.com", service: "api", environment: "production"},
    {hostname: "dev.example.com", service: "api-dev", environment: "production"},
  ]});
  const r = await fetchCloudflareOverview(credential);
  assert.equal(r.status, "connected");
  assert.deepEqual(r.domains.map(d => [d.kind, d.name, d.hostname]), [
    ["worker", "api", "form.example.com"],
    ["worker", "api-dev", "dev.example.com"],
    ["pages", "site", "www.example.org"],
    ["worker", "api", "api.acme.workers.dev"],
  ]);
});
test("a disabled workers.dev route is never claimed as an address", async (t) => {
  mockProvider(t, {workersDev: false, pageDomains: []});
  const r = await fetchCloudflareOverview(credential);
  assert.equal(r.status, "connected");
  assert.deepEqual(r.domains.map(d => d.hostname), ["app.example.com"]);
});
test("domain permission failure stays an explicit issue without losing Workers or other sources", async (t) => {
  mockProvider(t, {failDomains:true});
  const r = await fetchCloudflareOverview(credential);
  assert.equal(r.status, "partial");
  assert.equal(r.workers[0].name, "api");
  assert.match(r.issues.join(), /Custom domains: Access denied/);
  assert.deepEqual(r.domains.map(d => d.hostname), ["www.example.org", "api.acme.workers.dev"]);
  assert(!JSON.stringify(r).includes(credential.token));
});
test("workers.dev failure leaves the other sources and is reported", async (t) => {
  mockProvider(t, {failSubdomain:true});
  const r = await fetchCloudflareOverview(credential);
  assert.equal(r.status, "partial");
  assert.match(r.issues.join(), /workers\.dev: Access denied/);
  assert.deepEqual(r.domains.map(d => d.hostname), ["app.example.com", "www.example.org"]);
});
test("invalid domain hosts never become clickable URLs", async (t) => {
  mockProvider(t, {domains:[{hostname:"evil.example/path",service:"api",environment:"production"}], pageDomains:["bad host.example"]});
  const r = await fetchCloudflareOverview(credential);
  assert.deepEqual(r.domains.map(d => d.hostname), ["api.acme.workers.dev"]);
  assert.match(r.issues.join(), /Custom domains:/);
});
test("hourly series and change stamps are bucketed, windowed and free of provider details", async (t) => {
  mockProvider(t);
  const r = await fetchCloudflareOverview(credential);
  assert.equal(r.status, "connected");
  assert.equal(r.workers[0].requests, 123);
  assert.equal(r.workers[0].series.length, 24);
  assert.deepEqual(r.workers[0].series.slice(-2), [23, 100]);
  assert.equal(r.workers[0].series.reduce((a, b) => a + b, 0), 123);
  assert.equal(r.workers[0].changes.length, 1);
  assert.equal(r.pages[0].changes.length, 1);
  assert(!JSON.stringify(r).includes("must-not-leak"));
});
test("a failed hourly query leaves totals intact and the series null", async (t) => {
  mockProvider(t, { hourly: [{ dimensions: { scriptName: "api", datetimeHour: "bad" }, sum: { requests: 1 } }] });
  const r = await fetchCloudflareOverview(credential);
  assert.equal(r.status, "partial");
  assert.equal(r.workers[0].requests, 123);
  assert.equal(r.workers[0].series, null);
  assert.match(r.issues.join(), /Worker hourly analytics/);
});
