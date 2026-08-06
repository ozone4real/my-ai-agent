// Worker entrypoint.
//
//   npm run worker
//
// Separate process from the host server, so it needs its own Mongo connection:
// mongoose buffers model calls until one exists and then rejects with
// "Operation `tasks.findOne()` buffering timed out after 10000ms" — which is
// what you get if this file just starts the worker and nothing else.

import { connectDB, disconnectDB } from "../db.js";
import ApplicationJob from "../jobs/application_job.js";
import AgenticWorker from "./agentic_worker.js";

await connectDB();
console.log("MongoDB connected");

const worker = new AgenticWorker();
worker.run();
console.log("Starting workers");

// Finish the job in flight rather than dropping it mid-run, and let Redis and
// Mongo close cleanly so the job isn't left looking stalled.
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, draining…`);
  try {
    await worker.close();
    await ApplicationJob.closeQueues();
    await disconnectDB();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
