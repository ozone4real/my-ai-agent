// Resolve each model family to the newest version its provider lists.
//
// Read at startup and once a day after, so a long-running process picks up new
// versions without a restart. Until a list has been read, or when it can't be,
// a family runs on its fallback id.

import { MODEL_CHOICES, MODEL_FAMILIES, type ModelType, type Provider } from "./model_types.js";
import { PROVIDERS } from "./models.js";

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

const latest = new Map<ModelType, string>()

/** The provider id to call for a family, e.g. "claude-opus" -> "claude-opus-5-5". */
export const latestModelId = (family: ModelType): string =>
  latest.get(family) ?? MODEL_FAMILIES[family].fallback

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json() as Promise<T>
}

const apiKey = (provider: Provider) => process.env[PROVIDERS[provider].apiKeyEnv]

/** A model a provider offers; `created` is epoch ms, when the provider says. */
interface Listed {
  id: string
  created?: number
}

/** Models each provider offers. Empty when its key isn't configured. */
const LIST_MODELS: Record<Provider, () => Promise<Listed[]>> = {
  anthropic: async () => {
    const key = apiKey("anthropic")
    if (!key) return []
    const { data } = await getJson<{ data: { id: string; created_at: string }[] }>(
      "https://api.anthropic.com/v1/models?limit=1000",
      { "x-api-key": key, "anthropic-version": "2023-06-01" }
    )
    return data.map((model) => ({ id: model.id, created: Date.parse(model.created_at) }))
  },
  deepseek: async () => {
    const key = apiKey("deepseek")
    if (!key) return []
    const { data } = await getJson<{ data: { id: string }[] }>(
      "https://api.deepseek.com/models",
      { authorization: `Bearer ${key}` }
    )
    return data.map((model) => ({ id: model.id }))
  },
  // Public, no key needed. Only models that can call tools are any use here.
  openrouter: async () => {
    const { data } = await getJson<
      { data: { id: string; created: number; supported_parameters?: string[] }[] }
    >("https://openrouter.ai/api/v1/models")
    return data
      .filter((model) => model.supported_parameters?.includes("tools"))
      .map((model) => ({ id: model.id, created: model.created * 1000 }))
  },
}

const versionParts = (version = "") => version.split(/[.-]/).filter(Boolean).map(Number)

function compareVersions(a?: string, b?: string): number {
  const [x, y] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

type Candidate = Listed & { version?: string }

/**
 * Release date first, where the provider gives one: version numbers don't
 * always rise — xAI's grok-4.20 came out months before grok-4.7.
 */
function isNewer(a: Candidate, b: Candidate): boolean {
  if (a.created && b.created && a.created !== b.created) return a.created > b.created
  return compareVersions(a.version, b.version) > 0
}

/** The newest listed model that belongs to the family, if any does. */
function newest(models: Listed[], pattern: RegExp): string | undefined {
  let best: Candidate | undefined
  for (const model of models) {
    const match = pattern.exec(model.id)
    if (!match) continue
    const candidate = { ...model, version: match[1] }
    if (!best || isNewer(candidate, best)) best = candidate
  }
  return best?.id
}

async function refreshProvider(provider: Provider): Promise<void> {
  const models = await LIST_MODELS[provider]()
  for (const family of MODEL_CHOICES) {
    const { provider: owner, pattern } = MODEL_FAMILIES[family]
    if (owner !== provider) continue
    const id = newest(models, pattern)
    if (id) latest.set(family, id)
  }
}

/** Best-effort per provider: one that can't be reached keeps what it had. */
export async function refreshLatestModels(): Promise<void> {
  await Promise.all(
    (Object.keys(LIST_MODELS) as Provider[]).map((provider) =>
      refreshProvider(provider).catch((err: unknown) =>
        console.warn(
          `${provider}: could not list models, keeping the current versions: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      )
    )
  )
}

/** Resolve now, then daily. Call once per process at startup. */
export function watchLatestModels(): Promise<void> {
  setInterval(() => void refreshLatestModels(), REFRESH_INTERVAL_MS).unref()
  return refreshLatestModels()
}
