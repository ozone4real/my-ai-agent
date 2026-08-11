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

export type Status = (typeof STATUSES)[number];
export type TaskRun = InferSchemaType<typeof taskRunSchema>;
export type TaskRunDocument = HydratedDocument<TaskRun>;

// Reuse an already-registered model so tsx reloads don't throw OverwriteModelError.
export const TaskRunModel: Model<TaskRun> =
  (mongoose.models.TaskRun as Model<TaskRun>) ??
  mongoose.model<TaskRun>("TaskRun", taskRunSchema);
