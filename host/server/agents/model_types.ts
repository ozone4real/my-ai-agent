// The model catalogue as plain data — deliberately free of imports.
//
// `agents/models.ts` maps these to LangChain classes, which drags in the whole
// provider runtime. Mongoose models and the MCP server only need the *names*,
// so they import this instead and the app MCP server's bundle stays free of
// LangChain.

/**
 * A model the agent can run on.
 *
 * The value is the id the provider expects, so adding a model is one entry here
 * plus one in each map in `agents/models.ts`. Settings, conversations and tasks
 * all validate against these, so a new entry is offered everywhere at once.
 *
 * OpenRouter entries carry their `vendor/model` id verbatim — that slash is
 * what tells the two apart at a glance. OpenRouter publishes 400+ models, so
 * the ones below are a starting set rather than the limit: anything from
 * `https://openrouter.ai/api/v1/models` works.
 */
export enum ModelType {
  OPUS_4_8 = "claude-opus-4-8",
  SONNET_5_0 = "claude-sonnet-5",
  OPUS_5_0 = "claude-opus-5",
  DEEPSEEK_V4_FLASH = "deepseek-v4-flash",
  DEEPSEEK_V4_PRO = "deepseek-v4-pro",
  // Via OpenRouter — providers this app has no direct integration for.
  OPENROUTER_GEMINI_3_7_FLASH = "google/gemini-3.7-flash",
  OPENROUTER_GPT_5 = "openai/gpt-5",
  OPENROUTER_GROK_4_6 = "x-ai/grok-4.6",
  // Llama. No free variant exists on OpenRouter, but these are cheap enough to
  // be the sensible alternative to the free tier: ~$0.10/M in, with none of its
  // request caps or prompt retention. Scout carries a 1.3M context.
  OPENROUTER_LLAMA_4_SCOUT = "meta-llama/llama-4-scout",
  OPENROUTER_LLAMA_3_3_70B = "meta-llama/llama-3.3-70b-instruct",
  // Free tier. The `:free` suffix is OpenRouter's, and it is the whole
  // difference — the same id without it is the paid variant. Only models that
  // advertise tool calling are listed: the agent binds ~15 tools, and one that
  // cannot call them is useless here however cheap it is.
  //
  // Read the free-tier caveats on FREE_MODELS before making one a default.
  OPENROUTER_FREE_NEMOTRON_ULTRA = "nvidia/nemotron-3-ultra-550b-a55b:free",
  OPENROUTER_FREE_NEMOTRON_LIGHTNING = "nvidia/nemotron-3.5-lightning:free",
  OPENROUTER_FREE_GEMMA_4_31B = "google/gemma-4-31b-it:free",
}

/** Every model id, for enum validation and the Settings dropdown. */
export const MODEL_CHOICES = Object.values(ModelType);

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
  ModelType.OPENROUTER_FREE_GEMMA_4_31B,
])
