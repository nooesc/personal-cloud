import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorsAcknowledged,
  parseConnectorAcknowledgement,
  replaceLegacyIngress,
} from "../src/integrations";
const connector = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
test("connector acknowledgements reject old task logs, restart identities and error messages", () => {
  const ack = parseConnectorAcknowledgement(
    `2026-09-16T00:00:00Z INF Generated Connector ID: ${other}\n2026-09-16T00:00:01Z INF Updated to new configuration config=old version=99\n2026-09-16T00:01:00Z INF Generated Connector ID: ${connector}\n2026-09-16T00:01:01Z INF Updated to new configuration config=new version=4\n2026-09-16T00:01:02Z ERR Failed to update configuration version=9`,
    "2026-09-16T00:01:00Z",
  );
  assert.deepEqual(ack, { connector, version: 4 });
  assert.deepEqual(
    parseConnectorAcknowledgement(
      `2026-09-16T00:01:03Z INF Generated Connector ID: ${other}`,
      "2026-09-16T00:01:00Z",
      ack,
    ),
    { connector: other },
  );
  assert.deepEqual(
    parseConnectorAcknowledgement(
      "2026-09-16T00:01:04Z INF Updated to new configuration config=new version=5",
      "2026-09-16T00:01:00Z",
      ack,
    ),
    { connector, version: 5 },
  );
});
test("every active connector must acknowledge; explicit stale provider versions stay authoritative", () => {
  const observed = new Map([
    [connector, 4],
    [other, 3],
  ]);
  assert.equal(
    connectorsAcknowledged([{ id: connector, conns: [{}] }], 4, observed),
    true,
  );
  assert.equal(
    connectorsAcknowledged(
      [{ id: connector, conns: [{}], config_version: 2 }],
      4,
      observed,
    ),
    false,
  );
  assert.equal(
    connectorsAcknowledged(
      [
        { id: connector, conns: [{}] },
        { id: other, conns: [{}] },
      ],
      4,
      observed,
    ),
    false,
  );
  assert.equal(
    connectorsAcknowledged(
      [{ id: other, conns: [], config_version: 99 }],
      4,
      observed,
    ),
    false,
  );
  assert.equal(
    connectorsAcknowledged(
      [{ id: other, conns: [{}] }],
      4,
      new Map([[connector, 99]]),
    ),
    false,
  );
});
test("legacy ingress update preserves unrelated routes and provider configuration", () => {
  const config = {
    originRequest: { connectTimeout: 10 },
    warp_routing: { enabled: false },
    ingress: [
      {
        hostname: "app.example.test",
        service: "http://10.77.0.2:8080",
        originRequest: { httpHostHeader: "example" },
      },
      { hostname: "unrelated.example.test", service: "http://10.77.0.3:9000" },
      { service: "http_status:404" },
    ],
  };
  const result = replaceLegacyIngress(
    config,
    "app.example.test",
    "http://10.77.0.4:8080",
  );
  assert.equal(result.ingress[0].service, "http://10.77.0.4:8080");
  assert.deepEqual(
    result.ingress[0].originRequest,
    config.ingress[0].originRequest,
  );
  assert.deepEqual(result.ingress.slice(1), config.ingress.slice(1));
  assert.deepEqual(result.originRequest, config.originRequest);
  assert.equal(config.ingress[0].service, "http://10.77.0.2:8080");
  assert.throws(
    () =>
      replaceLegacyIngress(
        config,
        "missing.example.test",
        "http://10.77.0.4:8080",
      ),
    /hostname changed/,
  );
});

