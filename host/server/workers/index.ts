// Worker entrypoint: `npm run worker`.
//
// Its own process, so it needs its own Mongo connection — without one mongoose
// buffers and then fails with "tasks.findOne() buffering timed out".

import { connectDB, disconnectDB } from "../db.js";
import { Agent } from "../agents/index.js";
import ApplicationJob from "../jobs/application_job.js";
import AgenticWorker from "./agentic_worker.js";

await connectDB();
console.log("MongoDB connected");

// Connect the MCP servers up front so the first scheduled task doesn't pay the
// 9-28s spawn. Best-effort: a failed warmup is retried by the run itself.
const warming = Date.now();
await Agent.warmup()
  .then(() => console.log(`MCP servers connected in ${Date.now() - warming}ms`))
  .catch((err: unknown) =>
    console.warn(
      `Could not connect the MCP servers; the first task run will retry: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  );

const worker = new AgenticWorker();
worker.run();
console.log("Starting workers");

// Finish the in-flight job rather than leaving it looking stalled.
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, draining…`);
  try {
    await worker.close();
    await ApplicationJob.closeQueues();
    await Agent.shutdown();
    await disconnectDB();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
