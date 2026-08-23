import z from "zod"
import { MODEL_CHOICES, ModelType } from "../../agents/model_types.js"

/** Omit `model` to use the app default. */
export const createConversationSchema = z.object({
  message: z.string().min(1).max(1000000),
  model: z.enum(MODEL_CHOICES as [ModelType, ...ModelType[]]).optional(),
})

export const createMessageSchema = z.object({
  message: z.string().min(1).max(1000000),
  /**
   * Switch the thread to this model, from this turn on. Omit to keep whatever
   * it is already using.
   *
   * Safe mid-thread: history is stored as plain role/content and converted to
   * the target provider's shape on replay, so the new model reads the whole
   * conversation as its own.
   */
  model: z.enum(MODEL_CHOICES as [ModelType, ...ModelType[]]).optional(),
})
