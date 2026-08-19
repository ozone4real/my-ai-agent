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
