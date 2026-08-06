/**
 * Translate between serialized LangChain messages (see dump.json) and the
 * DeepSeek / OpenAI chat-completions message format.
 *
 * `convert` goes LangChain -> DeepSeek, for persisting a conversation;
 * `toLangChainHistory` goes back, for feeding a stored conversation to the
 * agent as `externalHistory`.
 *
 * The CLI wrapper lives in scripts/langchain-to-deepseek.ts — this module is
 * import-only so it has no side effects.
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import type { ToolCall } from '@langchain/core/messages'

/**
 * The concrete message classes, rather than `@langchain/core`'s abstract
 * `BaseMessage`. This mirrors the union `@mcp-use/agent` accepts as
 * `externalHistory`, which the abstract type isn't assignable to.
 */
export type LangChainMessage = SystemMessage | HumanMessage | AIMessage | ToolMessage

// ---------------------------------------------------------------------------
// Input shape (langchain_core serialized messages)
// ---------------------------------------------------------------------------

export interface SerializedMessage {
  lc?: number
  type?: string
  id: string[]
  kwargs: {
    content: unknown
    additional_kwargs?: Record<string, any>
    response_metadata?: Record<string, any>
    tool_calls?: Array<{ id?: string; name: string; args?: unknown; type?: string }>
    tool_call_chunks?: Array<{ id?: string; name?: string; args?: string; index?: number }>
    tool_call_id?: string
    name?: string
    status?: string
    [key: string]: unknown
  }
}

// ---------------------------------------------------------------------------
// Output shape (DeepSeek / OpenAI)
// ---------------------------------------------------------------------------

export interface DeepSeekToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type DeepSeekMessage =
  | { role: 'system'; content: string, [key: string]: any }
  | { role: 'user'; content: string, [key: string]: any }
  | { role: 'tool'; tool_call_id: string; content: string; name?: string, [key: string]: any }
  | {
      role: 'assistant'
      content: string | null
      reasoning_content?: string
      tool_calls?: DeepSeekToolCall[],
      [key: string]: any
    }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The concrete class name, e.g. "SystemMessage" / "AIMessageChunk". */
function messageClass(message: SerializedMessage): string {
  return message.id?.[message.id.length - 1] ?? ''
}

/**
 * LangChain content is either a plain string or a list of content blocks.
 * Only textual blocks survive the conversion — DeepSeek chat messages carry
 * text, reasoning and tool calls, nothing else.
 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)

  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object') {
        const b = block as Record<string, any>
        if (typeof b.text === 'string') return b.text
        if (typeof b.content === 'string') return b.content
      }
      return ''
    })
    .filter(Boolean)
    .join('')
}

/** Tool-call arguments must be a JSON *string* in the DeepSeek format. */
function stringifyArguments(args: unknown): string {
  if (typeof args === 'string') return args
  if (args == null) return '{}'
  return JSON.stringify(args)
}

/**
 * Prefer the raw provider payload in `additional_kwargs.tool_calls` (it already
 * carries the exact argument string the model emitted); otherwise rebuild the
 * calls from LangChain's parsed `tool_calls` / streamed `tool_call_chunks`.
 */
function extractToolCalls(message: SerializedMessage): DeepSeekToolCall[] {
  const raw = message.kwargs.additional_kwargs?.tool_calls
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((call: any, index: number) => ({
      id: call.id ?? `call_${index}`,
      type: 'function' as const,
      function: {
        name: call.function?.name ?? call.name ?? '',
        arguments: stringifyArguments(call.function?.arguments ?? call.args),
      },
    }))
  }

  const chunks = message.kwargs.tool_call_chunks
  const parsed = message.kwargs.tool_calls
  const source = Array.isArray(chunks) && chunks.length > 0 ? chunks : parsed

  if (!Array.isArray(source) || source.length === 0) return []

  return source.map((call: any, index: number) => ({
    id: call.id ?? `call_${index}`,
    type: 'function' as const,
    function: {
      name: call.name ?? '',
      arguments: stringifyArguments(call.args),
    },
  }))
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export function toDeepSeekMessage(message: SerializedMessage): DeepSeekMessage | null {
  const kind = messageClass(message)
  const content = flattenContent(message.kwargs.content)

  if (kind.startsWith('System')) {
    return { role: 'system', content }
  }

  if (kind.startsWith('Human')) {
    return { role: 'user', content }
  }

  if (kind.startsWith('Tool')) {
    const toolCallId = message.kwargs.tool_call_id
    if (!toolCallId) return null
    const tool: DeepSeekMessage = { role: 'tool', tool_call_id: toolCallId, content }
    if (message.kwargs.name) tool.name = message.kwargs.name
    return tool
  }

  if (kind.startsWith('AI')) {
    const toolCalls = extractToolCalls(message)
    const reasoning = message.kwargs.additional_kwargs?.reasoning_content

    const assistant: DeepSeekMessage = {
      role: 'assistant',
      // DeepSeek expects an explicit null when the turn is only tool calls.
      content: content === '' && toolCalls.length > 0 ? null : content,
    }
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      assistant.reasoning_content = reasoning
    }
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls

    return assistant
  }

  return null
}

