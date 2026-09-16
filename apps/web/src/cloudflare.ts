import handler from "@tanstack/react-start/server-entry";

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/") || path === "/install.sh" || path === "/v2" || path.startsWith("/v2/")) {
      // Forward the original URL, cookies and streaming body, including WebSocket upgrades.
      // Tenant identity is validated by the control plane, never asserted by the web worker.
      return env.CONTROL_PLANE.fetch(request);
    }
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
