// Stamp `lastMessageAt` onto conversations created before the field existed.
//
// The list pages on it, and a row without it would sort last and never match a
// cursor — it would drop out of the list entirely. Idempotent, so it runs at
// every startup and does nothing once every row has the field.

import { ConversationModel } from "../models/conversation.js";
import { MessageModel } from "../models/message.js";

export async function backfillLastMessageAt(): Promise<number> {
  // Lean, or Mongoose fills the missing field in from its default.
  const missing = await ConversationModel.find(
    { lastMessageAt: { $exists: false } },
    { _id: 1, createdAt: 1 }
  ).lean();
  if (missing.length === 0) return 0;

  const latest = await MessageModel.aggregate<{ _id: unknown; at: Date }>([
    { $match: { conversation: { $in: missing.map((c) => c._id) } } },
    { $group: { _id: "$conversation", at: { $max: "$createdAt" } } },
  ]);
  const byConversation = new Map(latest.map((l) => [String(l._id), l.at]));

  const { modifiedCount } = await ConversationModel.bulkWrite(
    missing.map((conversation) => ({
      updateOne: {
        // Re-checked, so a message saved since the read above — whose hook has
        // already set the field — isn't overwritten with an older value.
        filter: { _id: conversation._id, lastMessageAt: { $exists: false } },
        update: {
          $set: {
            lastMessageAt:
              byConversation.get(String(conversation._id)) ?? conversation.createdAt,
          },
        },
      },
    }))
  );
  return modifiedCount;
}
