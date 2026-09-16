import assert from "node:assert/strict";
import { createCipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { transformLegacy } from "../../../scripts/export-hosted.mjs";
import { handleMigration, handleWorkspaceMigration } from "../src/migration.ts";
import { open } from "../src/crypto.ts";
if (!crypto.subtle.timingSafeEqual)
  crypto.subtle.timingSafeEqual = timingSafeEqual;
const legacyKey = "ab".repeat(32),
  targetKey = "target-key-".repeat(6),
  workspaceId = "11111111-1111-4111-8111-111111111111",
  userId = "22222222-2222-4222-8222-222222222222",
  machineId = "33333333-3333-4333-8333-333333333333",
  projectId = "44444444-4444-4444-8444-444444444444";
function encrypt(context, value) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", Buffer.from(legacyKey, "hex"), iv);
  c.setAAD(Buffer.from(context));
  return Buffer.concat([
    iv,
    c.update(value),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
const source = {
  machines: [
    {
      id: machineId,
      credential_hash: "cd".repeat(32),
      roles: ["compute", "builder"],
      report: { hostname: "test" },
      last_seen: new Date().toISOString(),
    },
  ],
  projects: [
    { id: projectId, name: "test", repository: "alice/test", branch: "main" },
  ],
  services: [],
  deployments: [],
  databases: [],
  fleet_network_nodes: [
    {
      machine_id: machineId,
      address_slot: 18,
      is_server: true,
      public_key: "pub",
      endpoint: null,
    },
  ],
  settings: [
    {
      key: "runtime",
      value: {
        nomad_url: `agent://${machineId}`,
        registry_url: "http://10.77.0.18:5000",
        registry_password: encrypt("runtime:registry", "old-registry-password"),
      },
    },
  ],
  github_owner: [{ user_id: 99, login: "alice" }],
  environment_variables: [
    {
      project_id: projectId,
      key: "API_KEY",
      value_encrypted: encrypt(
        `env:${projectId}:API_KEY`,
        "environment-secret",
      ),
    },
  ],
  integration_secrets: [],
  github_installations: [],
};
source.retained_database_volumes = [
  {
    database_id: "55555555-5555-4555-8555-555555555555",
    project_id: projectId,
    machine_id: "66666666-6666-4666-8666-666666666666",
    nomad_node_id: "retired-node",
    volume_name: "original-volume",
    retained_at: new Date().toISOString(),
    connection_encrypted: encrypt(
      "database:55555555-5555-4555-8555-555555555555",
      "postgresql://old:old-secret@10.77.0.25/db",
    ),
  },
];
const bundle = transformLegacy(source, {
  legacyKey,
  targetKey,
  workspaceId,
  userId,
  publicUrl: "https://cloud.test",
});
assert.equal(JSON.stringify(bundle).includes("environment-secret"), false);
assert.equal(JSON.stringify(bundle).includes("old-registry-password"), false);
const retained = bundle.documents.find(
  (d) => d.collection === "retained_volumes",
);
assert.equal(retained.value.owner_inventory_status, "missing");
assert.equal(retained.value.machine_id, "66666666-6666-4666-8666-666666666666");
assert.equal(retained.value.recovery_requires_original_machine, true);
assert.equal(
  bundle.documents.some(
    (d) => d.collection === "machines" && d.id === retained.value.machine_id,
  ),
  false,
);
assert.equal(JSON.stringify(bundle).includes("old-secret"), false);
const environment = bundle.documents.find(
  (d) => d.collection === "environment",
);
assert.equal(
  await open(
    targetKey,
    `${workspaceId}:env:${projectId}:API_KEY`,
    environment.value.value_encrypted,
  ),
  "environment-secret",
);
assert.equal(
  bundle.documents.find((d) => d.collection === "network_nodes").value
    .private_ip,
  "10.77.0.18",
);
assert.throws(
  () =>
    transformLegacy(
      { ...source, deployments: [{ status: "building" }] },
      {
        legacyKey,
        targetKey,
        workspaceId,
        userId,
        publicUrl: "https://cloud.test",
      },
    ),
  /active deployments/,
);
const db = new DatabaseSync(":memory:");
for (const f of [
  "0001_directory.sql",
  "0002_machine_routes.sql",
  "0003_domain_routes.sql",
]) {
  try {
    db.exec(
      readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"),
    );
  } catch (e) {
    if (e.code === "ENOENT") {
      const { readdirSync } = await import("node:fs");
      const prefix = f.slice(0, 4),
        actual = readdirSync(new URL("../migrations/", import.meta.url)).find(
          (x) => x.startsWith(prefix),
        );
      db.exec(
        readFileSync(
          new URL(`../migrations/${actual}`, import.meta.url),
          "utf8",
        ),
      );
    } else throw e;
  }
}
const documents = new Map(),
  store = {
    get: (c, id) => documents.get(`${c}:${id}`),
    put: (c, id, v) => documents.set(`${c}:${id}`, v),
    list: (c) =>
      [...documents].filter(([k]) => k.startsWith(c + ":")).map(([, v]) => v),
    transaction: (fn) => fn(),
  };
function statement(sql, values = []) {
  return {
    bind(...args) {
      return statement(sql, args);
    },
    async first() {
      return db.prepare(sql).get(...values) || null;
    },
    async all() {
      return { results: db.prepare(sql).all(...values) };
    },
    async run() {
      return {
        meta: { changes: Number(db.prepare(sql).run(...values).changes) },
      };
    },
  };
}
const env = {
    ENCRYPTION_KEY: targetKey,
    MIGRATION_TOKEN: "m".repeat(64),
    DIRECTORY: {
      prepare: statement,
      async batch(s) {
        db.exec("BEGIN");
        try {
          const r = [];
          for (const q of s) r.push(await q.run());
          db.exec("COMMIT");
          return r;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
  },
  ctx = {
    env,
    workspaceId,
    store,
    schedule: async () => {},
    broadcast: () => {},
  };
env.WORKSPACES = {
  getByName: () => ({
    fetch: async (url, init) =>
      handleWorkspaceMigration(new Request(url, init), ctx),
  }),
};
function request(token = env.MIGRATION_TOKEN) {
  return new Request("https://control.test/api/operator/import", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bundle),
  });
}
await assert.rejects(
  handleMigration(request("wrong"), env),
  (e) => e.status === 401,
);
let response = await handleMigration(request(), env);
assert.equal((await response.json()).status, "imported");
assert.equal(
  db
    .prepare("SELECT workspace_id FROM machine_routes WHERE id=?")
    .get(machineId).workspace_id,
  workspaceId,
);
assert.equal(store.get("meta", "migration").status, "active");
assert.equal(db.prepare("SELECT count(*) AS n FROM machine_routes").get().n, 1);
assert.equal(
  store.get("retained_volumes", "55555555-5555-4555-8555-555555555555")
    .owner_inventory_status,
  "missing",
);
response = await handleMigration(request(), env);
assert.equal((await response.json()).status, "already_imported");
assert.equal(db.prepare("SELECT count(*) AS n FROM users").get().n, 1);
console.log(
  "PASS: legacy decrypt/re-encrypt, preserved private IP, active-operation rejection, operator auth, SQLite directory publication, exact retry. Synthetic source only; no live reads/writes.",
);
