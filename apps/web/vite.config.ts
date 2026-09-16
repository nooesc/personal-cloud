import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const api = process.env.PC_API_PROXY ?? "http://127.0.0.1:4311";
export default defineConfig(async ({ mode }) => {
  const hosted = mode === "cloudflare";
  const cloudPlugins = hosted
    ? [(await import("@cloudflare/vite-plugin")).cloudflare({ viteEnvironment: { name: "ssr" } })]
    : [];
  return {
    define: { "import.meta.env.VITE_PC_HOSTED": JSON.stringify(hosted ? "true" : "false") },
    plugins: [...cloudPlugins, tanstackStart(), tailwindcss(), react()],
    server: hosted ? undefined : { proxy: {
      "/api": { target: api, ws: true },
      "/install.sh": { target: api },
    } },
  };
});
