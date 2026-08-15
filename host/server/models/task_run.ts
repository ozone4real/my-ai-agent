// Message model — one turn in a Conversation.

import mongoose from "mongoose";
import type {
  Model,
  InferSchemaType,
  HydratedDocument,
} from "mongoose";

export const STATUSES = ["in_progress", "failed", "success"] as const;

const taskRunSchema = new mongoose.Schema(
  {
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true
    },
    status: {
      type: String,
      required: true,
      enum: STATUSES,
      default: "in_progress"
    },
    transcript: {
      type: String
    },
    /**
     * Whether `transcript` has been replaced by an AI-written summary.
     *
     * Every finished run is replayed into the next one, so raw transcripts would
     * grow the prompt without bound. Compacted runs keep the same
     * DeepSeekMessage[] shape — a single assistant message — so loading them
     * needs no special case.
     */
    compacted: {
      type: Boolean,
      required: true,
      default: false
    }
  },
  {
    timestamps: { createdAt: "startedAt", updatedAt: "endedAt" } as const
  }
);

/**
 * One run at a time per task.
 *
 * Concurrent runs of the same task can't see each other, so they duplicate
 * whatever the task does — two runs of a job-application task apply to the same
 * roles twice. This makes the second insert fail rather than relying on the
 * scheduler firing correctly.
 *
 * Partial, so it only applies to `in_progress`: a task accumulates many
 * `success` and `failed` runs and those must stay unconstrained. The filter
 * names `status`, the field on this collection — a path that matches no
 * document (`taskRuns.status`, say) yields an empty index that enforces nothing
 * and reports no error.
 */
taskRunSchema.index(
  { task: 1 },
  {
    name: "one_in_progress_run_per_task",
    unique: true,
    partialFilterExpression: { status: "in_progress" },
  }
);

export type Status = (typeof STATUSES)[number];
export type TaskRun = InferSchemaType<typeof taskRunSchema>;
export type TaskRunDocument = HydratedDocument<TaskRun>;

// Reuse an already-registered model so tsx reloads don't throw OverwriteModelError.
export const TaskRunModel: Model<TaskRun> =
  (mongoose.models.TaskRun as Model<TaskRun>) ??
  mongoose.model<TaskRun>("TaskRun", taskRunSchema);
