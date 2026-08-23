// Conversation model — a chat thread. Carries no fields of its own beyond
// timestamps; the content lives in the Message documents that point at it.

import mongoose from "mongoose";
import type {
  Model,
  InferSchemaType,
  HydratedDocument,
} from "mongoose";
// The leaf module: importing agents/models.js would pull LangChain in behind it.
import { MODEL_CHOICES } from "../agents/model_types.js";

const conversationSchema = new mongoose.Schema(
  {
    /**
     * Model this thread currently runs on. Unset means Settings decides.
     *
     * Named `agentModel`, not `model`: a schema path called `model` shadows
     * Mongoose's own `doc.model()`, which populate and the hooks rely on. The
     * API still calls it `model`.
     *
     * Per thread rather than per message: a turn can change it, and every turn
     * after that follows. Replay is unaffected — messages are stored as plain
     * role/content and converted to whichever provider serves the next turn.
     */
    agentModel: {
      type: String,
      required: false,
      enum: MODEL_CHOICES,
    },
  },
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
