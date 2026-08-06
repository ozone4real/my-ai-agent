import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The agent's HTTP server (host/server). Override with AGENT_URL.
// In dev these paths are proxied there so the browser has no CORS issues —
// anything not listed here is served by Vite itself and 404s.
const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:8080";

export default defineConfig({
  // Config lives in host/, so root defaults to this directory.
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Only /api is proxied. Paths like /conversations/:id are UI routes and
      // must reach index.html, which Vite's SPA fallback handles.
      "/api": {
        target: AGENT_URL,
        changeOrigin: true,
      },
      "/health": {
        target: AGENT_URL,
        changeOrigin: true,
      },
    },
  },
});
