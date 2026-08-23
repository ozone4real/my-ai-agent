import { Router } from "express"
import type { Request, Response } from "express"
import { Conversation, ConversationModel } from "../models/conversation"
import { createConversationSchema, createMessageSchema } from "./schemas/conversations"
import { Author, Message, MessageDocument, MessageModel } from "../models/message"
import { Agent, AgentMessage, AgentStreamEventPayload, AgentStreamPayload } from "../agents";
import type { ModelType } from "../agents/model_types.js";
import SSEStream from "../services/sse_stream"
import { describeProviderError } from "../agents/provider_errors"
import {
  cancelElicitations,
  resolveElicitation,
  withElicitationChannel,
  type ElicitationAnswer,
  type ElicitationRequest,
} from "../services/elicitation"
import { ClientSession, Document, Types } from "mongoose"

const router = Router()

/**
 * Stream a turn, with any question the agent raises routed to this response.
 *
 * The channel is installed for the duration of the run, so a tool call deep in
 * the agent loop reaches *this* browser rather than another concurrent run's.
 */
const streamTurn = async (
  sse: SSEStream,
  res: Response,
  input: any[],
  generator: (...args: any) => AsyncGenerator<any>,
  done: (data: AgentStreamEventPayload | undefined) => Promise<void>,
  meta?: Record<string, unknown>
) => {
  const asked = new Set<string>()

  // A closed connection can never answer, so release the run rather than let it
  // sit out the timeout. Registered before the first question can be asked.
  res.on("close", () => cancelElicitations(asked))

  const channel = {
    ask(request: ElicitationRequest) {
      asked.add(request.id)
      if (!sse.send(res, "elicitation", request)) {
        throw new Error("client disconnected before the question could be delivered")
      }
    },
  }

  await withElicitationChannel(channel, () => sse.stream(res, input, generator, done, meta))
}


/**
 * Run a turn without streaming, reporting a provider failure as JSON.
 *
 * Without this the error escapes to Express, which answers with an HTML page
 * the UI's error reader can't parse — and whose text ("Server error") says
 * nothing about the exhausted balance or rate limit that actually caused it.
 * The streaming path gets the same treatment inside SSEStream.
 */
const runTurn = async (
  res: Response,
  turn: () => Promise<string>
): Promise<string | null> => {
  try {
    return await turn()
  } catch (err) {
    console.error("Agent run failed:", err)
    const failure = describeProviderError(err)
    res.status(failure.status).json({ error: failure.message })
    return null
  }
}

const createMessage = async(content: string, conversation: Document, session: ClientSession | null, author: string = "user") => {
  const message = new MessageModel({ author, content, conversation: conversation._id })
  return await message.save({ session: session })
}

// NOTE: this was a db.transaction(), but transactions need a replica set and the
// local mongod is standalone, so the callback always rejected — and because the
// call wasn't awaited it surfaced as an unhandled rejection rather than an error
// here. Sequential saves for now; restore the transaction once Mongo runs as a
// replica set (and pass `session` through to createMessage so both saves share it).
const createConversation = async (content: string, model?: string) => {
  const conversation = new ConversationModel({ agentModel: model })
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
    model: conversation.agentModel ?? null,
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
  // safeParse: Express 5 turns a thrown ZodError into a 500 HTML page, which
  // the UI's error reader can't parse. An unknown model lands here.
  const parsed = createConversationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") })
    return
  }
  const params = parsed.data
  const conversation = await createConversation(params.message, params.model)

  const agent = await Agent.withSettings({
    conversationId: String(conversation._id),
    // Unset on the thread means the app default, resolved per turn.
    model: (conversation.agentModel as ModelType | undefined) ?? undefined,
  })
  if(!SSEStream.wantsStream(req)) {
    const reply = await runTurn(res, () => agent.run(params.message))
    if (reply === null) return
    await createMessage(reply, conversation, null, "assistant")
    // Without this return the handler fell through and `new SSEStream(req)`
    // threw, after the response had already been sent.
    res.json({ conversationId: conversation._id, reply })
    return
  }

  const sse = new SSEStream(req)
  // Bound, or `this` is undefined inside the generator. `input` is spread as
  // the generator's arguments, so it must be an argument list.
  await streamTurn(sse, res, [params.message], agent.streamEvents.bind(agent), async (data: AgentStreamEventPayload | undefined) => {
     // Only the terminal payload carries the reply text; "working" payloads are steps.
    if (data?.phase !== "done") return
    await createMessage(String(data.content), conversation, null, "assistant")
  }, { conversationId: String(conversation._id) })
})

router.post("/:conversation_id/messages", async(req: Request, res: Response) => {
  const parsed = createMessageSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") })
    return
  }
  const params = parsed.data

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

  // A model on the request switches the thread from here on, so later turns
  // keep using it without the client having to resend it.
  if (params.model && params.model !== conversation.agentModel) {
    conversation.agentModel = params.model
    await conversation.save()
  }

  const agent = await Agent.withSettings({
    conversationId: String(conversation._id),
    // Unset on the thread means the app default, resolved per turn.
    model: (conversation.agentModel as ModelType | undefined) ?? undefined,
  })
  if (!SSEStream.wantsStream(req)) {
    const reply = await runTurn(res, () => agent.run(params.message, history))
    if (reply === null) return
    await createMessage(reply, conversation, null, "assistant")
    res.json({ conversationId: conversation._id, reply })
    return
  }

  const sse = new SSEStream(req)

  await streamTurn(sse, res, [params.message, history], agent.streamEvents.bind(agent), async (data: AgentStreamEventPayload | undefined) => {
     // Only the terminal payload carries the reply text; "working" payloads are steps.
    if (data?.phase !== "done") return
    await createMessage(String(data.content), conversation, null, "assistant")
  })
})

/**
 * Answer a question the agent asked mid-run.
 *
 * The turn is still open on its own SSE connection, blocked inside the tool
 * call that asked. Resolving here unblocks it; this request just acknowledges.
 */
router.post("/:conversation_id/elicitations/:elicitation_id", async (req: Request, res: Response) => {
  const answer = req.body as Partial<ElicitationAnswer>

  if (["acccept", "decline", "cancel"].includes(answer?.action!)) {
    res.status(400).json({ error: "action must be one of: accept, decline, cancel" })
    return
  }

  if (answer.action === "accept" && (typeof answer.content !== "object" || answer.content === null)) {
    res.status(400).json({ error: "an accepted answer needs a content object" })
    return
  }

  // False means it already timed out, was answered, or the run has gone. Not an
  // error the user can act on, but they should know the answer went nowhere.
  const delivered = resolveElicitation(String(req.params.elicitation_id), answer as ElicitationAnswer)
  if (!delivered) {
    res.status(409).json({ error: "This question is no longer waiting for an answer" })
    return
  }

  res.json({ delivered: true })
})

export default router