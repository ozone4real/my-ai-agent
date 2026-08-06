import { MCPAgent } from "@mcp-use/agent/langchain";
import type { MCPAgentOptions, MCPServerConfig, LangChainAgentStep as AgentStep } from "@mcp-use/agent/langchain";
import type { LLMConfig } from "@mcp-use/agent";
import type { BaseMessage } from "@mcp-use/agent/langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MCPClient } from "@mcp-use/client";
import ServersDefinition from "../../../mcp_servers/servers_definition";
import { convert, serialize, toLangChainHistory } from "./message_converters/deep_seek";
import type { DeepSeekMessage, LangChainMessage } from "./message_converters/deep_seek";


enum ModelType {
  SONNET_4_8 = "claude-sonnet-4-8",
  OPUS_4_8 = "claude-opus-4-8",
  SONNET_5_0 = "claude-sonnet-5-0",
  OPUS_5_0 = "claude-opus-5-0",
  DEEPSEEK_V4_FLASH = "deepseek-v4-flash"
}

/**
 * One prior turn of history. Either form is accepted: LangChain messages as
 * they come off {@link Agent.conversationHistory}, or the DeepSeek JSON the
 * routes store — both are normalized before reaching the agent.
 */
export type AgentMessage = DeepSeekMessage | LangChainMessage

const MODELS = {
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
 * One payload from {@link Agent.streamEvents}, discriminated on `phase` so
 * narrowing on it also narrows `content`:
 *
 *   reasoning -> incremental thinking text, many per turn
 *   working   -> a tool call, one per invocation
 *   done      -> the final answer, exactly once, last
 */
export type AgentStreamEventPayload =
  | { phase: "reasoning"; content: string }
  | { phase: "working"; content: AgentToolCall }
  | { phase: "done"; content: string }

/** How much reasoning to gather before emitting a payload. */
const REASONING_CHUNK_WORDS = 50

/**
 * Index just past the `count`-th word of `text`, or -1 when the text doesn't
 * yet hold a provable `count` words.
 *
 * "Provable" is the point: a streamed buffer can end mid-word, so the cut is
 * only returned once a *further* word has been seen — that's what shows word
 * `count` was terminated rather than still arriving. Working in indices instead
 * of a split/join keeps the original whitespace, so the emitted chunks
 * concatenate back into exactly the text the model produced.
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

/**
 * Unwrap the arguments an `on_tool_start` event reports.
 *
 * LangChain hands these over as `{ input: ... }`, and for MCP tools the inner
 * value is usually the raw JSON string the model emitted rather than a parsed
 * object — so consumers would otherwise get a string wrapped in a pointless
 * key. Anything that doesn't match those shapes passes through untouched.
 */
const readToolArgs = (input: unknown): unknown => {
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

/**
 * Pull reasoning text out of a streamed model chunk, whatever provider produced
 * it. Each layer is a fallback for the one above, because a chunk only reaches
 * the later ones if the earlier extraction found nothing.
 */
const readReasoning = (chunk: any): string => {
  if (!chunk) return ""

  // 1. LangChain v1 standard blocks. `contentBlocks` picks a translator off
  //    `response_metadata.model_provider`, and @langchain/core ships ones for
  //    anthropic, openai, deepseek, google/google-genai/google-vertexai, xai,
  //    groq, ollama, openrouter and bedrock-converse — so Anthropic `thinking`,
  //    Gemini `thought` parts, DeepSeek/Grok `reasoning_content` and OpenAI
  //    reasoning summaries all arrive here as `{ type: "reasoning" }`.
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
    // Not a real AIMessageChunk (e.g. re-serialized across a boundary) — the
    // raw-shape fallbacks below still work on a plain object.
  }

  // 2. Raw provider fields, for chunks carrying no `model_provider` for core to
  //    dispatch on. DeepSeek and xAI/Grok use `reasoning_content`; Groq and
  //    OpenRouter use a plain `reasoning` string; the OpenAI Responses API
  //    nests summary parts under `reasoning.summary`.
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

  // 3. Anthropic-shaped content arrays, whose thinking deltas live in the
  //    content list rather than in additional_kwargs.
  if (Array.isArray(chunk.content)) {
    return chunk.content
      .filter((block: any) => block?.type === "thinking" || block?.type === "reasoning")
      .map((block: any) => block?.thinking ?? block?.reasoning ?? "")
      .join("")
  }

  return ""
}

export interface AgentOptions {
  model?: ModelType
  /**
   * The conversation this agent is answering in, when there is one. Surfaced to
   * the model so it can pass provenance to tools that ask for it — notably
   * `schedule-task`, whose `sourceConversation` is otherwise unknowable from
   * inside the run.
   */
  conversationId?: string
}

/**
 * The run-scoped facts the model should know, as a system instruction.
 *
 * Returns undefined when there's nothing to say, so a background run (a
 * scheduled task, say) doesn't get a paragraph explaining that it has no
 * conversation.
 */
const buildContextInstructions = (conversationId?: string): string | undefined => {
  if (!conversationId) return undefined
  return [
    `You are answering inside conversation ${conversationId}.`,
    `When a tool takes a conversation id — for example the sourceConversation`,
    `argument of schedule-task — pass exactly that value. Do not invent one, and`,
    `do not mention the id to the user unless they ask for it.`,
  ].join(" ")
}

export class Agent {
  public agent: MCPAgent
  private llm: ChatDeepSeek
  
  public mcpServers: Record<string, MCPServerConfig> = ServersDefinition
  private client: MCPClient

  constructor({
    model = ModelType.DEEPSEEK_V4_FLASH,
    conversationId,
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

    this.client = new MCPClient({ mcpServers: this.mcpServers })

    this.agent = new MCPAgent({
      llm,
      client: this.client,
      maxSteps: 100,
      // Appended to the generated system message, after the tool descriptions.
      //
      // NOTE: this is the only way to get a system instruction in. Putting a
      // SystemMessage in `externalHistory` looks like it should work and is
      // silently discarded — the agent filters that array down to human, AI and
      // tool messages before use.
      additionalInstructions: buildContextInstructions(conversationId),
    })
  }

  async run(prompt: string, context: AgentMessage[] = []) {
    const result = await this.agent.run({
      prompt,
      externalHistory: toLangChainHistory(context)
    })
    return result;
  }
  async *stream(prompt: string, context: AgentMessage[] = []): AsyncGenerator<AgentStreamPayload> {
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
    await this.agent.close();
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

          const reasoning = readReasoning(chunk)
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
            content: { tool: event.name, args: readToolArgs(event.data?.input) },
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

    await this.agent.close();
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
   */
  get serializedConversationHistory(): AgentMessage[] {
    return convert(serialize(this.conversationHistory))
  }
}
