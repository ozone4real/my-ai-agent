import { readFileSync } from "node:fs";
import path from "node:path";
import { MCPAgent } from "@mcp-use/agent/langchain";
import type { MCPAgentOptions, MCPServerConfig, LangChainAgentStep as AgentStep } from "@mcp-use/agent/langchain";
import type { LLMConfig } from "@mcp-use/agent";
import type { BaseMessage } from "@mcp-use/agent/langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MCPClient } from "@mcp-use/client";
import ServersDefinition from "../../../mcp_servers/servers_definition.js";
import { convert, serialize, toLangChainHistory } from "./message_converters/deep_seek.js";
import type { DeepSeekMessage, LangChainMessage } from "./message_converters/deep_seek.js";


export enum ModelType {
  SONNET_4_8 = "claude-sonnet-4-8",
  OPUS_4_8 = "claude-opus-4-8",
  SONNET_5_0 = "claude-sonnet-5-0",
  OPUS_5_0 = "claude-opus-5-0",
  DEEPSEEK_V4_FLASH = "deepseek-v4-flash"
}

/** A prior turn: LangChain messages or the stored DeepSeek JSON. Both work. */
export type AgentMessage = DeepSeekMessage | LangChainMessage

export const MODELS = {
  "deepseek": [ModelType.DEEPSEEK_V4_FLASH],
  "anthropic": [ModelType.SONNET_4_8, ModelType.OPUS_4_8, ModelType.SONNET_5_0, ModelType.OPUS_5_0]
}

export interface AgentStreamPayload {
  phase: "done" | "working";
  value: AgentStep | string
}

/** A tool invocation the agent has just started. */
export interface AgentToolCall {
  /** Tool name as registered by its MCP server, e.g. "searxng_web_search". */
  tool: string
  /** Arguments the model passed, when the run reports them. */
  args?: unknown
}

/**
 * Discriminated on `phase`, so narrowing it narrows `content`:
 * reasoning (many per turn) -> working (one per tool call) -> done (once, last).
 */
export type AgentStreamEventPayload =
  | { phase: "reasoning"; content: string }
  | { phase: "working"; content: AgentToolCall }
  | { phase: "done"; content: string }

/** How much reasoning to gather before emitting a payload. */
const REASONING_CHUNK_WORDS = 10

/**
 * Index just past the `count`-th word, or -1 if not yet provable.
 *
 * A streamed buffer can end mid-word, so the cut is only returned once a
 * further word has been seen. Indices rather than split/join so the original
 * whitespace survives.
 */
const splitAfterWords = (text: string, count: number): number => {
  const words = /\S+/g
  let seen = 0
  let end = -1
  let match: RegExpExecArray | null

  while ((match = words.exec(text)) !== null) {
    seen++
    if (seen === count) {
      end = match.index + match[0].length
      continue
    }
    if (seen > count) return end
  }
  return -1
}

export interface AgentOptions {
  model?: ModelType
  /**
   * Surfaced to the model so it can pass provenance to tools that ask for it —
   * `schedule-task`'s `sourceConversation` is otherwise unknowable in-run.
   */
  conversationId?: string
  /** Who the user is and how they want to be addressed. */
  preferredName?: string
  /** Standing instructions from Settings, added to the system message. */
  userInstructions?: string
}

/**
 * Operating instructions, read once at startup.
 *
 * Loud on failure rather than silently running an agent with no rules — the
 * file ships with the source, so a missing one means a broken deploy.
 */
