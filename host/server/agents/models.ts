import { ChatAnthropic } from "@langchain/anthropic";
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatOpenRouter } from "@langchain/openrouter";

// The ids themselves live in a leaf module with no imports, so Mongoose models
// and the MCP server can validate against them without pulling in LangChain.
import { ModelType } from "./model_types.js";
export { ModelType, MODEL_CHOICES, FREE_MODELS } from "./model_types.js";

/**
 * ChatAnthropic that asks Anthropic to cache the prompt prefix.
 *
 * Nothing sends `cache_control` on its own — not the API, and not
 * `@langchain/anthropic`. Without it every
 * call is billed as fresh input.
 *
 * That is expensive here: the tool schemas and the operating instructions
 * render ahead of everything, are byte-identical across a run, and `maxSteps`
 * lets one run re-send them a hundred times. Cache reads are ~0.1x input.
 *
 * Injected via `invocationParams` rather than the constructor because the
 * per-call `options?.cache_control` is applied *after* `invocationKwargs` is
 * spread in, so a constructor-supplied value is overwritten with undefined.
 * Overriding here also survives `bindTools`, which is how the agent gets its
 * tools attached.
 *
 * `{ type: "ephemeral" }` at the top level is Anthropic's automatic caching:
 * it places the breakpoint on the last cacheable block, so there is nothing to
 * position by hand.
 */
class CachingChatAnthropic extends ChatAnthropic {
  /**
   * Adaptive thinking, with the summary returned.
   *
   * Two defaults are wrong for us if left alone. Whether thinking runs at all
   * depends on the model — `claude-opus-4-8` does none unless asked, while
   * `claude-opus-5` and `claude-sonnet-5` think by default — so without this
   * the dropdown silently changes behaviour. And `display` defaults to
   * "omitted" on all three, which returns a thinking block whose text is empty:
   * billed for the reasoning, with nothing for the UI to show.
   *
   * Set before `...fields` so an explicit `thinking` still wins.
   */
  constructor(fields: ConstructorParameters<typeof ChatAnthropic>[0]) {
    super({
      thinking: { type: "adaptive", display: "summarized" },
      ...fields,
    } as ConstructorParameters<typeof ChatAnthropic>[0]);
  }

  invocationParams(options?: Parameters<ChatAnthropic["invocationParams"]>[0]) {
    return {
      ...super.invocationParams(options),
      cache_control: { type: "ephemeral" as const },
    };
  }
}

// DeepSeek caches automatically and has no `cache_control`, so only the
// Anthropic models get the caching subclass. OpenRouter passes the prompt on to
// whichever provider serves the model, and each one applies its own caching.
export const MODELS = {
  [ModelType.DEEPSEEK_V4_FLASH]: ChatDeepSeek,
  [ModelType.DEEPSEEK_V4_PRO]: ChatDeepSeek,
  [ModelType.OPUS_4_8]: CachingChatAnthropic,
  [ModelType.SONNET_5_0]: CachingChatAnthropic,
  [ModelType.OPUS_5_0]: CachingChatAnthropic,
  [ModelType.OPENROUTER_GEMINI_3_7_FLASH]: ChatOpenRouter,
  [ModelType.OPENROUTER_GPT_5]: ChatOpenRouter,
  [ModelType.OPENROUTER_GROK_4_6]: ChatOpenRouter,
  [ModelType.OPENROUTER_LLAMA_4_SCOUT]: ChatOpenRouter,
  [ModelType.OPENROUTER_LLAMA_3_3_70B]: ChatOpenRouter,
  [ModelType.OPENROUTER_FREE_NEMOTRON_ULTRA]: ChatOpenRouter,
  [ModelType.OPENROUTER_FREE_NEMOTRON_LIGHTNING]: ChatOpenRouter,
  [ModelType.OPENROUTER_FREE_GEMMA_4_31B]: ChatOpenRouter,
}

/**
 * Which key each model authenticates with.
 *
 * A map rather than comparing the constructor against `ChatAnthropic`: the
 * Anthropic entries are a subclass, so an identity check fails on them and
 * every Claude model is rejected as invalid.
 */
export const MODEL_API_KEY_ENV: Record<ModelType, string> = {
  [ModelType.DEEPSEEK_V4_FLASH]: "DEEP_SEEK_API_KEY",
  [ModelType.DEEPSEEK_V4_PRO]: "DEEP_SEEK_API_KEY",
  [ModelType.OPUS_4_8]: "ANTHROPIC_API_KEY",
  [ModelType.SONNET_5_0]: "ANTHROPIC_API_KEY",
  [ModelType.OPUS_5_0]: "ANTHROPIC_API_KEY",
  // One key for every model behind the gateway, whoever ends up serving it.
  [ModelType.OPENROUTER_GEMINI_3_7_FLASH]: "OPENROUTER_API_KEY",
  [ModelType.OPENROUTER_GPT_5]: "OPENROUTER_API_KEY",
  [ModelType.OPENROUTER_GROK_4_6]: "OPENROUTER_API_KEY",
  [ModelType.OPENROUTER_LLAMA_4_SCOUT]: "OPENROUTER_API_KEY",
  [ModelType.OPENROUTER_LLAMA_3_3_70B]: "OPENROUTER_API_KEY",
  // Free models still authenticate — the key identifies the account whose
  // free-tier allowance the request draws on.
  [ModelType.OPENROUTER_FREE_NEMOTRON_ULTRA]: "OPENROUTER_API_KEY",
  [ModelType.OPENROUTER_FREE_NEMOTRON_LIGHTNING]: "OPENROUTER_API_KEY",
  [ModelType.OPENROUTER_FREE_GEMMA_4_31B]: "OPENROUTER_API_KEY",
}
