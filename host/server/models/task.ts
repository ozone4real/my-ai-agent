// Task model — a prompt the agent runs on a cron schedule.

import mongoose from "mongoose";
import type {
  Model,
  InferSchemaType,
  HydratedDocument,
} from "mongoose";
import { CronExpressionParser } from "cron-parser";
import AgenticJob from "../jobs/agentic_job.js";
import ApplicationJob from "../jobs/application_job.js";
import { underscore } from "inflection";

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
      // Validated here, not in the post-save hook. BullMQ rejects a bad cron
      // when the scheduler is upserted — but by then the row is already
      // written, so the caller gets an error for a task that exists and will
      // never run. As a validator it fails before anything is persisted.
      // cron-parser is what BullMQ itself parses with, so this accepts exactly
      // what the scheduler will.
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
 * Keep the BullMQ scheduler in step with the row.
 *
 * `upsertJobScheduler` is keyed on the task id, so this covers creation and
 * every later edit: change the cron or the limit and the existing scheduler is
 * replaced rather than duplicated.
 */
// `isNew` is already false by the time post-save runs, so remember it here.
TaskSchema.pre('save', function () {
  this.$locals.wasNew = this.isNew;
});

TaskSchema.post('save', async function (task: TaskDocument) {
  try {
    await ApplicationJob.withRedisTimeout(new AgenticJob().queue.upsertJobScheduler(
      String(task._id),
      { pattern: task.schedule, ...(task.limit ? { limit: task.limit } : {}) },
      {
        name: underscore(AgenticJob.name),
        // WITHOUT THIS the scheduler fires with `data: {}`, so the worker's
        // `TaskModel.findById(job.data.taskId)` looks up `undefined`, finds
        // nothing, and returns — the task silently never runs.
        data: { taskId: String(task._id) },
      }
    ))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)

    // Mongo and Redis can't be committed atomically — this deployment is a
    // standalone mongod, so there aren't even Mongo transactions to commit
    // last. The best available is a compensating action, and what that should
    // be differs by case.
    if (task.$locals.wasNew) {
      // A task that exists but will never fire is worse than no task: the user
      // is told it is scheduled and it silently never runs. Undo the insert.
      // Query-level delete on purpose — `task.deleteOne()` would fire the
      // document hook below and try Redis again, failing the same way.
      await TaskModel.deleteOne({ _id: task._id })
      throw new Error(`Could not schedule task, so it was not created: ${reason}`)
    }

    // An update is different: the row now holds the user's new values and
    // those are worth keeping. Rolling back would mean restoring the previous
    // values, which we no longer have. Leave it, be explicit that the schedule
    // is stale, and let reconcileTaskSchedulers() repair it once Redis is back.
    throw new Error(
      `Task updated, but its schedule could not be applied and is now stale: ${reason}`
    )
  }
});

/**
 * Drop the scheduler when the task goes.
 *
 * Document middleware, which covers `task.deleteOne()` — the path both the REST
 * route and the delete-task tool use. Left behind, a scheduler keeps firing on
 * its cron forever against a task that no longer exists.
 *
 * NOTE: query middleware (`TaskModel.deleteMany(...)`, `findOneAndDelete`) does
 * not run this. Bulk deletes still orphan their schedulers.
 */
TaskSchema.post('deleteOne', { document: true, query: false }, async function (this: TaskDocument) {
  await ApplicationJob.withRedisTimeout(
    new AgenticJob().queue.removeJobScheduler(String(this._id))
  )
});

// Reuse an already-registered model so tsx reloads don't throw OverwriteModelError.
export const TaskModel: Model<Task> =
  (mongoose.models.Task as Model<Task>) ??
  mongoose.model<Task>("Task", TaskSchema);