export function convert(dump: SerializedMessage[]): DeepSeekMessage[] {
  return dump
    .map(toDeepSeekMessage)
    .filter((message): message is DeepSeekMessage => message !== null)
}

/**
 * Put live LangChain messages into the serialized `{ lc, id, kwargs }` form
 * `convert` reads.
 *
 * A message held in memory is a class instance whose fields sit directly on the
 * object; the serialized form is what its `toJSON` produces, which is also what
 * a dump file holds. Round-tripping through JSON is how you get from one to the
 * other, so `convert` has a single input shape to handle.
 */
export function serialize(messages: unknown[]): SerializedMessage[] {
  return JSON.parse(JSON.stringify(messages))
}

// ---------------------------------------------------------------------------
// Reverse conversion (DeepSeek -> LangChain)
// ---------------------------------------------------------------------------

/**
 * DeepSeek keeps tool-call arguments as a JSON string, LangChain as an object.
 * Anything that isn't parseable JSON is handed over untouched, so a malformed
 * argument string still reaches the model rather than blowing up the replay.
 */
function parseArguments(args: string): Record<string, any> {
  try {
    const parsed = JSON.parse(args)
    return parsed && typeof parsed === 'object' ? parsed : { input: parsed }
  } catch {
    return { input: args }
  }
}

function toToolCall(call: DeepSeekToolCall, index: number): ToolCall {
  return {
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? '',
    args: parseArguments(call.function?.arguments ?? '{}'),
    type: 'tool_call',
  }
}

/**
 * A LangChain message that came straight off an agent rather than out of
 * storage. `instanceof` isn't enough on its own — a duplicated `@langchain/core`
 * in the tree gives instances of a *different* class object — so fall back to
 * the marker every serializable LangChain message carries.
 */
function isLangChainMessage(message: unknown): message is LangChainMessage {
  if (
    message instanceof SystemMessage ||
    message instanceof HumanMessage ||
    message instanceof AIMessage ||
    message instanceof ToolMessage
  ) {
    return true
  }
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as any).lc_serializable === true &&
    typeof (message as any).getType === 'function'
  )
}

/**
 * Rebuild LangChain messages from stored DeepSeek ones, for replay as an
 * agent's `externalHistory`. Messages that are already LangChain — an agent's
 * own `conversationHistory`, say — pass through untouched.
 *
 * `reasoning_content` is deliberately dropped: providers reject stale reasoning
 * on a fresh turn, and it carries no information the assistant text and tool
 * results don't already have.
 */
export function toLangChainMessage(
  message: DeepSeekMessage | LangChainMessage
): LangChainMessage | null {
  if (isLangChainMessage(message)) return message

  switch (message.role) {
    case 'system':
      return new SystemMessage({ content: message.content ?? '' })

    case 'user':
      return new HumanMessage({ content: message.content ?? '' })

    case 'tool':
      if (!message.tool_call_id) return null
      return new ToolMessage({
        content: message.content ?? '',
        tool_call_id: message.tool_call_id,
        name: message.name,
      })

    case 'assistant': {
      const toolCalls = (message.tool_calls ?? []).map(toToolCall)
      return new AIMessage({
        content: message.content ?? '',
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }

    default:
      return null
  }
}

export function toLangChainHistory(
  messages: Array<DeepSeekMessage | LangChainMessage>
): LangChainMessage[] {
  return messages
    .map(toLangChainMessage)
    .filter((message): message is LangChainMessage => message !== null)
}
