// Stub /chat server — a throwaway stand-in for your real agent.
//
// It speaks the same SSE contract the React interface expects, so you can watch
// the UI stream end-to-end before wiring up mcp-use. Delete this once your agent
// exposes POST /chat.
//
//   npm run web:stub      (runs via tsx)
//
// Then `npm run web` and send a message — you'll see tool chips + streamed tokens.

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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

// Mounted under /api so the UI's own routes (/conversations/:id, /tasks/:id)
// can be real browser URLs. Without this the dev proxy forwards those paths to
// the API and a refresh renders JSON instead of the app.
app.use("/api", router)
// Kept for anything already calling the bare paths (curl, the MCP smoke tests).
app.use(router)

connectDB()
  .then(async () => {
    console.log("MongoDB connected");
    // Repair any scheduler drift from a previous Redis outage or a bulk delete.
    // Best-effort: if Redis is down the app still serves, and the next start
    // (or a manual call) will reconcile.
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
 * Bring up this project's own MCP server alongside the host.
 *
 * The agent lists it in servers_definition, and unlike the stdio servers (which
 * are spawned per session) an HTTP one has to already be listening — if it
 * isn't, `createAllSessions` throws on the first connect and **every** agent
 * turn fails, not just the task tools. Starting it here means that can't happen
 * by forgetting to run a second process.
 *
 * EADDRINUSE is fine and expected: it means `npm run app-mcp` already owns the
 * port, and that instance satisfies the agent just as well.
 */
async function startAppMcpServer() {
  const url = new URL(process.env.APP_MCP_URL ?? "http://localhost:3001/mcp");
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

app.listen(PORT, () => {
  console.log(`Stub /chat server on http://localhost:${PORT}`);
  console.log(`  POST /chat  { "prompt": "..." }  → SSE stream (or JSON)`);
  console.log(`Run \`npm run web\` and send a message.`);
});
