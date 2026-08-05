// Message model — one turn in a Conversation.

import mongoose from "mongoose";
import type {
  Model,
  InferSchemaType,
  HydratedDocument,
} from "mongoose";

export const AUTHORS = ["user", "assistant"] as const;

const messageSchema = new mongoose.Schema(
  {
    // The belongs-to side of Conversation's `messages` virtual.
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    author: {
      type: String,
      required: true,
      enum: AUTHORS,
    },
    content: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

// Loading a thread means "this conversation's messages, oldest first".
messageSchema.index({ conversation: 1, createdAt: 1 });

export type Author = (typeof AUTHORS)[number];
export type Message = InferSchemaType<typeof messageSchema>;
export type MessageDocument = HydratedDocument<Message>;

// Reuse an already-registered model so tsx reloads don't throw OverwriteModelError.
export const MessageModel: Model<Message> =
  (mongoose.models.Message as Model<Message>) ??
  mongoose.model<Message>("Message", messageSchema);
