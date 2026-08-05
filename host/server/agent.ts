import { MCPAgent } from "@mcp-use/agent/langchain";
import type { MCPAgentOptions, MCPServerConfig, LangChainAgentStep as AgentStep } from "@mcp-use/agent/langchain";
import type { LLMConfig } from "@mcp-use/agent";
import type { BaseMessage } from "@mcp-use/agent/langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MCPClient } from "@mcp-use/client";

enum ModelType {
  SONNET_4_6 = "claude-sonnet-4-6",
  OPUS_4_6 = "claude-opus-4-6",
  SONNET_4_7 = "claude-sonnet-4-7",
  OPUS_4_7 = "claude-opus-4-7",
  SONNET_4_8 = "claude-sonnet-4-8",
  OPUS_4_8 = "claude-opus-4-8"
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

/** One prior turn, in the shape the routes already store them. */
export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

// The LangChain agent wants LangChain messages. NOTE: they must be passed as
// `externalHistory` — the sibling `messages` run option is read only by the
// native (non-LangChain) agent, and this entry point drops it silently, so a
// history sent that way arrives as no history at all.
const toLangChainHistory = (messages: AgentMessage[]): BaseMessage[] =>
  messages.map((message) =>
    message.role === "assistant"
      ? new AIMessage(message.content)
      : new HumanMessage(message.content)
  )

export class Agent {
  public agent: MCPAgent
  private llm: ChatDeepSeek
  
  public mcpServers: Record<string, MCPServerConfig> = {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/ezenwaogbonna/Desktop"],
    },
    shellCommandExecutor: {
      command: "npx",
      args: ["tsx", "mcp_servers/command_executor.ts"]
    },
    chromedevtools: {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222", "--ignoreDefaultChromeArg=--enable-automation"]
    },
    // Web search against the local SearXNG in searxng/ (`npm run search:up`).
    // Fully self-hosted and key-free: SearXNG is AGPL-3.0, mcp-searxng is MIT.
    // If the container isn't running, this server starts but every search fails
    // — the agent's other tools are unaffected.
    websearch: {
      command: "npx",
      args: ["-y", "mcp-searxng"],
    // These are operator caps, not defaults the model can talk its way past —
    // mcp-searxng clamps whatever the model asks for down to them.
    env: {
        SEARXNG_URL: process.env.SEARXNG_URL ?? "http://localhost:8888",
        // `text` is title + url + snippet per hit; the JSON format also carries
        // engine names and per-engine scores the model has no use for.
        SEARXNG_DEFAULT_RESPONSE_FORMAT: "text",
        // Smaller tool schemas. These are re-sent on every model call, so the
        // saving is per-turn, not per-search.
        SEARXNG_LITE_TOOLS: "true",
        // A metasearch page is ~37 hits across engines. The answer is almost
        // always in the first few, and the tail is mostly near-duplicates.
        SEARXNG_MAX_RESULTS: "5",
        SEARXNG_MAX_RESULT_CHARS: "4000",
        // The one that actually dominates the bill: without a cap, one
        // web_url_read of a long article can outweigh every search in the turn.
        URL_READ_MAX_CHARS: "8000",
        // Stop before downloading something huge just to extract 8k of text.
        URL_READ_MAX_CONTENT_LENGTH_BYTES: "1000000",
        // Agents re-issue near-identical queries while reasoning; serve those
        // from memory instead of re-querying every engine.
        SEARCH_CACHE_TTL_MS: "300000",
      },
    },
  }
  private client: MCPClient

  constructor(model: ModelType = ModelType.SONNET_4_6, temperature: Number = 0.7) {
    // const llm = new ChatAnthropic({
    //   model,
    //   temperature: 0.7,
    //   apiKey: process.env.ANTHROPIC_API_KEY,
    //   maxTokens: 10000
    // });

    const llm = new ChatDeepSeek({
      model: "deepseek-v4-flash",
      maxTokens: 10000,
      apiKey: process.env.DEEP_SEEK_API_KEY,
      streaming: true
    })

    this.llm = llm

    this.client = new MCPClient({ mcpServers: this.mcpServers })

    this.agent = new MCPAgent({
      llm,
      client: this.client,
      maxSteps: 100
    })
  }

  async run(prompt: string, context: AgentMessage[] = []) {
    const result = await this.agent.run({
      prompt,
      externalHistory: toLangChainHistory(context),
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
          if (reasoning) yield { phase: "reasoning", content: reasoning }

          // `text` concatenates only `type: "text"` blocks, so Anthropic
          // thinking and Gemini thought parts don't leak into the answer.
          const text = typeof chunk.text === "string" ? chunk.text : ""
          if (text) turnText += text
          break
        }

        case "on_chat_model_end": {
          // A model call that requested tools is a step, not an answer.
          const output = event.data?.output as any
          const calledTools = (output?.tool_calls ?? []).length > 0
          if (turnText) lastText = turnText
          if (!calledTools && turnText) finalText = turnText
          break
        }

        case "on_tool_start":
          yield {
            phase: "working",
            content: { tool: event.name, args: readToolArgs(event.data?.input) },
          }
          break
      }
    }

    // Fall back to the last thing the model said, so a run that ends on a
    // tool-calling turn (hitting maxSteps, say) still terminates with a reply
    // rather than silence.
    yield { phase: "done", content: finalText || lastText }

    await this.agent.close();
  }
}
