// Conversation model — a chat thread. Carries no fields of its own beyond
// timestamps; the content lives in the Message documents that point at it.

import mongoose from "mongoose";
import type {
  Model,
  InferSchemaType,
  HydratedDocument,
} from "mongoose";

const conversationSchema = new mongoose.Schema(
  {},
  {
    timestamps: true,
    // Expose the `messages` virtual through .toObject()/.toJSON() so a
    // populated conversation serialises with its messages attached.
    toObject: { virtuals: true },
    toJSON: { virtuals: true },
  }
);

// The has-many side. Nothing is stored on the conversation — this reads back
// the Message documents whose `conversation` field points here:
//   Conversation.findById(id).populate("messages")
conversationSchema.virtual("messages", {
  ref: "Message",
  localField: "_id",
  foreignField: "conversation",
  // Oldest first, so a populated thread reads in order. `_id` breaks ties
  // between messages written in the same millisecond.
  options: { sort: { createdAt: 1, _id: 1 } },
});

export type Conversation = InferSchemaType<typeof conversationSchema>;
export type ConversationDocument = HydratedDocument<Conversation>;

// Reuse an already-registered model so tsx reloads don't throw OverwriteModelError.
export const ConversationModel: Model<Conversation> =
  (mongoose.models.Conversation as Model<Conversation>) ??
  mongoose.model<Conversation>("Conversation", conversationSchema);
