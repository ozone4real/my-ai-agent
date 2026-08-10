import { Router } from "express"
import type { Request, Response } from "express"
import { Conversation, ConversationModel } from "../models/conversation"
import { createConversationSchema, createMessageSchema } from "./schemas/conversations"
import { Author, Message, MessageDocument, MessageModel } from "../models/message"
import { Agent, AgentMessage, AgentStreamEventPayload, AgentStreamPayload } from "../agents";
import SSEStream from "../services/sse_stream"
import { ClientSession, Document, Types } from "mongoose"

const router = Router()


const createMessage = async(content: string, conversation: Document, session: ClientSession | null, author: string = "user") => {
  const message = new MessageModel({ author, content, conversation: conversation._id })
  return await message.save({ session: session })
}

// NOTE: this was a db.transaction(), but transactions need a replica set and the
// local mongod is standalone, so the callback always rejected — and because the
// call wasn't awaited it surfaced as an unhandled rejection rather than an error
// here. Sequential saves for now; restore the transaction once Mongo runs as a
// replica set (and pass `session` through to createMessage so both saves share it).
const createConversation = async (content: string) => {
  const conversation = new ConversationModel({})
  await conversation.save()
  await createMessage(content, conversation, null)
  return conversation
}

const serializeMessage = (message: MessageDocument) => ({
  id: String(message._id),
  author: message.author as Author,
  content: message.content,
  createdAt: message.createdAt,
})

// Newest thread first — the list is a "pick up where you left off" view.
router.get("/", async (_req: Request, res: Response) => {
  const conversations = await ConversationModel.find().sort({ createdAt: -1 })

  // One grouped query, so the list is two round trips regardless of size.
  const summaries = await MessageModel.aggregate<{
    _id: Types.ObjectId
    messageCount: number
    preview: string
    lastMessageAt: Date
  }>([
    { $sort: { conversation: 1, createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: "$conversation",
        messageCount: { $sum: 1 },
        // The opening message doubles as the thread's title.
        preview: { $first: "$content" },
        lastMessageAt: { $last: "$createdAt" },
      },
    },
  ])

  const byConversation = new Map(summaries.map((s) => [String(s._id), s]))

  res.json({
    conversations: conversations.map((conversation) => {
      const summary = byConversation.get(String(conversation._id))
      return {
        id: String(conversation._id),
        createdAt: conversation.createdAt,
        messageCount: summary?.messageCount ?? 0,
        preview: summary?.preview ?? "",
        // Falls back to createdAt so a thread with no messages still sorts sanely.
        lastMessageAt: summary?.lastMessageAt ?? conversation.createdAt,
      }
    }),
  })
})

router.get("/:conversation_id", async (req: Request, res: Response) => {
  // A non-ObjectId would make findById throw a CastError, i.e. a 500.
  const conversationId = String(req.params.conversation_id)
  if (!Types.ObjectId.isValid(conversationId)) {
    res.status(404).json({ error: "Conversation not found" })
    return
  }

  const conversation = await ConversationModel
    .findById(conversationId)
    .populate<{ messages: MessageDocument[] }>("messages")

  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" })
    return
  }

  res.json({
    id: String(conversation._id),
    createdAt: conversation.createdAt,
    messages: conversation.messages.map(serializeMessage),
  })
})

router.delete("/:conversation_id", async (req: Request, res: Response) => {
  const conversationId = String(req.params.conversation_id)
  if (!Types.ObjectId.isValid(conversationId)) {
    res.status(404).json({ error: "Conversation not found" })
    return
  }

  const conversation = await ConversationModel.findById(conversationId)
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" })
    return
  }

  // The `messages` virtual is the only way to reach them.
  const { deletedCount } = await MessageModel.deleteMany({ conversation: conversation._id })
  await conversation.deleteOne()

  // Tasks are left alone; `sourceConversation` is optional provenance.
  res.json({
    id: String(conversation._id),
    deleted: true,
    deletedMessages: deletedCount ?? 0,
  })
})

router.post("/", async (req: Request, res: Response) => {
  const params = createConversationSchema.parse(req.body)
  const conversation = await createConversation(params.message)

  const agent = await Agent.withSettings({ conversationId: String(conversation._id) })
  if(!SSEStream.wantsStream(req)) {
    const reply = await agent.run(params.message)
    await createMessage(reply, conversation, null, "assistant")
    // Without this return the handler fell through and `new SSEStream(req)`
    // threw, after the response had already been sent.
    res.json({ conversationId: conversation._id, reply })
    return
  }

  const sse = new SSEStream(req)
  // Bound, or `this` is undefined inside the generator. `input` is spread as
  // the generator's arguments, so it must be an argument list.
  await sse.stream(res, [params.message], agent.streamEvents.bind(agent), async (data: AgentStreamEventPayload | undefined) => {
     // Only the terminal payload carries the reply text; "working" payloads are steps.
    if (data?.phase !== "done") return
    await createMessage(String(data.content), conversation, null, "assistant")
  }, { conversationId: String(conversation._id) })
})

router.post("/:conversation_id/messages", async(req: Request, res: Response) => {
  const params = createMessageSchema.parse(req.body)

  const conversationId = String(req.params.conversation_id)
  if (!Types.ObjectId.isValid(conversationId)) {
    res.status(404).json({ error: "Conversation not found" })
    return
  }

  // The generic types the `messages` virtual, which isn't in the inferred type.
  const conversation = await ConversationModel
    .findById(conversationId)
    .populate<{ messages: MessageDocument[] }>("messages")

  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" })
    return
  }

  // Must be read before the save below, or the incoming message lands in the
  // history *and* is passed as the prompt.
  const history: AgentMessage[] = conversation.messages.map((message: Message) => ({
    // InferSchemaType widens the enum to `string`; the schema restricts it to AUTHORS.
    role: message.author as Author,
    content: message.content,
  }))

  await createMessage(params.message, conversation, null)

  const agent = await Agent.withSettings({ conversationId: String(conversation._id) })
  if (!SSEStream.wantsStream(req)) {
    const reply = await agent.run(params.message, history)
    await createMessage(reply, conversation, null, "assistant")
    res.json({ conversationId: conversation._id, reply })
    return
  }

  const sse = new SSEStream(req)

  await sse.stream(res, [params.message, history], agent.streamEvents.bind(agent), async (data: AgentStreamEventPayload | undefined) => {
     // Only the terminal payload carries the reply text; "working" payloads are steps.
    if (data?.phase !== "done") return
    await createMessage(String(data.content), conversation, null, "assistant")
  })
})

export default router