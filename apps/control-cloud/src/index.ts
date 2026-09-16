import type { Env } from "./env";
import { authenticate, handleAuth, cookieValue } from "./auth";
import { digest } from "./auth/crypto";
import { sha256 } from "./crypto";
import { boundedText, fail, HttpError, json } from "./core";
import { handleMigration } from "./migration";
import { handleRegistry } from "./registry";
import installer from "../../../scripts/install.sh";
export { Workspace } from "./workspace";
export { RegistryUpload } from "./registry";
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health")
        return json({ status: "ok", mode: "hosted", version: "0.3.0" });
      if (url.pathname === "/install.sh")
        return new Response(installer, {
          headers: {
            "Content-Type": "text/x-shellscript",
            "Cache-Control": "public, max-age=300",
          },
        });
      if (url.pathname.startsWith("/internal/"))
        return json({ error: "Not found" }, 404);
      if (url.pathname.startsWith("/v2/") || url.pathname === "/v2")
        return await handleRegistry(request, env);
      const migration = await handleMigration(request, env);
      if (migration) return migration;
      if (request.body) {
        const value = await boundedText(request);
        request = new Request(request, { body: value });
      }
      if (
        request.headers.get("Origin") &&
        request.headers.get("Origin") !== new URL(env.PUBLIC_URL).origin
      )
        fail(403, "Request origin is not allowed");
      const authResponse = await handleAuth(request, env);
      if (authResponse) return authResponse;
      let workspaceId: string,
        userId: string | null = null,
        machineId: string | null = null;
      if (url.pathname === "/api/agent/enroll") {
        const input = (await request.clone().json()) as { token?: unknown };
        if (typeof input.token !== "string" || input.token.length > 256)
          fail(401, "Enrollment token required");
        const route = await env.DIRECTORY.prepare(
          "SELECT workspace_id FROM enrollment_routes WHERE token_hash=? AND expires_at>?",
        )
          .bind(await sha256(input.token), Date.now())
          .first<{ workspace_id: string }>();
        if (!route) fail(401, "Enrollment token expired");
        workspaceId = route.workspace_id;
      } else if (url.pathname.startsWith("/api/agent/")) {
        machineId = url.pathname.split("/")[3];
        const route = await env.DIRECTORY.prepare(
          "SELECT workspace_id FROM machine_routes WHERE id=?",
        )
          .bind(machineId)
          .first<{ workspace_id: string }>();
        if (!route) fail(401, "Machine authentication required");
        workspaceId = route.workspace_id;
      } else {
        const principal = await authenticate(request, env);
        workspaceId = principal.workspaceId;
        userId = principal.userId;
      }
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()])
        if (key.startsWith("x-pc-")) headers.delete(key);
      headers.set("x-pc-workspace-id", workspaceId);
      if (userId) {
        headers.set("x-pc-user-id", userId);
        headers.set(
          "x-pc-session-hash",
          await digest(cookieValue(request, "pc_hosted_session")),
        );
      }
      if (machineId) headers.set("x-pc-machine-id", machineId);
      return await env.WORKSPACES.getByName(workspaceId).fetch(
        new Request(request, { headers }),
      );
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.message }, error.status);
      console.error(
        "hosted request failed",
        error instanceof Error ? error.name : "unknown",
      );
      return json({ error: "Request failed" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
