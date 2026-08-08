// The host server: REST API under /api, and the built UI when host/dist exists.
//
//   npm run web:server

import { existsSync } from "node:fs";
import path from "node:path";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { Agent } from "./agents";
import { connectDB } from "./db";
import { reconcileTaskSchedulers } from "./jobs/reconcile_schedulers.js";
import router from "./routes"
import SseStream from "./services/sse_stream";

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
app.use(express.json());
const agent = new Agent()

// Basic CORS (harmless; the Vite proxy means the browser calls same-origin).
app.use((req: Request, res: Response, next: NextFunction) => {
  res.set("access-control-allow-origin", "*");
  res.set("access-control-allow-headers", "content-type, accept");
  res.set("access-control-allow-methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, stub: true });
});

// /api only — a root mount would answer the UI's own routes (/tasks,
// /conversations/:id) with JSON before the SPA catch-all sees them.
app.use("/api", router)

connectDB()
  .then(async () => {
    console.log("MongoDB connected");
    // Repair scheduler drift from an outage or bulk delete. Best-effort.
    try {
      const { added, updated, removed } = await reconcileTaskSchedulers();
      if (added || updated || removed) {
        console.log(
          `Schedulers reconciled: ${added} added, ${updated} updated, ${removed} removed`
        );
      }
    } catch (err) {
      console.warn(
        `Could not reconcile task schedulers (is Redis up?): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  })

/**
 * Start the app MCP server alongside the host.
 *
 * Unlike the stdio servers it must already be listening — otherwise
 * `createAllSessions` throws and *every* agent turn fails, not just task tools.
 * EADDRINUSE just means `npm run app-mcp` already owns the port.
 */
async function startAppMcpServer() {
  // Its own service in Docker; this copy must stay off or you get two.
  if (process.env.START_APP_MCP === "false") {
    console.log("Application MCP Server: expected as a separate service");
    return;
  }

  const url = new URL(process.env.APP_MCP_URL ?? "http://localhost:8000/mcp");
  const port = Number(url.port || 80);
  try {
    const { default: appMcp } = await import("../../mcp_servers/index.js");
    await appMcp.listen(port);
    console.log(`Application MCP Server on ${url.origin}/mcp`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      console.log(`Application MCP Server already running on ${url.origin}/mcp`);
      return;
    }
    console.warn(
      `Application MCP Server failed to start — the agent's task tools will be ` +
        `unavailable and agent runs will fail until it is up: ${
          err instanceof Error ? err.message : String(err)
        }`
    );
  }
}

void startAppMcpServer();

// Serve the built SPA when it exists; in dev Vite does this instead.
const spaDir = path.resolve(import.meta.dirname, "../dist");
if (existsSync(path.join(spaDir, "index.html"))) {
  app.use(express.static(spaDir));
  // Client-side routes. /api is handled above, so this can't shadow it.
  app.get(/.*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(spaDir, "index.html"));
  });
  console.log(`Serving UI from ${spaDir}`);
}

app.listen(PORT, () => {
  console.log(`Host server on http://localhost:${PORT}`);
});
