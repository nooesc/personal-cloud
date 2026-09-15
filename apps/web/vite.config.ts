import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [tanstackStart(), react()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:4311", ws: true },
      "/install.sh": { target: "http://127.0.0.1:4311" },
    },
  },
});
