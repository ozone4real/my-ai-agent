// The model catalogue as plain data — deliberately free of imports.
//
// `agents/models.ts` maps these to LangChain classes, which drags in the whole
// provider runtime. Mongoose models and the MCP server only need the *names*,
// so they import this instead and the app MCP server's bundle stays free of
// LangChain.

/**
 * A model family the agent can run on, e.g. "claude-opus" rather than
 * "claude-opus-5-5".
 *
 * Settings, conversations and tasks store the family; the version is resolved
 * at runtime to the newest one the provider lists (see `latest_models.ts`), so
 * a new version needs no change here. Adding a family is one entry here plus
 * one in {@link MODEL_FAMILIES}.
 *
 * OpenRouter entries keep their `vendor/` prefix — that slash is what tells the
 * providers apart at a glance.
 */
export enum ModelType {
  CLAUDE_FABLE = "claude-fable",
  CLAUDE_OPUS = "claude-opus",
  CLAUDE_SONNET = "claude-sonnet",
  CLAUDE_HAIKU = "claude-haiku",
  DEEPSEEK_FLASH = "deepseek-flash",
  DEEPSEEK_PRO = "deepseek-pro",
  // Via OpenRouter — providers this app has no direct integration for.
  OPENROUTER_GEMINI_FLASH = "google/gemini-flash",
  OPENROUTER_GPT = "openai/gpt",
  OPENROUTER_GPT_SOL = "openai/gpt-sol",
  OPENROUTER_GPT_SOL_PRO = "openai/gpt-sol-pro",
  OPENROUTER_GPT_TERRA = "openai/gpt-terra",
  OPENROUTER_GPT_TERRA_PRO = "openai/gpt-terra-pro",
  OPENROUTER_GPT_LUNA = "openai/gpt-luna",
  OPENROUTER_GPT_LUNA_PRO = "openai/gpt-luna-pro",
  OPENROUTER_GPT_ASTRA = "openai/gpt-astra",
  OPENROUTER_GPT_ASTRA_PRO = "openai/gpt-astra-pro",
  OPENROUTER_GROK = "x-ai/grok",
  // Paid, despite sitting close to the free tier in price: $0.075/M in,
  // $0.25/M out, with a 1M context and tool calling.
  OPENROUTER_GLM_FLASH = "z-ai/glm-flash",
  // Llama. No free variant exists on OpenRouter, but these are cheap enough to
  // be the sensible alternative to the free tier: ~$0.10/M in, with none of its
  // request caps or prompt retention.
  OPENROUTER_LLAMA_SCOUT = "meta-llama/llama-scout",
  OPENROUTER_LLAMA_70B = "meta-llama/llama-70b-instruct",
  // Free tier. The `:free` suffix is OpenRouter's, and it is the whole
  // difference — the same id without it is the paid variant.
  //
  // Read the free-tier caveats on FREE_MODELS before making one a default.
  // A router, not a model: it picks a free model at random per request, so
  // two runs of the same task can land on different ones. It filters for tool
  // calling, which the ~15 tools bound here need.
  OPENROUTER_FREE_ROUTER = "openrouter/free",
  OPENROUTER_FREE_NEMOTRON_SUPER_VL = "nvidia/nemotron-super-vl:free",
  OPENROUTER_FREE_NEMOTRON_ULTRA = "nvidia/nemotron-ultra:free",
  OPENROUTER_FREE_NEMOTRON_LIGHTNING = "nvidia/nemotron-lightning:free",
  OPENROUTER_FREE_GEMMA_31B = "google/gemma-31b-it:free",
}

export type Provider = "anthropic" | "deepseek" | "openrouter"

export interface ModelFamily {
  provider: Provider
  /**
   * Matches every id in the family. The first capture group is the version,
   * compared numerically to find the newest. Anchored, so preview, lite and
   * fast variants are not mistaken for the family itself.
   */
  pattern: RegExp
  /** Used until the provider's list has been read, or when it can't be. */
  fallback: string
}

const VERSION = String.raw`(\d+(?:\.\d+)?)`
// Claude writes versions with a dash ("5-5") and may list dated snapshots.
const CLAUDE = (name: string) => new RegExp(String.raw`^claude-${name}-(\d+(?:-\d{1,2})?)(?:-\d{8})?$`)
const OPENROUTER = (prefix: string, suffix = "") => new RegExp(`^${prefix}${VERSION}${suffix}$`)

