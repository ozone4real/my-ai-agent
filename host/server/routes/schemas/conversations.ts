import z from "zod"

export const createConversationSchema = z.object({
  message: z.string().min(1).max(10000)
})

export const createMessageSchema = z.object({
  message: z.string().min(1).max(10000)
})