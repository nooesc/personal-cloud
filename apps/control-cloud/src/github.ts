import type { Env } from "./env";
import { body, fail, HttpError, json } from "./core";
import {
  assertOrigin,
  authenticate,
  closeUserSockets,
  configured,
  cookieValue,
  consumeFlow,
  redirectHome,
  requireWorkspaceOwner,
  startFlow,
  type Principal,
} from "./auth";
import {
  base64url,
  digest,
  open,
  seal,
  unbase64,
  verifyWebhook,
} from "./auth/crypto";
type GitHubToken = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  expires_at?: number;
};
type Installation = {
  id: number;
  app_id: number;
  account: { login: string; type: string };
  repository_selection: string;
  suspended_at: string | null;
};
type Grant = {
  installation_id: number;
  user_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
};
type Repository = {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  html_url: string;
  description: string | null;
};
const encoder = new TextEncoder();
export async function githubRequest<T = Record<string, any>>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//"))
    fail(500, "Invalid GitHub API path");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "Personal-Cloud");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new HttpError(
      response.status === 401 ||
        response.status === 403 ||
        response.status === 404
        ? 403
        : 502,
      `GitHub access failed (${response.status}). Reconnect or check repository permissions.`,
    );
  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}
export async function exchangeOAuth(
  env: Env,
  values: Record<string, string>,
): Promise<GitHubToken> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Personal-Cloud",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      ...values,
    }),
    signal: AbortSignal.timeout(20_000),
    redirect: "manual",
  });
  const result = (await response.json()) as GitHubToken & { error?: string };
  if (!response.ok || result.error || !result.access_token)
    fail(403, "GitHub authorization expired. Reconnect GitHub.");
  if (result.expires_in)
    result.expires_at = Date.now() + result.expires_in * 1000;
  return result;
}
export async function saveUserToken(
  env: Env,
  userId: string,
  token: GitHubToken,
  generation: number,
  sessionHash: string | null,
): Promise<void> {
  const result = await env.DIRECTORY.prepare(
    "UPDATE users SET github_token=? WHERE id=? AND auth_generation=? AND (? IS NULL OR EXISTS (SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?))",
  )
    .bind(
      await seal(env, `github-user:${userId}`, JSON.stringify(token)),
      userId,
      generation,
      sessionHash,
      sessionHash,
      Date.now(),
    )
    .run();
  if (!result.meta.changes)
    fail(401, "GitHub authorization changed. Start again");
}
async function userToken(env: Env, userId: string): Promise<string> {
  const row = await env.DIRECTORY.prepare(
    "SELECT github_token FROM users WHERE id=?",
  )
    .bind(userId)
    .first<{ github_token: string | null }>();
  if (!row?.github_token)
    fail(403, "Reconnect GitHub to restore repository access");
  const token = JSON.parse(
    await open(env, `github-user:${userId}`, row.github_token),
  ) as GitHubToken;
  if (!token.expires_at || token.expires_at > Date.now() + 60_000)
    return token.access_token;
  if (!token.refresh_token)
    fail(403, "GitHub session expired. Reconnect GitHub");
  const lock = await env.DIRECTORY.prepare(
    "UPDATE users SET token_refresh_lock=? WHERE id=? AND github_token=? AND token_refresh_lock<?",
  )
    .bind(Date.now() + 30_000, userId, row.github_token, Date.now())
    .run();
  if (!lock.meta.changes)
    fail(409, "GitHub credentials are refreshing. Try again shortly");
  try {
    const fresh = await exchangeOAuth(env, {
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    });
    const result = await env.DIRECTORY.prepare(
      "UPDATE users SET github_token=? WHERE id=? AND github_token=?",
    )
      .bind(
        await seal(env, `github-user:${userId}`, JSON.stringify(fresh)),
        userId,
        row.github_token,
      )
      .run();
    if (!result.meta.changes)
      fail(403, "GitHub authorization changed. Reconnect GitHub");
    return fresh.access_token;
  } finally {
    await env.DIRECTORY.prepare(
      "UPDATE users SET token_refresh_lock=0 WHERE id=?",
    )
      .bind(userId)
      .run();
  }
}
// GitHub supplies PKCS#1 PEM. WebCrypto imports PKCS#8, so wrap PKCS#1 in its standard RSA envelope.
function lengthBytes(n: number): number[] {
  if (n < 128) return [n];
  const b: number[] = [];
  while (n) {
    b.unshift(n & 255);
    n >>>= 8;
  }
  return [128 | b.length, ...b];
}
function der(tag: number, bytes: Uint8Array): Uint8Array {
  return new Uint8Array([tag, ...lengthBytes(bytes.length), ...bytes]);
}
export function pkcs8(pem: string): Uint8Array {
  const bytes = unbase64(
    pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""),
  );
  if (pem.includes("BEGIN PRIVATE KEY")) return bytes;
  if (!pem.includes("BEGIN RSA PRIVATE KEY"))
    fail(503, "GitHub App private key must be PEM RSA");
  return der(
    0x30,
    new Uint8Array([
      2,
      1,
      0,
      0x30,
      0x0d,
      6,
      9,
      0x2a,
      0x86,
      0x48,
      0x86,
      0xf7,
      0x0d,
      1,
      1,
      1,
      5,
      0,
      ...der(4, bytes),
    ]),
  );
}
async function appJWT(env: Env): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000),
    header = base64url(
      encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    ),
    payload = base64url(
      encoder.encode(
        JSON.stringify({
          iat: timestamp - 60,
          exp: timestamp + 540,
          iss: env.GITHUB_CLIENT_ID || env.GITHUB_APP_ID,
        }),
      ),
    ),
    unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8(env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `${unsigned}.${base64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned))))}`;
}
export async function resolveGitHubUserId(
  env: Env,
  login: string,
): Promise<number> {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) fail(400, "Invalid GitHub username");
  const profile = await githubRequest<{ id: number }>(
    await appJWT(env),
    `/users/${encodeURIComponent(login)}`,
  );
  if (!Number.isSafeInteger(profile.id))
    fail(502, "GitHub returned an invalid account");
  return profile.id;
}
async function accessibleInstallations(
  env: Env,
  userId: string,
): Promise<Installation[]> {
  const token = await userToken(env, userId),
    result: Installation[] = [];
  for (let page = 1; page <= 100; page++) {
    const pageResult = await githubRequest<{ installations: Installation[] }>(
      token,
      `/user/installations?per_page=100&page=${page}`,
    );
    result.push(
      ...pageResult.installations.filter(
        (i) =>
          String(i.app_id) === String(env.GITHUB_APP_ID) && !i.suspended_at,
      ),
    );
    if (pageResult.installations.length < 100) return result;
  }
  fail(422, "Too many GitHub installations to synchronize safely");
}
async function saveInstallation(
  env: Env,
  p: Principal,
  i: Installation,
  sessionHash: string,
): Promise<void> {
  const saved = await env.DIRECTORY.prepare(
    "INSERT INTO github_installations (workspace_id,installation_id,user_id,account_login,account_type,repository_selection,updated_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id JOIN sessions s ON s.user_id=u.id WHERE m.workspace_id=? AND m.user_id=? AND m.role='owner' AND u.github_token IS NOT NULL AND s.token_hash=? AND s.expires_at>? AND s.auth_generation=u.auth_generation) ON CONFLICT(workspace_id,installation_id,user_id) DO UPDATE SET account_login=excluded.account_login,account_type=excluded.account_type,repository_selection=excluded.repository_selection,updated_at=excluded.updated_at",
  )
    .bind(
      p.workspaceId,
      i.id,
      p.userId,
      i.account.login,
      i.account.type,
      i.repository_selection,
      Date.now(),
      p.workspaceId,
      p.userId,
      sessionHash,
      Date.now(),
    )
    .run();
  if (!saved.meta.changes)
    fail(401, "Installation session changed. Start again");
}
async function grants(env: Env, workspaceId: string): Promise<Grant[]> {
  return (
    await env.DIRECTORY.prepare(
      "SELECT g.* FROM github_installations g JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id WHERE g.workspace_id=? ORDER BY g.installation_id",
    )
      .bind(workspaceId)
      .all<Grant>()
  ).results;
}
export async function sourceToken(
  env: Env,
  workspaceId: string,
  repository: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    fail(400, "Use a GitHub owner/repository name");
  const [owner, name] = repository.split("/");
  for (const grant of await grants(env, workspaceId)) {
    if (grant.account_login.toLowerCase() !== owner.toLowerCase()) continue;
    try {
      const access = await userToken(env, grant.user_id);
      const repo = await githubRequest<Repository>(
        access,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      );
      const jwt = await appJWT(env);
      const installation = await githubRequest<Installation>(
        jwt,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      );
      if (
        installation.id !== grant.installation_id ||
        installation.suspended_at ||
        String(installation.app_id) !== String(env.GITHUB_APP_ID)
      )
        continue;
      const result = await githubRequest<{ token: string }>(
        jwt,
        `/app/installations/${grant.installation_id}/access_tokens`,
        {
          method: "POST",
          body: JSON.stringify({
            repository_ids: [repo.id],
            permissions: { contents: "read", metadata: "read" },
          }),
        },
      );
      if (!result.token)
        fail(502, "GitHub did not return repository credentials");
      // Recheck the grant after provider I/O so membership removal cannot mint a new credential.
      const stillGranted = await env.DIRECTORY.prepare(
        "SELECT 1 AS ok FROM github_installations g JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id JOIN users u ON u.id=g.user_id WHERE g.workspace_id=? AND g.installation_id=? AND g.user_id=? AND u.github_token IS NOT NULL",
      )
        .bind(workspaceId, grant.installation_id, grant.user_id)
        .first();
      if (!stillGranted) fail(403, "Repository grant was removed");
      return result.token;
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) continue;
      throw error;
    }
  }
  fail(
    403,
    "This repository is not connected to this workspace. Choose repositories in GitHub settings",
  );
}
async function repositories(env: Env, p: Principal): Promise<Response> {
  const repos = new Map<number, Repository>();
  let truncated = false;
  for (const grant of await grants(env, p.workspaceId)) {
    try {
      const token = await userToken(env, grant.user_id);
      for (let page = 1; page <= 20; page++) {
        const result = await githubRequest<{ repositories: Repository[] }>(
          token,
          `/user/installations/${grant.installation_id}/repositories?per_page=100&page=${page}`,
        );
        for (const repo of result.repositories) repos.set(repo.id, repo);
        if (result.repositories.length < 100) break;
        if (page === 20) truncated = true;
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) continue;
      throw error;
    }
  }
  return json({
    repositories: [...repos.values()]
      .map((r) => ({
        id: r.id,
        full_name: r.full_name,
        name: r.name,
        private: r.private,
        default_branch: r.default_branch,
        clone_url: r.clone_url,
        html_url: r.html_url,
        description: r.description,
      }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    truncated,
  });
}
async function status(env: Env, p: Principal): Promise<Response> {
  const user = await env.DIRECTORY.prepare(
    "SELECT github_id,login,github_token IS NOT NULL AS connected FROM users WHERE id=?",
  )
    .bind(p.userId)
    .first<{ github_id: number; login: string; connected: number }>();
  const installations = [
    ...new Map(
      (await grants(env, p.workspaceId)).map((g) => [
        g.installation_id,
        {
          id: g.installation_id,
          account_login: g.account_login,
          account_type: g.account_type,
          repository_selection: g.repository_selection,
        },
      ]),
    ).values(),
  ];
  return json({
    mode: "hosted",
    configured: configured(env),
    name: env.GITHUB_APP_SLUG || null,
    identity: user ? { login: user.login, user_id: user.github_id } : null,
    user_connected: !!user?.connected,
    installations,
  });
}
async function webhook(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 2 * 1024 * 1024) fail(413, "Webhook too large");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 2 * 1024 * 1024) fail(413, "Webhook too large");
  if (
    !(await verifyWebhook(
      env.GITHUB_WEBHOOK_SECRET,
      bytes,
      request.headers.get("x-hub-signature-256") || "",
    ))
  )
    fail(401, "Invalid GitHub webhook signature");
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(400, "Invalid webhook JSON");
  }
  const event = request.headers.get("x-github-event") || "",
    delivery = request.headers.get("x-github-delivery") || "";
  if (!/^[A-Za-z0-9-]{1,100}$/.test(delivery))
    fail(400, "Invalid webhook delivery ID");
  if (event === "ping") return json({ ok: true });
  if (
    event === "github_app_authorization" &&
    payload.action === "revoked" &&
    Number.isSafeInteger(payload.sender?.id)
  ) {
    const revoked = await env.DIRECTORY.prepare(
      "SELECT id FROM users WHERE github_id=?",
    )
      .bind(payload.sender.id)
      .first<{ id: string }>();
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        "DELETE FROM github_installations WHERE user_id IN (SELECT id FROM users WHERE github_id=?)",
      ).bind(payload.sender.id),
      env.DIRECTORY.prepare(
        "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE github_id=?)",
      ).bind(payload.sender.id),
      env.DIRECTORY.prepare(
        "DELETE FROM oauth_flows WHERE user_id IN (SELECT id FROM users WHERE github_id=?)",
      ).bind(payload.sender.id),
      env.DIRECTORY.prepare(
        "UPDATE users SET github_token=NULL,auth_generation=auth_generation+1,revoked_at=? WHERE github_id=?",
      ).bind(Date.now(), payload.sender.id),
    ]);
    if (revoked) await closeUserSockets(env, revoked.id);
    return json({ ok: true });
  }
  const installationId = payload.installation?.id;
  if (!Number.isSafeInteger(installationId))
    return json({ ok: true, ignored: true });
  if (
    event === "installation" &&
    ["deleted", "suspend"].includes(payload.action)
  ) {
    await env.DIRECTORY.prepare(
      "DELETE FROM github_installations WHERE installation_id=?",
    )
      .bind(installationId)
      .run();
    return json({ ok: true });
  }
  if (event !== "push" && event !== "installation_repositories")
    return json({ ok: true, ignored: true });
  const workspaces = (
    await env.DIRECTORY.prepare(
      "SELECT DISTINCT g.workspace_id FROM github_installations g JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id WHERE g.installation_id=?",
    )
      .bind(installationId)
      .all<{ workspace_id: string }>()
  ).results;
  for (const { workspace_id: workspaceId } of workspaces) {
    await env.DIRECTORY.prepare(
      "INSERT OR IGNORE INTO github_deliveries (delivery_id,workspace_id,created_at) VALUES (?,?,?)",
    )
      .bind(delivery, workspaceId, Date.now())
      .run();
    const record = await env.DIRECTORY.prepare(
      "SELECT completed_at FROM github_deliveries WHERE delivery_id=? AND workspace_id=?",
    )
      .bind(delivery, workspaceId)
      .first<{ completed_at: number | null }>();
    if (record?.completed_at) continue;
    const response = await env.WORKSPACES.getByName(workspaceId).fetch(
      "https://workspace.internal/internal/github/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pc-workspace-id": workspaceId,
        },
        body: JSON.stringify({ delivery_id: delivery, event, payload }),
      },
    );
    if (!response.ok)
      fail(
        503,
        "Workspace could not receive GitHub delivery. Retry this webhook",
      );
    await env.DIRECTORY.prepare(
      "UPDATE github_deliveries SET completed_at=? WHERE delivery_id=? AND workspace_id=?",
    )
      .bind(Date.now(), delivery, workspaceId)
      .run();
  }
  await env.DIRECTORY.prepare(
    "DELETE FROM github_deliveries WHERE created_at<? AND completed_at IS NOT NULL",
  )
    .bind(Date.now() - 30 * 86_400_000)
    .run();
  return json({ ok: true });
}
export async function handleGitHub(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname,
    method = request.method;
  if (path === "/api/github/app/webhook" && method === "POST")
    return webhook(request, env);
  if (path === "/api/github/app/installed" && method === "GET") {
    try {
      const flow = await consumeFlow(request, env, "install");
      if (!flow.user_id || !flow.workspace_id)
        fail(401, "Installation session expired");
      const installationId = Number(
        new URL(request.url).searchParams.get("installation_id"),
      );
      const installation = (
        await accessibleInstallations(env, flow.user_id)
      ).find((i) => i.id === installationId);
      if (!installation) return redirectHome(env, "installation");
      await saveInstallation(
        env,
        { userId: flow.user_id, workspaceId: flow.workspace_id },
        installation,
        flow.session_hash!,
      );
      return redirectHome(env, "installed");
    } catch {
      return redirectHome(env, "installation");
    }
  }
  const known = [
    "/api/github/app",
    "/api/github/app/install",
    "/api/github/app/sync",
    "/api/github/repositories",
    "/api/github/app/identity",
  ];
  if (!known.includes(path)) return null;
  const p = await authenticate(request, env);
  if (method !== "GET") assertOrigin(request, env);
  if (path === "/api/github/app" && method === "GET") return status(env, p);
  if (path === "/api/github/repositories" && method === "GET")
    return repositories(env, p);
  if (path === "/api/github/app/install" && method === "POST") {
    await requireWorkspaceOwner(env, p);
    const flow = await startFlow(request, env, "install", p);
    return new Response(
      JSON.stringify({
        url: `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new?state=${encodeURIComponent(flow.state)}`,
      }),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "set-cookie": flow.cookie,
        },
      },
    );
  }
  if (path === "/api/github/app/sync" && method === "POST") {
    await requireWorkspaceOwner(env, p);
    const input = await body(request),
      accessible = await accessibleInstallations(env, p.userId);
    const existing = (await grants(env, p.workspaceId)).filter(
      (g) => g.user_id === p.userId,
    );
    // Sync never silently adds every personal/org installation to another workspace.
    // Explicit selection, or an installation callback, is required for a new grant.
    const ids = Array.isArray(input.installation_ids)
      ? input.installation_ids
      : existing
          .filter((g) => accessible.some((i) => i.id === g.installation_id))
          .map((g) => g.installation_id);
    if (
      ids.some(
        (id) =>
          !Number.isSafeInteger(id) || !accessible.some((i) => i.id === id),
      )
    )
      fail(403, "An installation is not available to this GitHub account");
    const statements = existing
      .filter((g) => !ids.includes(g.installation_id))
      .map((g) =>
        env.DIRECTORY.prepare(
          "DELETE FROM github_installations WHERE workspace_id=? AND installation_id=? AND user_id=?",
        ).bind(p.workspaceId, g.installation_id, p.userId),
      );
    if (statements.length) await env.DIRECTORY.batch(statements);
    for (const installation of accessible.filter((i) => ids.includes(i.id)))
      await saveInstallation(
        env,
        p,
        installation,
        await digest(cookieValue(request, "pc_hosted_session")),
      );
    return json({
      ok: true,
      available_installations: accessible.map((i) => ({
        id: i.id,
        account_login: i.account.login,
        account_type: i.account.type,
        repository_selection: i.repository_selection,
      })),
    });
  }
  if (path === "/api/github/app/identity" && method === "DELETE") {
    // Hosted identity is the login identity. Disconnect sources without orphaning the account.
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        "DELETE FROM github_installations WHERE user_id=?",
      ).bind(p.userId),
      env.DIRECTORY.prepare(
        "UPDATE users SET github_token=NULL WHERE id=?",
      ).bind(p.userId),
      env.DIRECTORY.prepare("DELETE FROM oauth_flows WHERE user_id=?").bind(
        p.userId,
      ),
    ]);
    return json({ ok: true });
  }
  return null;
}
