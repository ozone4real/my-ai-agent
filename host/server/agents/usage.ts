import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { AIMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";

export interface UsageTotals {
  calls: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  /** The fixed prefix — tool schemas, instructions, replay, prompt — before any step. */
  firstCallInputTokens: number
}

/**
 * Token usage across every model call an agent makes, one log line per call.
 *
 * A callback rather than a read of the history afterwards: the history is only
 * committed once the loop finishes, so a run that throws would report nothing.
 */
export class UsageTracker extends BaseCallbackHandler {
  name = "usage_tracker"

  readonly totals: UsageTotals = {
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    firstCallInputTokens: 0,
  }

  private lastInputTokens = 0

  constructor(private readonly label?: string) {
    super()
  }

  handleLLMEnd(output: LLMResult): void {
    const message = (output.generations[0]?.[0] as ChatGeneration | undefined)?.message as
      | AIMessage
      | undefined
    const usage = message?.usage_metadata
    if (!usage) return

    // DeepSeek reports cache hits as `prompt_cache_hit_tokens`, which LangChain
    // doesn't map; it only reads OpenAI's `prompt_tokens_details.cached_tokens`.
    const raw = message.response_metadata?.usage as { prompt_cache_hit_tokens?: number } | undefined
    const cacheRead = usage.input_token_details?.cache_read ?? raw?.prompt_cache_hit_tokens ?? 0

    const t = this.totals
    t.calls++
    t.inputTokens += usage.input_tokens
    t.cacheReadTokens += cacheRead
    t.outputTokens += usage.output_tokens
    if (t.calls === 1) t.firstCallInputTokens = usage.input_tokens

    const growth = usage.input_tokens - this.lastInputTokens
    this.lastInputTokens = usage.input_tokens

    const n = (value: number) => value.toLocaleString("en-US")
    console.log(
      `[usage${this.label ? ` ${this.label}` : ""}] call ${t.calls}: ` +
        `${n(usage.input_tokens)} in (${n(cacheRead)} cached, +${n(growth)} context), ` +
        `${n(usage.output_tokens)} out`
    )
  }
}
