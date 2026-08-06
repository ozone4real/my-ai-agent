// Make BullMQ's schedulers match the Task collection.
//
// Mongo is the source of truth; the schedulers in Redis are derived state that
// can drift whenever the two can't be written together:
//
//   - Redis was down while a task was edited, so its cron is stale
//   - a bulk `TaskModel.deleteMany(...)` bypassed the document delete hook,
//     leaving schedulers firing for tasks that no longer exist
//   - Redis lost its data
//
// Running this at startup (and after an outage) repairs all of those without
// anyone having to notice.

import { underscore } from "inflection";
import AgenticJob from "./agentic_job.js";
import { TaskModel } from "../models/task.js";

export interface ReconcileResult {
  added: number;
  updated: number;
  removed: number;
}

export async function reconcileTaskSchedulers(): Promise<ReconcileResult> {
  const queue = new AgenticJob().queue;
  const [tasks, schedulers] = await Promise.all([
    TaskModel.find(),
    queue.getJobSchedulers(),
  ]);

  const existing = new Map(schedulers.map((s) => [String(s.key), s]));
  const result: ReconcileResult = { added: 0, updated: 0, removed: 0 };

  for (const task of tasks) {
    const id = String(task._id);
    const current = existing.get(id);
    const wanted = { pattern: task.schedule, limit: task.limit ?? undefined };

    // `?? undefined` on both sides: BullMQ reports an absent limit as null,
    // the model as undefined, and those mean the same thing here.
    const matches =
      current?.pattern === wanted.pattern &&
      (current?.limit ?? undefined) === wanted.limit;

    if (!matches) {
      await queue.upsertJobScheduler(
        id,
        { pattern: wanted.pattern, ...(wanted.limit ? { limit: wanted.limit } : {}) },
        { name: underscore(AgenticJob.name), data: { taskId: id } }
      );
      if (current) result.updated++;
      else result.added++;
    }

    existing.delete(id);
  }

  // Whatever is left has no task behind it.
  for (const key of existing.keys()) {
    await queue.removeJobScheduler(key);
    result.removed++;
  }

  return result;
}
