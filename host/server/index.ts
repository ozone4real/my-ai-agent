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
import { Agent } from "./agent";
import { connectDB } from "./db";
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

app.use(router)

// app.post("/chat", async (req: Request, res: Response) => {
//   const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
//   // Stream if the client asked for SSE; otherwise return plain JSON.
//   const wantsStream = (req.headers.accept ?? "").includes("text/event-stream");
//   if (!wantsStream) {
//     const reply = await agent.run(prompt);
//     res.json({ result: reply });
//     return;
//   }

//   res.set({
//     "content-type": "text/event-stream",
//     "cache-control": "no-cache",
//     connection: "keep-alive",
//   });
//   res.flushHeaders();

//   const send = (event: string, data: unknown) =>
//     res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

//   // Stop streaming if the client disconnects (e.g. the Stop button).
//   // NOTE: listen on `res`, not `req`. `req`'s "close" fires as soon as
//   // express.json() finishes consuming the (fully-buffered) request body, so it is
//   // NOT a disconnect signal. `res`'s "close" fires only when the socket actually
//   // goes away; `writableFinished` guards against our own res.end() triggering it.
//   let aborted = false;
//   res.on("close", () => {
//     if (!res.writableFinished) aborted = true;
//   });

//   try {
//     const streamCallback = (output: string) => send("token", { text: output })
//     await agent.stream(prompt, streamCallback)

//     if (!aborted) send("done", {});
//   } catch {
//     if (!aborted) send("error", { message: "Stub server error" });
//   } finally {
//     res.end();
//   }
// });

// Mongo isn't on the /chat path yet, so a failed connection warns instead of
// aborting boot. Once a route actually reads or writes users, move this above
// app.listen() and let a rejection exit the process.
connectDB()
  .then(() => console.log("MongoDB connected"))

app.listen(PORT, () => {
  console.log(`Stub /chat server on http://localhost:${PORT}`);
  console.log(`  POST /chat  { "prompt": "..." }  → SSE stream (or JSON)`);
  console.log(`Run \`npm run web\` and send a message.`);
});
