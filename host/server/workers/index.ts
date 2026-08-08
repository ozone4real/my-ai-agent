// Worker entrypoint: `npm run worker`.
//
// Its own process, so it needs its own Mongo connection — without one mongoose
// buffers and then fails with "tasks.findOne() buffering timed out".

import { connectDB, disconnectDB } from "../db.js";
import ApplicationJob from "../jobs/application_job.js";
import AgenticWorker from "./agentic_worker.js";

await connectDB();
console.log("MongoDB connected");

const worker = new AgenticWorker();
worker.run();
console.log("Starting workers");

// Finish the in-flight job rather than leaving it looking stalled.
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
