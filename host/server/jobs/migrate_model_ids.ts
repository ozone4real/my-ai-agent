// Rewrite stored versioned model ids to their family: "claude-opus-5-5" ->
// "claude-opus".
//
// Rows saved before families existed would otherwise fail enum validation on
// their next save, and the agent couldn't look them up. Idempotent, so it runs
// at every startup and does nothing once every row holds a family.

import type { Model } from "mongoose";
import { familyOf } from "../agents/model_types.js";
import { ConversationModel } from "../models/conversation.js";
import { SettingsModel } from "../models/settings.js";
import { TaskModel } from "../models/task.js";

async function migrateField(model: Model<any>, field: string): Promise<number> {
  const ids: string[] = await model.distinct(field)
  let migrated = 0
  for (const id of ids) {
    const family = familyOf(id)
    if (!family || family === id) continue
    const { modifiedCount } = await model.updateMany({ [field]: id }, { $set: { [field]: family } })
    migrated += modifiedCount
  }
  return migrated
}

export async function migrateModelIds(): Promise<number> {
  const counts = await Promise.all([
    migrateField(SettingsModel, "defaultModel"),
    migrateField(ConversationModel, "agentModel"),
    migrateField(TaskModel, "agentModel"),
  ])
  return counts.reduce((sum, count) => sum + count, 0)
}
