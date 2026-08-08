// Wire shapes for Settings, in both directions.
//
// Same arrangement as the task serializer: one definition of what goes out and
// one of what may be changed, shared by every caller so they can't drift.

import { z } from "zod";
import { ModelType } from "../agents/index.js";
import { MODEL_CHOICES, type SettingsDocument } from "../models/settings.js";

export const settingsShape = z.object({
  fullName: z.string().describe("The user's full name"),
  preferredName: z.string().describe("What the assistant should call them"),
  instructions: z.string().describe("Standing instructions for the assistant"),
  defaultModel: z.string().describe("Model new agents use unless overridden"),
  updatedAt: z.string().describe("ISO 8601 last-modified timestamp"),
});

/** The models the UI may offer — sent alongside so it never hardcodes a list. */
export const settingsResponseShape = settingsShape.extend({
  availableModels: z.array(z.string()).describe("Valid values for defaultModel"),
});

export type SerializedSettings = z.infer<typeof settingsResponseShape>;

export const serializeSettings = (settings: SettingsDocument): SerializedSettings => ({
  fullName: settings.fullName ?? "",
  preferredName: settings.preferredName ?? "",
  instructions: settings.instructions ?? "",
  defaultModel: settings.defaultModel,
  updatedAt: settings.updatedAt.toISOString(),
  availableModels: [...MODEL_CHOICES],
});

/**
 * The changeable surface. Every field optional so a caller can send one without
 * restating the rest; empty strings are meaningful (they clear a value), which
 * is why there's no `.min(1)` on the free-text fields.
 */
export const settingsUpdateShape = z
  .object({
    fullName: z.string().max(200).optional(),
    preferredName: z.string().max(100).optional(),
    instructions: z.string().max(4000).optional(),
    defaultModel: z.enum(MODEL_CHOICES as [ModelType, ...ModelType[]]).optional(),
  })
  .refine((update) => Object.keys(update).length > 0, {
    message: "Provide at least one of fullName, preferredName, instructions or defaultModel",
  });

export type SettingsUpdate = z.infer<typeof settingsUpdateShape>;

export const applySettingsUpdate = (
  settings: SettingsDocument,
  update: SettingsUpdate
): void => {
  if (update.fullName !== undefined) settings.fullName = update.fullName;
  if (update.preferredName !== undefined) settings.preferredName = update.preferredName;
  if (update.instructions !== undefined) settings.instructions = update.instructions;
  if (update.defaultModel !== undefined) settings.defaultModel = update.defaultModel;
};
