// Make BullMQ's schedulers match the Task collection.
//
// Mongo is the source of truth; Redis holds derived state that drifts when the
// two can't be written together — an outage mid-edit, a bulk deleteMany that
// bypassed the document hook, or Redis losing its data. Run at startup.

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

    // BullMQ reports an absent limit as null, the model as undefined.
    // The name is compared too: a scheduler written under an old job name fires
    // on time but dispatches to nothing, and comparing only the pattern would
    // leave that broken scheduler in place forever.
    const matches =
      current?.pattern === wanted.pattern &&
      (current?.limit ?? undefined) === wanted.limit &&
      current?.name === AgenticJob.jobName;

    if (!matches) {
      await queue.upsertJobScheduler(
        id,
        { pattern: wanted.pattern, ...(wanted.limit ? { limit: wanted.limit } : {}) },
        { name: AgenticJob.jobName, data: { taskId: id } }
      );
      if (current) result.updated++;
      else result.added++;
    }

    existing.delete(id);
  }

  // Whatever's left has no task behind it.
  for (const key of existing.keys()) {
    await queue.removeJobScheduler(key);
    result.removed++;
  }

  return result;
}
