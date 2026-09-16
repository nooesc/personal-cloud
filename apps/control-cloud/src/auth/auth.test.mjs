import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { handleAuth, authenticate } from "../auth.ts";
import { sourceToken, pkcs8 } from "../github.ts";
import { digest, seal, open, sign, verify, verifyWebhook } from "./crypto.ts";

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../../migrations/0001_directory.sql", import.meta.url),
      "utf8",
    ),
  );
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
        const r = db.prepare(sql).run(...values);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  const env = {
    PUBLIC_URL: "https://cloud.example",
    SESSION_SECRET: "s".repeat(64),
    ENCRYPTION_KEY: "e".repeat(64),
    GITHUB_CLIENT_ID: "client",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_APP_ID: "77",
    GITHUB_APP_SLUG: "personal-cloud-test",
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).privateKey.export({ type: "pkcs1", format: "pem" }),
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    DIRECTORY: {
      prepare: statement,
      async batch(statements) {
        db.exec("BEGIN");
        try {
          const r = [];
          for (const s of statements) r.push(await s.run());
          db.exec("COMMIT");
          return r;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
    WORKSPACES: {
      getByName() {
        return {
          async fetch() {
            return Response.json({ ok: true });
          },
        };
      },
    },
  };
  return { db, env };
}
function req(path, method = "GET", data, token) {
  return new Request(`https://cloud.example${path}`, {
    method,
    headers: {
      Origin: "https://cloud.example",
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Cookie: token } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}
async function start(env, purpose = "login", session) {
  const r = await handleAuth(
    req("/api/github/auth/start", "POST", { purpose }, session),
    env,
  );
  assert.equal(r.status, 200);
  return {
    state: new URL((await r.json()).url).searchParams.get("state"),
    cookie: r.headers.get("set-cookie").split(";")[0],
  };
}
async function login(env, githubId = 11, login = "alice") {
  const flow = await start(env);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(
      init.redirect,
      "manual",
      "Workers must reject redirects without unsupported redirect:error",
    );
    return String(url).includes("access_token")
      ? Response.json({ access_token: "test-user-token" })
      : Response.json({ id: githubId, login, avatar_url: "" });
  };
  try {
    const r = await handleAuth(
      req(
        `/api/github/auth/callback?code=provider-code&state=${encodeURIComponent(flow.state)}`,
        "GET",
        undefined,
        flow.cookie,
      ),
      env,
    );
    const cookie = r.headers
      .getSetCookie()
      .find((c) => c.startsWith("pc_hosted_session="))
      ?.split(";")[0];
    assert.ok(cookie, r.headers.get("location"));
    return cookie;
  } finally {
    globalThis.fetch = original;
  }
}
test("credential encryption binds ciphertext to identity and HMAC rejects tampering", async () => {
  const { env } = harness();
  const encrypted = await seal(env, "user:1", "secret");
  assert.equal(await open(env, "user:1", encrypted), "secret");
  await assert.rejects(open(env, "user:2", encrypted));
  const sig = await sign(env.SESSION_SECRET, "state");
  assert.equal(await verify(env.SESSION_SECRET, "state", sig), true);
  assert.equal(await verify(env.SESSION_SECRET, "other", sig), false);
  assert.equal(
    await verifyWebhook("secret", new ArrayBuffer(0), "sha256=00"),
    false,
  );
});
test("GitHub PKCS1 keys import through the PKCS8 envelope", async () => {
  const { env } = harness();
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8(env.GITHUB_APP_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  assert.equal(key.type, "private");
});
test("new identities get isolated workspace sessions and cannot select another tenant", async () => {
  const { env, db } = harness();
  const alice = await login(env),
    bob = await login(env, 22, "bob");
  const a = await authenticate(
      req("/api/session", "GET", undefined, alice),
      env,
    ),
    b = await authenticate(req("/api/session", "GET", undefined, bob), env);
  assert.notEqual(a.workspaceId, b.workspaceId);
  await assert.rejects(
    handleAuth(
      req(`/api/workspaces/${a.workspaceId}/select`, "POST", {}, bob),
      env,
    ),
    (e) => e.status === 403,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM users").get().n, 2);
  const session = await (
    await handleAuth(req("/api/session", "GET", undefined, alice), env)
  ).json();
  assert.equal(session.mode, "hosted");
  assert.equal(session.workspaces.length, 1);
  assert.equal(session.user.login, "alice");
  assert.equal(JSON.stringify(session).includes("test-user-token"), false);
  assert.equal(
    db
      .prepare("SELECT github_token FROM users LIMIT 1")
      .get()
      .github_token.includes("test-user-token"),
    false,
  );
});
test("OAuth state is browser-bound, one-use, and expired state is rejected", async () => {
  const { env, db } = harness();
  const flow = await start(env);
  let r = await handleAuth(
    req(
      `/api/github/auth/callback?code=x&state=${encodeURIComponent(flow.state)}`,
    ),
    env,
  );
  assert.match(r.headers.get("location"), /github=signin/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM oauth_flows").get().n, 1);
  db.prepare("UPDATE oauth_flows SET expires_at=0").run();
  r = await handleAuth(
    req(
      `/api/github/auth/callback?code=x&state=${encodeURIComponent(flow.state)}`,
      "GET",
      undefined,
      flow.cookie,
    ),
    env,
  );
  assert.match(r.headers.get("location"), /github=signin/);
});
test("removing a member revokes selected sessions and rejects tenant access", async () => {
  const { env, db } = harness();
  const alice = await login(env),
    bob = await login(env, 22, "bob");
  const a = await authenticate(
      req("/api/session", "GET", undefined, alice),
      env,
    ),
    b = await authenticate(req("/api/session", "GET", undefined, bob), env);
  await handleAuth(
    req("/api/workspace/members", "POST", { github_id: 22 }, alice),
    env,
  );
  await handleAuth(
    req(`/api/workspaces/${a.workspaceId}/select`, "POST", {}, bob),
    env,
  );
  assert.equal(
    (await authenticate(req("/api/session", "GET", undefined, bob), env))
      .workspaceId,
    a.workspaceId,
  );
  await handleAuth(
    req(`/api/workspace/members/${b.userId}`, "DELETE", undefined, alice),
    env,
  );
  await assert.rejects(
    authenticate(req("/api/session", "GET", undefined, bob), env),
    (e) => e.status === 401,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM memberships WHERE user_id=?")
      .get(b.userId).n,
    1,
  );
});
test("cross-origin mutations rejected and logout deletes server-side session", async () => {
  const { env } = harness();
  const cookie = await login(env);
  await assert.rejects(
    handleAuth(
      new Request("https://cloud.example/api/workspaces", {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://evil.example" },
        body: JSON.stringify({ name: "bad" }),
      }),
      env,
    ),
    (e) => e.status === 403,
  );
  await handleAuth(req("/api/session", "DELETE", undefined, cookie), env);
  await assert.rejects(
    authenticate(req("/api/session", "GET", undefined, cookie), env),
    (e) => e.status === 401,
  );
});
test("repository source tokens require workspace grant and narrow repository IDs and permissions", async () => {
  const { env, db } = harness();
  const cookie = await login(env),
    p = await authenticate(req("/api/session", "GET", undefined, cookie), env);
  await assert.rejects(
    sourceToken(env, p.workspaceId, "alice/private"),
    (e) => e.status === 403,
  );
  db.prepare("INSERT INTO github_installations VALUES (?,?,?,?,?,?,?)").run(
    p.workspaceId,
    123,
    p.userId,
    "alice",
    "User",
    "selected",
    Date.now(),
  );
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/installation"))
      return Response.json({ id: 123, app_id: 77, suspended_at: null });
    if (String(url).endsWith("/access_tokens"))
      return Response.json({ token: "scoped-installation-token" });
    return Response.json({ id: 456, full_name: "alice/private" });
  };
  try {
    assert.equal(
      await sourceToken(env, p.workspaceId, "alice/private"),
      "scoped-installation-token",
    );
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
      repository_ids: [456],
      permissions: { contents: "read", metadata: "read" },
    });
  } finally {
    globalThis.fetch = original;
  }
});
test("revocation webhook invalidates sessions and source access; forged webhook has no effect", async () => {
  const { env, db } = harness();
  const cookie = await login(env);
  const payload = JSON.stringify({ action: "revoked", sender: { id: 11 } }),
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    signature =
      "sha256=" +
      Buffer.from(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(payload),
        ),
      ).toString("hex");
  const webhook = (sig) =>
    new Request("https://cloud.example/api/github/app/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "github_app_authorization",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": sig,
      },
      body: payload,
    });
  await assert.rejects(
    handleAuth(webhook("bad"), env),
    (e) => e.status === 401,
  );
  assert.ok(
    await authenticate(req("/api/session", "GET", undefined, cookie), env),
  );
  await handleAuth(webhook(signature), env);
  await assert.rejects(
    authenticate(req("/api/session", "GET", undefined, cookie), env),
    (e) => e.status === 401,
  );
  assert.equal(
    db.prepare("SELECT github_token FROM users").get().github_token,
    null,
  );
});
test("OAuth callback cannot replay or link a different GitHub identity", async () => {
  const { env, db } = harness();
  const alice = await login(env);
  const flow = await start(env, "link", alice),
    original = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes("access_token")
      ? Response.json({ access_token: "wrong-user-token" })
      : Response.json({ id: 999, login: "attacker", avatar_url: "" });
  try {
    const callback = () =>
      handleAuth(
        req(
          `/api/github/auth/callback?code=x&state=${encodeURIComponent(flow.state)}`,
          "GET",
          undefined,
          flow.cookie,
        ),
        env,
      );
    assert.match(
      (await callback()).headers.get("location"),
      /github=wrong_account/,
    );
    assert.match((await callback()).headers.get("location"), /github=signin/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM users").get().n, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("installation callbacks reject unverified IDs and sync never attaches unrelated installations", async () => {
  const { env, db } = harness();
  const cookie = await login(env),
    original = globalThis.fetch;
  const installation = {
    id: 123,
    app_id: 77,
    account: { login: "alice", type: "User" },
    repository_selection: "selected",
    suspended_at: null,
  };
  globalThis.fetch = async () =>
    Response.json({ installations: [installation] });
  try {
    let r = await handleAuth(
      req("/api/github/app/install", "POST", {}, cookie),
      env,
    );
    const flowCookie = r.headers.get("set-cookie").split(";")[0],
      state = new URL((await r.json()).url).searchParams.get("state");
    r = await handleAuth(
      req(
        `/api/github/app/installed?installation_id=999&state=${encodeURIComponent(state)}`,
        "GET",
        undefined,
        flowCookie,
      ),
      env,
    );
    assert.match(r.headers.get("location"), /github=installation/);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM github_installations").get().n,
      0,
    );
    await handleAuth(req("/api/github/app/sync", "POST", {}, cookie), env);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM github_installations").get().n,
      0,
    );
    await handleAuth(
      req("/api/github/app/sync", "POST", { installation_ids: [123] }, cookie),
      env,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM github_installations").get().n,
      1,
    );
    globalThis.fetch = async () => Response.json({ installations: [] });
    await handleAuth(req("/api/github/app/sync", "POST", {}, cookie), env);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM github_installations").get().n,
      0,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("signed push deliveries are tenant-routed, deduplicated and retry failed fanout", async () => {
  const { env, db } = harness();
  const cookie = await login(env),
    p = await authenticate(req("/api/session", "GET", undefined, cookie), env);
  db.prepare("INSERT INTO github_installations VALUES (?,?,?,?,?,?,?)").run(
    p.workspaceId,
    123,
    p.userId,
    "alice",
    "User",
    "selected",
    Date.now(),
  );
  const calls = [];
  let fail = true;
  env.WORKSPACES.getByName = (id) => ({
    async fetch(url, init) {
      calls.push({ id, url, body: JSON.parse(init.body) });
      return new Response("{}", { status: fail ? 503 : 200 });
    },
  });
  const payload = JSON.stringify({
      installation: { id: 123 },
      ref: "refs/heads/main",
      repository: { full_name: "alice/private" },
      after: "a".repeat(40),
    }),
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
    signature =
      "sha256=" +
      Buffer.from(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(payload),
        ),
      ).toString("hex");
  const webhook = () =>
    new Request("https://cloud.example/api/github/app/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-github-delivery": "delivery-2",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });
  await assert.rejects(handleAuth(webhook(), env), (e) => e.status === 503);
  fail = false;
  await handleAuth(webhook(), env);
  await handleAuth(webhook(), env);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, p.workspaceId);
  assert.equal(calls[0].body.event, "push");
  assert.ok(
    db.prepare("SELECT completed_at FROM github_deliveries").get().completed_at,
  );
});
