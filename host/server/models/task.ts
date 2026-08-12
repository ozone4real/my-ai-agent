// Task model — a prompt the agent runs on a cron schedule.

import mongoose from "mongoose";
import type {
  Model,
  InferSchemaType,
  HydratedDocument,
} from "mongoose";
import { CronExpressionParser } from "cron-parser";
import ApplicationJob from "../jobs/application_job.js";

export const CREATORS = ["user", "assistant"] as const;

const TaskSchema = new mongoose.Schema(
  {
    // The belongs-to side of Conversation's `Tasks` virtual.
    sourceConversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: false
    },
    creator: {
      type: String,
      required: true,
      enum: CREATORS,
    },
    prompt: {
      type: String,
      required: true,
    },
    schedule: {
      type: String,
      required: true,
      // Validated here, not in the post-save hook: BullMQ rejects a bad cron
      // only after the row is written. cron-parser is what BullMQ parses with,
      // so this accepts exactly what the scheduler will.
      validate: {
        validator: (value: string) => {
          try {
            CronExpressionParser.parse(value);
            return true;
          } catch {
            return false;
          }
        },
        message: (props: { value: string }) =>
          `"${props.value}" is not a valid cron expression`,
      },
    },
    limit: {
      type: Number,
      required: false
    }
  },
  { timestamps: true }
);

export type Creator = (typeof CREATORS)[number];
export type Task = InferSchemaType<typeof TaskSchema>;
export type TaskDocument = HydratedDocument<Task>;

/**
 * Keep the BullMQ scheduler in step with the row. Keyed on the task id, so an
 * edit replaces the scheduler rather than adding a second one.
 */
// `isNew` is already false by the time post-save runs, so remember it here.
TaskSchema.pre('save', function () {
  this.$locals.wasNew = this.isNew;
});

TaskSchema.post('save', async function (task: TaskDocument) {
  // Imported here, not at the top: agentic_job pulls in the whole agent runtime
  // (LangChain, MCPClient), and the app MCP server imports this model without
  // ever running an agent.
  const { default: AgenticJob } = await import("../jobs/agentic_job.js")

  try {
    await ApplicationJob.withRedisTimeout(new AgenticJob().queue.upsertJobScheduler(
      String(task._id),
      { pattern: task.schedule, ...(task.limit ? { limit: task.limit } : {}) },
      {
        name: AgenticJob.jobName,
        // Without this the job fires with `data: {}`, so the worker looks up
        // `undefined`, finds nothing, and the task silently never runs.
        data: { taskId: String(task._id) },
      }
    ))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)

    // Mongo and Redis can't commit atomically, so this compensates instead —
    // and what that means differs by case.
    if (task.$locals.wasNew) {
      // A task that exists but never fires is worse than no task. Query-level
      // delete so the document hook below doesn't retry Redis and fail again.
      await TaskModel.deleteOne({ _id: task._id })
      throw new Error(`Could not schedule task, so it was not created: ${reason}`)
    }

    // An update keeps the user's new values — rolling back would need the
    // previous ones, which we no longer have. reconcileTaskSchedulers() repairs
    // the stale schedule once Redis is back.
    throw new Error(
      `Task updated, but its schedule could not be applied and is now stale: ${reason}`
    )
  }
});

/**
 * Drop the scheduler with the task, or it fires forever against nothing.
 *
 * Document middleware, so it covers `task.deleteOne()` — both real delete
 * paths. Bulk `deleteMany` does NOT run this and still orphans schedulers.
 */
TaskSchema.post('deleteOne', { document: true, query: false }, async function (this: TaskDocument) {
  const { default: AgenticJob } = await import("../jobs/agentic_job.js")
  await ApplicationJob.withRedisTimeout(
    new AgenticJob().queue.removeJobScheduler(String(this._id))
  )
});

// Reuse an already-registered model so tsx reloads don't throw OverwriteModelError.
export const TaskModel: Model<Task> =
  (mongoose.models.Task as Model<Task>) ??
  mongoose.model<Task>("Task", TaskSchema);