const OPERATING_INSTRUCTIONS = (() => {
  const file = path.join(import.meta.dirname, "instructions.md")
  try {
    return readFileSync(file, "utf8").trim()
  } catch (err) {
    throw new Error(
      `Could not read agent operating instructions at ${file}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
})()

export class Agent {
  public agent: MCPAgent
  private llm: ChatDeepSeek

  public mcpServers: Record<string, MCPServerConfig> = ServersDefinition

  /**
   * One client for the whole process, shared by every agent.
   *
   * Connecting the MCP servers spawns a child process each and takes 9-28s
   * An agent with its own client paid that per request;
   * over a shared one, `initialize()` finds the sessions
   * already open and returns in ~20-130ms.
   *
   * Only the connectors are shared. Each agent still gets its own system
   * message, tool bindings and history, so per-conversation
   * `additionalInstructions` still work.
   */
  private static sharedClient = new MCPClient({ mcpServers: ServersDefinition })

  /** Memoised so concurrent first requests connect once, not once each. */
  private static sessions: Promise<unknown> | null = null

  /**
   * An agent with Settings applied; explicit options win.
   *
   * A factory because settings come from Mongo and the constructor has to build
   * the MCPAgent synchronously.
   */
  static async withSettings(options: AgentOptions = {}): Promise<Agent> {
    const { loadSettings } = await import("../models/settings.js")
    const settings = await loadSettings()
    return new Agent({
      model: options.model ?? (settings.defaultModel as ModelType),
      preferredName: options.preferredName ?? settings.preferredName ?? undefined,
      userInstructions: options.userInstructions ?? settings.instructions ?? undefined,
      conversationId: options.conversationId,
    })
  }

  constructor({
    model = ModelType.DEEPSEEK_V4_FLASH,
    conversationId,
    preferredName,
    userInstructions,
  }: AgentOptions = {}) {
    // const llm = new ChatAnthropic({
    //   model,
    //   temperature: 0.7,
    //   apiKey: process.env.ANTHROPIC_API_KEY,
    //   maxTokens: 10000
    // });

    const llm = new ChatDeepSeek({
      model,
      maxTokens: 10000,
      apiKey: process.env.DEEP_SEEK_API_KEY,
      streaming: true
    })

    this.llm = llm

    this.agent = new MCPAgent({
      llm,
      client: Agent.sharedClient,
      maxSteps: 100,
      // The only way in: a SystemMessage in `externalHistory` is silently
      // discarded, since that array is filtered to human/AI/tool messages.
      additionalInstructions: this.buildContextInstructions({ conversationId, preferredName, userInstructions }),
    })
  }

  /**
   * Connect the MCP servers. Safe to call repeatedly — only the first call
   * connects. Call it at boot so the first request doesn't wear the cost.
   */
  static warmup(): Promise<unknown> {
    // Clear on failure, or one bad connector at boot poisons every later call
    // with the same rejected promise.
    Agent.sessions ??= Agent.sharedClient.createAllSessions().catch((err) => {
      Agent.sessions = null
      throw err
    })
    return Agent.sessions
  }

  /** Disconnect every MCP server. Process shutdown only — this is shared state. */
  static async shutdown(): Promise<void> {
    if (!Agent.sessions) return
    Agent.sessions = null
    await Agent.sharedClient.close()
  }

  async run(prompt: string, context: AgentMessage[] = []) {
    await Agent.warmup()
    const result = await this.agent.run({
      prompt,
      externalHistory: toLangChainHistory(context)
    })
    return result;
  }
  async *stream(prompt: string, context: AgentMessage[] = []): AsyncGenerator<AgentStreamPayload> {
    await Agent.warmup()
    const stream = this.agent.stream({
      prompt,
      manageConnector: true,
      externalHistory: toLangChainHistory(context),
    })

    while(true) {
      const { done, value } = await stream.next();
      if(done) {
        yield({ phase: "done", value })
        break
      }
      yield({ phase: "working", value })
    }
  }

  /**
   * Stream a turn as reasoning, tool calls, and a final answer.
   *
   * Unlike {@link Agent.stream}, which only yields completed tool steps, this
   * reads the underlying LangChain v2 event stream and so can surface the
   * model's thinking as it happens.
   */
  async *streamEvents(
    prompt: string,
    context: AgentMessage[] = []
  ): AsyncGenerator<AgentStreamEventPayload> {
    // The agent loops: model call -> tool calls -> model call -> ... Only the
    // last model call answers the user; the earlier ones are deciding which
    // tool to reach for, and their text is preamble we don't want to emit as
    // the reply. So accumulate per model call and keep the text of the most
    // recent one that asked for no tools.
    let turnText = ""
    let finalText = ""
    let lastText = ""

    // Providers emit reasoning a few characters at a time, so forwarding each
    // one is a payload per token. Batch into REASONING_CHUNK_WORDS pieces and
    // hold the remainder back — it gets topped up by the next chunk, or flushed
    // when the reasoning ends.
    let reasoningBuffer = ""

    /**
     * @param flush - Emit a short trailing piece too. Pass `true` wherever the
     * reasoning is over, so a partial chunk isn't stranded in the buffer behind
     * a tool call or the final answer.
     */
    function* drainReasoning(flush: boolean): Generator<AgentStreamEventPayload> {
      let cut: number
      while ((cut = splitAfterWords(reasoningBuffer, REASONING_CHUNK_WORDS)) !== -1) {
        yield { phase: "reasoning", content: reasoningBuffer.slice(0, cut) }
        reasoningBuffer = reasoningBuffer.slice(cut)
      }
      if (flush && reasoningBuffer.trim().length > 0) {
        yield { phase: "reasoning", content: reasoningBuffer }
        reasoningBuffer = ""
      }
    }

    await Agent.warmup()

    for await (const event of this.agent.streamEvents({
      prompt,
      manageConnector: true,
      externalHistory: toLangChainHistory(context),
    })) {
      switch (event.event) {
        case "on_chat_model_start":
          turnText = ""
          break

        case "on_chat_model_stream": {
          const chunk = event.data?.chunk
          if (!chunk) break

          const reasoning = this.readReasoning(chunk)
          if (reasoning) {
            reasoningBuffer += reasoning
            yield* drainReasoning(false)
          }

          // `text` concatenates only `type: "text"` blocks, so Anthropic
          // thinking and Gemini thought parts don't leak into the answer.
          const text = typeof chunk.text === "string" ? chunk.text : ""
          if (text) turnText += text
          break
        }

        case "on_chat_model_end": {
          // This model call's thinking is finished — flush it so a later call's
          // reasoning can't be glued onto the tail of this one's.
          yield* drainReasoning(true)

          // A model call that requested tools is a step, not an answer.
          const output = event.data?.output as any
          const calledTools = (output?.tool_calls ?? []).length > 0
          if (turnText) lastText = turnText
          if (!calledTools && turnText) finalText = turnText
          break
        }

        case "on_tool_start":
          yield* drainReasoning(true)
          yield {
            phase: "working",
            content: { tool: event.name, args: this.readToolArgs(event.data?.input) },
          }
          break
      }
    }

    // Nothing follows but `done`, so anything still buffered goes out now.
    yield* drainReasoning(true)

    // Fall back to the last thing the model said, so a run that ends on a
    // tool-calling turn (hitting maxSteps, say) still terminates with a reply
    // rather than silence.
    yield { phase: "done", content: finalText || lastText }
  }

  /**
   * Drop this agent's per-run state. Not `agent.close()` — that closes the
   * shared client's sessions out from under every other agent.
   */
  cleanup() {
    this.agent.clearConversationHistory()
  }

  /**
   * The thread so far, in the shape `externalHistory` takes — so it can be fed
   * straight back into {@link Agent.run} / {@link Agent.stream} /
   * {@link Agent.streamEvents} as their `context`.
   */
  get conversationHistory(): LangChainMessage[] {
    return this.agent.getConversationHistory() as LangChainMessage[]
  }

  /**
   * The same thread as plain DeepSeek/OpenAI JSON, for persisting. Unlike
   * {@link Agent.conversationHistory} these are inert objects, not LangChain
   * class instances, so they survive a round trip through a database.
   *
   * The system message is left out. It is generated fresh on every run from the
   * live tool list and {@link AgentOptions.conversationId}, so a stored copy is
   * both stale and enormous — it is the bulk of a transcript, and repeats every
   * tool description verbatim. Nothing wants it back either: `externalHistory`
   * discards system messages, so replaying one is a no-op.
   */
  get serializedConversationHistory(): AgentMessage[] {
    return convert(serialize(this.conversationHistory)).filter(
      (message) => message.role !== "system"
    )
  }

  /** Operating rules first, then run-scoped facts, then the user's own. */
  private buildContextInstructions ({
    conversationId,
    preferredName,
    userInstructions,
  }: Pick<AgentOptions, "conversationId" | "preferredName" | "userInstructions">): string {
  // First: the operating rules are the baseline everything else sits on.
    const parts: string[] = [OPERATING_INSTRUCTIONS]

    if (preferredName) {
      parts.push(`The user prefers to be called ${preferredName}.`)
    }

    if (conversationId) {
      parts.push(
        [
          `You are answering inside conversation ${conversationId}.`,
          `When a tool takes a conversation id — for example the sourceConversation`,
          `argument of schedule-task — pass exactly that value. Do not invent one, and`,
          `do not mention the id to the user unless they ask for it.`,
        ].join(" ")
      )
    }

    // Last, so the user's own instructions win any disagreement with the above.
    if (userInstructions) parts.push(userInstructions)

    return parts.join("\n\n")
  }

  /** Reasoning text from a streamed chunk, whatever provider produced it. */
  private readReasoning (chunk: any): string  {
    if (!chunk) return ""

    // 1. v1 standard blocks. `contentBlocks` dispatches on
    //    response_metadata.model_provider, so Anthropic thinking, Gemini thought
    //    parts, DeepSeek/Grok reasoning_content and OpenAI summaries all land
    //    here as `{ type: "reasoning" }`.
    try {
      const blocks = chunk.contentBlocks
      if (Array.isArray(blocks)) {
        const reasoning = blocks
          .filter((block: any) => block?.type === "reasoning")
          .map((block: any) => block?.reasoning ?? "")
          .join("")
        if (reasoning) return reasoning
      }
    } catch {
      // Not a real AIMessageChunk; the raw-shape fallbacks below still work.
    }

    // 2. Raw fields, for chunks with no model_provider to dispatch on.
    const kwargs = chunk.additional_kwargs ?? {}
    if (typeof kwargs.reasoning_content === "string") return kwargs.reasoning_content
    if (typeof kwargs.reasoning === "string") return kwargs.reasoning
    if (kwargs.reasoning && typeof kwargs.reasoning === "object") {
      const summary = kwargs.reasoning.summary
      if (Array.isArray(summary)) {
        return summary.map((part: any) => part?.text ?? "").join("")
      }
      if (typeof kwargs.reasoning.text === "string") return kwargs.reasoning.text
    }

    // 3. Anthropic-shaped arrays, where thinking deltas live in the content list.
    if (Array.isArray(chunk.content)) {
      return chunk.content
        .filter((block: any) => block?.type === "thinking" || block?.type === "reasoning")
        .map((block: any) => block?.thinking ?? block?.reasoning ?? "")
        .join("")
    }

    return ""
  }

  /**
   * LangChain reports tool args as `{ input: ... }`, and for MCP tools the inner
   * value is the raw JSON string. Unwrap both; anything else passes through.
  */
  private readToolArgs (input: unknown): unknown {
    const unwrapped =
      input && typeof input === "object" && "input" in input
        ? (input as { input: unknown }).input
        : input

    if (typeof unwrapped === "string") {
      try {
        return JSON.parse(unwrapped)
      } catch {
        return unwrapped
      }
    }
    return unwrapped
  }
}
