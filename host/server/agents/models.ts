import { ChatAnthropic } from "@langchain/anthropic";
import { ChatDeepSeek } from "@langchain/deepseek";

/**
 * ChatAnthropic that asks Anthropic to cache the prompt prefix.
 *
 * Nothing sends `cache_control` on its own — not the API, and not
 * `@langchain/anthropic`, whose only mention of it is a pass-through from
 * per-call options (`cache_control: options?.cache_control`). Without it every
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

export enum ModelType {
  OPUS_4_8 = "claude-opus-4-8",
  SONNET_5_0 = "claude-sonnet-5",
  OPUS_5_0 = "claude-opus-5",
  DEEPSEEK_V4_FLASH = "deepseek-v4-flash",
  DEEPSEEK_V4_PRO = "deepseek-v4-pro"
}

// DeepSeek caches automatically and has no `cache_control`, so only the
// Anthropic models get the caching subclass.
export const MODELS = {
  [ModelType.DEEPSEEK_V4_FLASH]: ChatDeepSeek,
  [ModelType.DEEPSEEK_V4_PRO]: ChatDeepSeek,
  [ModelType.OPUS_4_8]: CachingChatAnthropic,
  [ModelType.SONNET_5_0]: CachingChatAnthropic,
  [ModelType.OPUS_5_0]: CachingChatAnthropic
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
}