import { reconcileDomains, refreshServiceDomains } from "../src/integrations";
import { type Doc, type WorkspaceContext, type Store } from "../src/core";
function fixture() {
  const records = new Map<string, unknown>();
  const store: Store = {
    get: <T = Doc>(c: string, i: string) =>
      records.get(`${c}/${i}`) as T | undefined,
    list: <T = Doc>(c: string) =>
      [...records]
        .filter(([k]) => k.startsWith(`${c}/`))
        .map(([, v]) => v as T),
    put: (c, i, v) => {
      records.set(`${c}/${i}`, v);
    },
    delete: (c, i) => {
      records.delete(`${c}/${i}`);
    },
    transaction: (fn) => fn(),
  };
  const events: string[] = [];
  const ctx = {
    store,
    workspaceId: "ws",
    userId: "u",
    machineId: null,
    env: {
      CF_API_TOKEN: "managed-token",
      CF_ACCOUNT_ID: "managed-account",
      CF_ZONE_ID: "managed-zone",
      DIRECTORY: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              events.push("reservation-deleted");
            },
          }),
        }),
      },
    },
    open: async () =>
      JSON.stringify({
        token: "legacy-token",
        account_id: "old-account",
        zone_id: "old-zone",
      }),
    seal: async (_p: string, v: string) => v,
    schedule: async () => {},
    broadcast: () => {},
    event: () => {},
    requestNomad: async () => ({}),
  } as unknown as WorkspaceContext;
  store.put("settings", "legacy-cloudflare", { encrypted: "encrypted" });
  store.put("services", "s", {
    id: "s",
    address: "http://10.77.0.2:8080",
    promotion_address: "http://10.77.0.3:8080",
  });
  store.put("domains", "d", {
    id: "d",
    legacy: true,
    service_id: "s",
    hostname: "app.example.test",
    account_id: "old-account",
    zone_id: "old-zone",
    tunnel_id: "old-tunnel",
    dns_record_id: "old-dns",
    status: "pending",
  });
  return { ctx, events };
}
test("legacy refresh retains existing job and only patches its scoped tunnel", async () => {
  const { ctx } = fixture(),
    original = globalThis.fetch,
    requests: { url: string; method: string; body: Doc | null }[] = [];
  ctx.requestNomad = async (method, path) => {
    assert.equal(method, "GET");
    assert.equal(path, "/v1/job/pc-tunnel-old-tunnel");
    return { ID: "pc-tunnel-old-tunnel", Stop: false };
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer legacy-token",
    );
    assert.ok(url.includes("/accounts/old-account/cfd_tunnel/old-tunnel/"));
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/connections"))
      return Response.json({
        result: [{ id: connector, conns: [{}], config_version: 8 }],
      });
    return Response.json({
      result:
        init?.method === "PUT"
          ? { version: 8 }
          : {
              version: 7,
              config: {
                ingress: [
                  {
                    hostname: "app.example.test",
                    service: "http://10.77.0.2:8080",
                  },
                  { service: "http_status:404" },
                ],
              },
            },
    });
  };
  try {
    await refreshServiceDomains(ctx, "s");
    assert.equal(requests.length, 3);
    assert.equal(
      requests[1].body?.config.ingress[0].service,
      "http://10.77.0.3:8080",
    );
    assert.equal(ctx.store.get("domains", "d")?.configuration_applied, true);
    assert.equal(ctx.env.CF_ACCOUNT_ID, "managed-account");
    assert.equal(ctx.store.get("settings", "tunnel"), undefined);
  } finally {
    globalThis.fetch = original;
  }
});
test("legacy deletion waits for observed exit and resumes DNS/tunnel cleanup without losing state", async () => {
  const { ctx, events } = fixture(),
    original = globalThis.fetch;
  let stopped = false,
    failTunnel = true;
  ctx.store.put("domains", "d", {
    ...ctx.store.get("domains", "d"),
    status: "deleting",
  });
  ctx.requestNomad = async (method, path) => {
    events.push(`nomad:${method}`);
    if (method === "GET")
      return [{ ClientStatus: stopped ? "complete" : "running" }];
    return {};
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "GET")
      return Response.json({
        result: url.endsWith("/configurations")
          ? {
              config: {
                ingress: [
                  {
                    hostname: "app.example.test",
                    service: "http://10.77.0.2:8080",
                  },
                  { service: "http_status:404" },
                ],
              },
            }
          : url.includes("/dns_records/")
            ? {
                name: "app.example.test",
                comment: "personal-cloud:d",
                type: "CNAME",
                content: "old-tunnel.cfargotunnel.com",
              }
            : { name: "personal-cloud-d" },
      });
    assert.equal(init?.method, "DELETE");
    events.push(url.includes("/dns_records/") ? "dns-delete" : "tunnel-delete");
    if (url.endsWith("/old-tunnel") && failTunnel)
      return new Response("", { status: 503 });
    return Response.json({ result: {} });
  };
  try {
    await reconcileDomains(ctx);
    assert.equal(events.includes("dns-delete"), false);
    assert.ok(ctx.store.get("domains", "d"));
    stopped = true;
    await reconcileDomains(ctx);
    assert.equal(ctx.store.get("domains", "d")?.dns_deleted, true);
    assert.ok(ctx.store.get("domains", "d"));
    failTunnel = false;
    await reconcileDomains(ctx);
    assert.equal(ctx.store.get("domains", "d"), undefined);
    assert.equal(events.filter((x) => x === "dns-delete").length, 1);
    assert.equal(events.at(-1), "reservation-deleted");
  } finally {
    globalThis.fetch = original;
  }
});
