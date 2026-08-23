// Settings — one document, app-wide. No user accounts, so it's a singleton:
// the fixed `key` and its unique index are what enforce that under concurrency.

import mongoose from "mongoose";
import type { Model, InferSchemaType, HydratedDocument } from "mongoose";
// The leaf module, not agents/models.js: importing the class maps would pull
// the whole LangChain runtime into anything that reads settings.
import { MODEL_CHOICES, ModelType } from "../agents/model_types.js";
export { MODEL_CHOICES };

/** The one and only settings document. */
const SINGLETON_KEY = "app";

const settingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: SINGLETON_KEY,
      immutable: true,
    },
    /** The user's actual name, for anything that needs it formally. */
    fullName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 200,
    },
    /** What the assistant should call them. Falls back to fullName when blank. */
    preferredName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 100,
    },
    /** Added to the agent's system message every run. */
    instructions: {
      type: String,
      default: "",
      trim: true,
      // Bounded: re-sent on every model call, so it's per-turn cost.
      maxlength: 4000,
    },
    /** Which model new agents use unless a caller overrides it. */
    defaultModel: {
      type: String,
      required: true,
      enum: MODEL_CHOICES,
      default: ModelType.DEEPSEEK_V4_FLASH,
    },
  },
  { timestamps: true }
);

export type Settings = InferSchemaType<typeof settingsSchema>;
export type SettingsDocument = HydratedDocument<Settings>;

// Reuse an already-registered model so tsx reloads don't throw OverwriteModelError.
const SettingsModelBase: Model<Settings> =
  (mongoose.models.Settings as Model<Settings>) ??
  mongoose.model<Settings>("Settings", settingsSchema);

/**
 * The settings document, created with defaults on first use. Upsert rather than
 * find-then-create so concurrent callers can't race into two documents.
 */
export async function loadSettings(): Promise<SettingsDocument> {
  return SettingsModelBase.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $setOnInsert: { key: SINGLETON_KEY } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).exec() as Promise<SettingsDocument>;
}

/** Put every field back to its schema default. */
export async function resetSettings(): Promise<SettingsDocument> {
  await SettingsModelBase.deleteOne({ key: SINGLETON_KEY });
  return loadSettings();
}

export const SettingsModel = SettingsModelBase;
