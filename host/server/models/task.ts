// Message model — one turn in a Conversation.

import mongoose from "mongoose";
import type {
  Model,
  InferSchemaType,
  HydratedDocument,
} from "mongoose";

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
      required: true
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

// Reuse an already-registered model so tsx reloads don't throw OverwriteModelError.
export const TaskModel: Model<Task> =
  (mongoose.models.Task as Model<Task>) ??
  mongoose.model<Task>("Task", TaskSchema);
