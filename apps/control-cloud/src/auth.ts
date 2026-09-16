import type { Env } from "./env";
import { body, fail, HttpError, json, text } from "./core";
import { digest, open, randomToken, seal, sign, verify } from "./auth/crypto";
import {
  exchangeOAuth,
  githubRequest,
  handleGitHub,
  resolveGitHubUserId,
  saveUserToken,
} from "./github";
export type Principal = { userId: string; workspaceId: string };
type Session = Principal & { tokenHash: string; role: string };
type User = {
  id: string;
  github_id: number;
  login: string;
  avatar_url: string;
  auth_generation: number;
  revoked_at: number;
};
export type Flow = {
  state_hash: string;
  browser_hash: string;
  verifier: string;
  purpose: string;
  user_id: string | null;
  workspace_id: string | null;
  session_hash: string | null;
  expires_at: number;
  created_at: number;
};
const SESSION_COOKIE = "pc_hosted_session";
const FLOW_COOKIE = "pc_github_flow";
export function configured(env: Env): boolean {
  return !!(
    env.GITHUB_CLIENT_ID &&
    env.GITHUB_CLIENT_SECRET &&
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_PRIVATE_KEY &&
    env.GITHUB_APP_SLUG &&
    env.SESSION_SECRET &&
    env.ENCRYPTION_KEY
  );
}
export function cookieValue(request: Request, name: string): string {
  return (
    (request.headers.get("cookie") || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ""
  );
}
function cookie(env: Env, name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(env.PUBLIC_URL).protocol === "https:" ? "; Secure" : ""}`;
}
export function assertOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env.PUBLIC_URL).origin)
    fail(403, "Request origin is not allowed");
}
async function session(request: Request, env: Env): Promise<Session> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, "Sign in with GitHub");
  const tokenHash = await digest(token);
  const row = await env.DIRECTORY.prepare(
    `SELECT s.user_id AS userId,s.workspace_id AS workspaceId,m.role FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id WHERE s.token_hash=? AND s.expires_at>? AND s.auth_generation=u.auth_generation`,
  )
    .bind(tokenHash, Date.now())
    .first<Principal & { role: string }>();
  if (!row) fail(401, "Session expired. Sign in with GitHub");
  return { ...row, tokenHash };
}
export async function authenticate(
  request: Request,
  env: Env,
): Promise<Principal> {
  const s = await session(request, env);
  return { userId: s.userId, workspaceId: s.workspaceId };
}
export async function closeUserSockets(
  env: Env,
  userId: string,
  workspaceIds?: string[],
): Promise<void> {
  const ids =
    workspaceIds ||
    (
      await env.DIRECTORY.prepare(
        "SELECT workspace_id FROM memberships WHERE user_id=?",
      )
        .bind(userId)
        .all<{ workspace_id: string }>()
    ).results.map((r) => r.workspace_id);
  for (const workspaceId of ids) {
    const response = await env.WORKSPACES.getByName(workspaceId).fetch(
      "https://workspace.internal/internal/session/revoke",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pc-workspace-id": workspaceId,
        },
        body: JSON.stringify({ userId }),
      },
    );
    if (!response.ok)
      fail(
        503,
        "Session revoked, but a live connection could not be closed. Retry",
      );
  }
}
export async function requireWorkspaceOwner(
  env: Env,
  principal: Principal,
): Promise<void> {
  const member = await env.DIRECTORY.prepare(
    "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
  )
    .bind(principal.workspaceId, principal.userId)
    .first<{ role: string }>();
  if (member?.role !== "owner") fail(403, "Workspace owner access required");
}
async function sessionView(env: Env, s: Principal): Promise<Response> {
  const user = await env.DIRECTORY.prepare(
    "SELECT id,login,avatar_url FROM users WHERE id=?",
  )
    .bind(s.userId)
    .first();
  const { results: workspaces } = await env.DIRECTORY.prepare(
    "SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at,w.id",
  )
    .bind(s.userId)
    .all<{ id: string; name: string; role: string }>();
  return json({
    mode: "hosted",
    authenticated: true,
    user,
    workspaces,
    workspace: workspaces.find((w) => w.id === s.workspaceId),
  });
}
export async function startFlow(
  request: Request,
  env: Env,
  purpose: "login" | "link" | "install",
  principal?: Principal,
): Promise<{ state: string; cookie: string }> {
  if (!configured(env))
    fail(503, "The operator must configure the hosted GitHub App");
  const minute = Math.floor(Date.now() / 60_000),
    ip = request.headers.get("cf-connecting-ip") || "local";
  const rateKey = await sign(env.SESSION_SECRET, `oauth-rate:${ip}`);
  const allowed = await env.DIRECTORY.prepare(
    "INSERT INTO auth_rate_limits (key,minute,count) VALUES (?,?,1) ON CONFLICT(key,minute) DO UPDATE SET count=count+1 WHERE count<30 RETURNING count",
  )
    .bind(rateKey, minute)
    .first();
  if (!allowed) fail(429, "Too many sign-in attempts. Try again in a minute");
  await env.DIRECTORY.prepare("DELETE FROM auth_rate_limits WHERE minute<?")
    .bind(minute - 1)
    .run();
  const nonce = randomToken(),
    state = `${nonce}.${await sign(env.SESSION_SECRET, nonce)}`,
    browser = randomToken();
  const verifier = randomToken(),
    created = Date.now();
  const current = principal ? await session(request, env) : null;
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare("DELETE FROM oauth_flows WHERE expires_at<?").bind(
      created,
    ),
    env.DIRECTORY.prepare("DELETE FROM sessions WHERE expires_at<?").bind(
      created,
    ),
    env.DIRECTORY.prepare(
      "INSERT INTO oauth_flows (state_hash,browser_hash,verifier,purpose,user_id,workspace_id,session_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(
      await digest(state),
      await digest(browser),
      await seal(env, "oauth-verifier", verifier),
      purpose,
      current?.userId || null,
      current?.workspaceId || null,
      current?.tokenHash || null,
      created + 600_000,
      created,
    ),
  ]);
  return { state, cookie: cookie(env, FLOW_COOKIE, browser, 600) };
}
export async function consumeFlow(
  request: Request,
  env: Env,
  expected: "oauth" | "install",
): Promise<Flow> {
  const state = new URL(request.url).searchParams.get("state") || "",
    [nonce, signature] = state.split(".");
  if (
    !nonce ||
    !signature ||
    !(await verify(env.SESSION_SECRET, nonce, signature))
  )
    fail(400, "GitHub authorization expired or was not started here");
  const browser = cookieValue(request, FLOW_COOKIE);
  if (!browser) fail(400, "Continue GitHub authorization in the same browser");
  // DELETE RETURNING reserves each flow atomically before exchanging a provider code.
  const flow = await env.DIRECTORY.prepare(
    `DELETE FROM oauth_flows WHERE state_hash=? AND browser_hash=? AND expires_at>? AND ${expected === "install" ? "purpose='install'" : "purpose IN ('login','link')"} RETURNING *`,
  )
    .bind(await digest(state), await digest(browser), Date.now())
    .first<Flow>();
  if (!flow) fail(400, "GitHub authorization expired or was already used");
  if (flow.user_id) {
    const original = await env.DIRECTORY.prepare(
      "SELECT 1 AS ok FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id WHERE s.token_hash=? AND s.user_id=? AND s.workspace_id=? AND s.expires_at>? AND s.auth_generation=u.auth_generation",
    )
      .bind(flow.session_hash, flow.user_id, flow.workspace_id, Date.now())
      .first();
    if (!original)
      fail(401, "The session that started this authorization has ended");
  }
  return flow;
}
export function redirectHome(
  env: Env,
  status: string,
  setCookie?: string,
): Response {
  const headers = new Headers({
    location: `${env.PUBLIC_URL.replace(/\/$/, "")}/#page=Settings&github=${encodeURIComponent(status)}`,
    "cache-control": "no-store",
  });
  headers.append("set-cookie", cookie(env, FLOW_COOKIE, "", 0));
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(null, { status: 303, headers });
}
async function oauthCallback(request: Request, env: Env): Promise<Response> {
  const flow = await consumeFlow(request, env, "oauth");
  const params = new URL(request.url).searchParams;
  if (params.has("error")) return redirectHome(env, "cancelled");
  const code = params.get("code");
  if (!code) fail(400, "Missing GitHub authorization code");
  const token = await exchangeOAuth(env, {
    code,
    code_verifier: await open(env, "oauth-verifier", flow.verifier),
    redirect_uri: `${env.PUBLIC_URL.replace(/\/$/, "")}/api/github/auth/callback`,
  });
  const profile = await githubRequest<{
    id: number;
    login: string;
    avatar_url: string;
  }>(token.access_token, "/user");
  if (!Number.isSafeInteger(profile.id) || !profile.login)
    fail(502, "GitHub returned an invalid user");
  let user = await env.DIRECTORY.prepare(
    "SELECT id,github_id,login,avatar_url,auth_generation,revoked_at FROM users WHERE github_id=?",
  )
    .bind(profile.id)
    .first<User>();
  if (flow.user_id && user?.id !== flow.user_id)
    return redirectHome(env, "wrong_account");
  const userId = user?.id || crypto.randomUUID();
  await env.DIRECTORY.prepare(
    "INSERT INTO users (id,github_id,login,avatar_url,created_at) VALUES (?,?,?,?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,avatar_url=excluded.avatar_url",
  )
    .bind(
      userId,
      profile.id,
      profile.login,
      profile.avatar_url || "",
      Date.now(),
    )
    .run();
  user = (await env.DIRECTORY.prepare(
    "SELECT id,github_id,login,avatar_url,auth_generation,revoked_at FROM users WHERE github_id=?",
  )
    .bind(profile.id)
    .first<User>())!;
  if (user.revoked_at > flow.created_at)
    fail(401, "GitHub authorization was revoked. Start again");
  await saveUserToken(
    env,
    user.id,
    token,
    user.auth_generation,
    flow.session_hash,
  );
  let workspaceId = flow.workspace_id;
  if (!workspaceId) {
    const existing = await env.DIRECTORY.prepare(
      "SELECT workspace_id FROM memberships WHERE user_id=? ORDER BY created_at,workspace_id LIMIT 1",
    )
      .bind(user.id)
      .first<{ workspace_id: string }>();
    workspaceId = existing?.workspace_id || user.id;
    if (!existing)
      await env.DIRECTORY.batch([
        env.DIRECTORY.prepare(
          "INSERT OR IGNORE INTO workspaces (id,name,created_at) VALUES (?,?,?)",
        ).bind(workspaceId, `${profile.login}’s cloud`, Date.now()),
        env.DIRECTORY.prepare(
          "INSERT OR IGNORE INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,'owner',?)",
        ).bind(workspaceId, user.id, Date.now()),
      ]);
  }
  const sessionToken = randomToken();
  const createdSession = await env.DIRECTORY.prepare(
    "INSERT INTO sessions (token_hash,user_id,workspace_id,expires_at,created_at,auth_generation) SELECT ?,?,?, ?,?,auth_generation FROM users WHERE id=? AND auth_generation=? AND EXISTS (SELECT 1 FROM memberships WHERE user_id=? AND workspace_id=?) AND (? IS NULL OR EXISTS (SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?))",
  )
    .bind(
      await digest(sessionToken),
      user.id,
      workspaceId,
      Date.now() + 7 * 86_400_000,
      Date.now(),
      user.id,
      user.auth_generation,
      user.id,
      workspaceId,
      flow.session_hash,
      flow.session_hash,
      Date.now(),
    )
    .run();
  if (!createdSession.meta.changes)
    fail(401, "Session authorization changed. Start again");
  return redirectHome(
    env,
    "connected",
    cookie(env, SESSION_COOKIE, sessionToken, 7 * 86400),
  );
}
export async function handleAuth(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname,
    method = request.method;
  if (path === "/api/github/auth" && method === "GET")
    return json({
      mode: "hosted",
      configured: configured(env),
      enabled: configured(env),
    });
  if (path === "/api/session" && method === "GET") {
    try {
      return await sessionView(env, await session(request, env));
    } catch (error) {
      if (error instanceof HttpError && error.status === 401)
        return json(
          { mode: "hosted", authenticated: false, error: error.message },
          401,
        );
      throw error;
    }
  }
  if (path === "/api/github/auth/callback" && method === "GET") {
    try {
      return await oauthCallback(request, env);
    } catch (error) {
      console.error(
        "GitHub callback failed",
        error instanceof HttpError
          ? error.message
          : error instanceof Error
            ? `${error.name}: ${error.message}`
            : "unknown",
      );
      return redirectHome(env, "signin");
    }
  }
  if (path === "/api/github/auth/start" && method === "POST") {
    assertOrigin(request, env);
    const input = await body(request);
    const purpose = input.purpose === "link" ? "link" : "login";
    const principal =
      purpose === "link" ? await authenticate(request, env) : undefined;
    const flow = await startFlow(request, env, purpose, principal);
    const row = await env.DIRECTORY.prepare(
      "SELECT verifier FROM oauth_flows WHERE state_hash=?",
    )
      .bind(await digest(flow.state))
      .first<{ verifier: string }>();
    const verifier = await open(env, "oauth-verifier", row!.verifier);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: `${env.PUBLIC_URL.replace(/\/$/, "")}/api/github/auth/callback`,
      state: flow.state,
      code_challenge: await digest(verifier),
      code_challenge_method: "S256",
    }).toString();
    return new Response(JSON.stringify({ url: url.toString() }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "set-cookie": flow.cookie,
      },
    });
  }
  if (path === "/api/session" && method === "DELETE") {
    assertOrigin(request, env);
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) {
      const previous = await env.DIRECTORY.prepare(
        "DELETE FROM sessions WHERE token_hash=? RETURNING user_id,workspace_id",
      )
        .bind(await digest(token))
        .first<{ user_id: string; workspace_id: string }>();
      if (previous)
        await closeUserSockets(env, previous.user_id, [previous.workspace_id]);
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": cookie(env, SESSION_COOKIE, "", 0),
        "cache-control": "no-store",
      },
    });
  }
  if (path === "/api/workspaces" && method === "POST") {
    assertOrigin(request, env);
    const s = await session(request, env),
      input = await body(request),
      workspaceId = crypto.randomUUID();
    const count = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM memberships WHERE user_id=? AND role='owner'",
    )
      .bind(s.userId)
      .first<{ n: number }>();
    if ((count?.n || 0) >= 20) fail(409, "Workspace limit reached");
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        "INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)",
      ).bind(workspaceId, text(input.name, 80), Date.now()),
      env.DIRECTORY.prepare(
        "INSERT INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,'owner',?)",
      ).bind(workspaceId, s.userId, Date.now()),
      env.DIRECTORY.prepare(
        "UPDATE sessions SET workspace_id=? WHERE token_hash=?",
      ).bind(workspaceId, s.tokenHash),
    ]);
    return sessionView(env, { userId: s.userId, workspaceId });
  }
  const select = path.match(/^\/api\/workspaces\/([^/]+)\/select$/);
  if (select && method === "POST") {
    assertOrigin(request, env);
    const s = await session(request, env),
      workspaceId = select[1];
    const changed = await env.DIRECTORY.prepare(
      "UPDATE sessions SET workspace_id=? WHERE token_hash=? AND EXISTS (SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?)",
    )
      .bind(workspaceId, s.tokenHash, workspaceId, s.userId)
      .run();
    if (!changed.meta.changes) fail(403, "Workspace membership required");
    return sessionView(env, { userId: s.userId, workspaceId });
  }
  if (path === "/api/workspace/members" && method === "GET") {
    const s = await session(request, env);
    return json({
      members: (
        await env.DIRECTORY.prepare(
          "SELECT u.id,u.login,u.avatar_url,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?",
        )
          .bind(s.workspaceId)
          .all()
      ).results,
    });
  }
  if (path === "/api/workspace/members" && method === "POST") {
    assertOrigin(request, env);
    const s = await session(request, env);
    await requireWorkspaceOwner(env, s);
    const input = await body(request),
      githubId = Number.isSafeInteger(input.github_id)
        ? input.github_id
        : await resolveGitHubUserId(env, text(input.login, 39));
    const user = await env.DIRECTORY.prepare(
      "SELECT id FROM users WHERE github_id=?",
    )
      .bind(githubId)
      .first<{ id: string }>();
    if (!user) fail(404, "This person must sign in to Personal Cloud first");
    await env.DIRECTORY.prepare(
      "INSERT OR IGNORE INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,'member',?)",
    )
      .bind(s.workspaceId, user.id, Date.now())
      .run();
    return json({ ok: true });
  }
  const member = path.match(/^\/api\/workspace\/members\/([^/]+)$/);
  if (member && method === "DELETE") {
    assertOrigin(request, env);
    const s = await session(request, env);
    await requireWorkspaceOwner(env, s);
    const target = await env.DIRECTORY.prepare(
      "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
    )
      .bind(s.workspaceId, member[1])
      .first<{ role: string }>();
    if (target?.role === "owner")
      fail(409, "The workspace owner cannot be removed");
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        "DELETE FROM memberships WHERE workspace_id=? AND user_id=?",
      ).bind(s.workspaceId, member[1]),
      env.DIRECTORY.prepare(
        "DELETE FROM github_installations WHERE workspace_id=? AND user_id=?",
      ).bind(s.workspaceId, member[1]),
      env.DIRECTORY.prepare(
        "DELETE FROM sessions WHERE workspace_id=? AND user_id=?",
      ).bind(s.workspaceId, member[1]),
      env.DIRECTORY.prepare(
        "DELETE FROM oauth_flows WHERE workspace_id=? AND user_id=?",
      ).bind(s.workspaceId, member[1]),
    ]);
    await closeUserSockets(env, member[1], [s.workspaceId]);
    return json({ ok: true });
  }
  if (path.startsWith("/api/github/")) return handleGitHub(request, env);
  return null;
}