export const MODEL_FAMILIES: Record<ModelType, ModelFamily> = {
  [ModelType.CLAUDE_FABLE]: { provider: "anthropic", pattern: CLAUDE("fable"), fallback: "claude-fable-5-1" },
  [ModelType.CLAUDE_OPUS]: { provider: "anthropic", pattern: CLAUDE("opus"), fallback: "claude-opus-5-5" },
  [ModelType.CLAUDE_SONNET]: { provider: "anthropic", pattern: CLAUDE("sonnet"), fallback: "claude-sonnet-5-5" },
  [ModelType.CLAUDE_HAIKU]: { provider: "anthropic", pattern: CLAUDE("haiku"), fallback: "claude-haiku-5-5" },
  // "deepseek-flash" is unversioned, so it ranks below any "deepseek-vN-flash".
  [ModelType.DEEPSEEK_FLASH]: { provider: "deepseek", pattern: /^deepseek(?:-v(\d+(?:\.\d+)?))?-flash$/, fallback: "deepseek-v4-flash" },
  [ModelType.DEEPSEEK_PRO]: { provider: "deepseek", pattern: /^deepseek(?:-v(\d+(?:\.\d+)?))?-pro$/, fallback: "deepseek-v4-pro" },
  [ModelType.OPENROUTER_GEMINI_FLASH]: { provider: "openrouter", pattern: OPENROUTER("google/gemini-", "-flash"), fallback: "google/gemini-3.8-flash" },
  [ModelType.OPENROUTER_GPT]: { provider: "openrouter", pattern: OPENROUTER("openai/gpt-"), fallback: "openai/gpt-5" },
  [ModelType.OPENROUTER_GPT_SOL]: { provider: "openrouter", pattern: OPENROUTER("openai/gpt-", "-sol"), fallback: "openai/gpt-6.1-sol" },
  [ModelType.OPENROUTER_GPT_SOL_PRO]: { provider: "openrouter", pattern: OPENROUTER("openai/gpt-", "-sol-pro"), fallback: "openai/gpt-6.1-sol-pro" },
  [ModelType.OPENROUTER_GPT_TERRA]: { provider: "openrouter", pattern: OPENROUTER("openai/gpt-", "-terra"), fallback: "openai/gpt-6.1-terra" },
  [ModelType.OPENROUTER_GPT_TERRA_PRO]: { provider: "openrouter", pattern: OPENROUTER("openai/gpt-", "-terra-pro"), fallback: "openai/gpt-6.1-terra-pro" },
  [ModelType.OPENROUTER_GPT_LUNA]: { provider: "openrouter", pattern: OPENROUTER("openai/gpt-", "-luna"), fallback: "openai/gpt-6-luna" },
  [ModelType.OPENROUTER_GPT_LUNA_PRO]: { provider: "openrouter", pattern: OPENROUTER("openai/gpt-", "-luna-pro"), fallback: "openai/gpt-6-luna-pro" },
  [ModelType.OPENROUTER_GPT_ASTRA]: { provider: "openrouter", pattern: OPENROUTER("openai/gpt-", "-astra"), fallback: "openai/gpt-6-astra" },
  [ModelType.OPENROUTER_GPT_ASTRA_PRO]: { provider: "openrouter", pattern: OPENROUTER("openai/gpt-", "-astra-pro"), fallback: "openai/gpt-6-astra-pro" },
  [ModelType.OPENROUTER_GROK]: { provider: "openrouter", pattern: OPENROUTER("x-ai/grok-"), fallback: "x-ai/grok-4.7" },
  [ModelType.OPENROUTER_GLM_FLASH]: { provider: "openrouter", pattern: OPENROUTER("z-ai/glm-", "-flash"), fallback: "z-ai/glm-5.3-flash" },
  [ModelType.OPENROUTER_LLAMA_SCOUT]: { provider: "openrouter", pattern: OPENROUTER("meta-llama/llama-", "-scout"), fallback: "meta-llama/llama-4-scout" },
  [ModelType.OPENROUTER_LLAMA_70B]: { provider: "openrouter", pattern: OPENROUTER("meta-llama/llama-", "-70b-instruct"), fallback: "meta-llama/llama-3.3-70b-instruct" },
  [ModelType.OPENROUTER_FREE_ROUTER]: { provider: "openrouter", pattern: /^openrouter\/free$/, fallback: "openrouter/free" },
  [ModelType.OPENROUTER_FREE_NEMOTRON_SUPER_VL]: { provider: "openrouter", pattern: OPENROUTER("nvidia/nemotron-", "-super-vl:free"), fallback: "nvidia/nemotron-3.5-super-vl:free" },
  [ModelType.OPENROUTER_FREE_NEMOTRON_ULTRA]: { provider: "openrouter", pattern: OPENROUTER("nvidia/nemotron-", "-ultra(?:-[\\w-]+)?:free"), fallback: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  [ModelType.OPENROUTER_FREE_NEMOTRON_LIGHTNING]: { provider: "openrouter", pattern: OPENROUTER("nvidia/nemotron-", "-lightning:free"), fallback: "nvidia/nemotron-3.5-lightning:free" },
  [ModelType.OPENROUTER_FREE_GEMMA_31B]: { provider: "openrouter", pattern: OPENROUTER("google/gemma-", "-31b-it:free"), fallback: "google/gemma-4-31b-it:free" },
}

/** Every model family, for enum validation and the Settings dropdown. */
export const MODEL_CHOICES = Object.values(ModelType);

/** The family a stored or provider id belongs to — "claude-opus-5-5" -> "claude-opus". */
export function familyOf(id: string): ModelType | undefined {
  if (MODEL_CHOICES.includes(id as ModelType)) return id as ModelType
  return MODEL_CHOICES.find((family) => MODEL_FAMILIES[family].pattern.test(id))
}

/**
 * Models that cost nothing per token — and what that buys.
 *
 * Free on OpenRouter means rate-limited by request, not metered by token: a
 * daily request cap the agent can exhaust in a handful of runs, since one run
 * spends up to `maxSteps` model calls. Expect 429s mid-run rather than a bill.
 *
 * It usually also means the prompt is retained for training by the provider.
 * So treat a free model as unsuitable for anything you would not publish.
 */
export const FREE_MODELS: ReadonlySet<ModelType> = new Set([
  ModelType.OPENROUTER_FREE_NEMOTRON_ULTRA,
  ModelType.OPENROUTER_FREE_NEMOTRON_LIGHTNING,
  ModelType.OPENROUTER_FREE_GEMMA_31B,
  ModelType.OPENROUTER_FREE_NEMOTRON_SUPER_VL,
  ModelType.OPENROUTER_FREE_ROUTER,
])
