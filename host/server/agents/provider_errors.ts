// Turning a provider's failure into something a user can act on.
//
// Every provider reports the same handful of conditions differently — and by
// the time an error reaches a route it has been through LangChain, so the
// status is often only present as text at the front of the message. Both are
// checked: the structured field first, the message as a fallback.

/** What the user is told, and whether waiting is the fix. */
export interface ProviderFailure {
  message: string
  /** True when the same request would likely succeed later, unchanged. */
  retryable: boolean
  /** HTTP status for the non-streaming path. 500 means we didn't recognise it. */
  status: number
}

/** Providers put the HTTP status in different places; none of them are typed. */
const statusOf = (error: unknown): number | null => {
  const candidate = error as { status?: unknown; response?: { status?: unknown } }
  for (const value of [candidate?.status, candidate?.response?.status]) {
    if (typeof value === "number") return value
  }
  // LangChain re-throws with the status stringified into the message, e.g.
  // `400 {"type":"error",...}`.
  const leading = /^(\d{3})\b/.exec(messageOf(error))
  return leading ? Number(leading[1]) : null
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Describe a failed model call.
 *
 * Matching is on the message text as well as the status because the status
 * alone doesn't separate these: Anthropic reports an exhausted balance as 400,
 * the same code it uses for a malformed request.
 */
export const describeProviderError = (error: unknown): ProviderFailure => {
  const status = statusOf(error)
  const text = messageOf(error).toLowerCase()

  // 402 is the standard code (DeepSeek, OpenRouter); Anthropic uses 400 with
  // "credit balance is too low", OpenAI "insufficient_quota".
  const outOfCredit =
    status === 402 ||
    text.includes("credit balance is too low") ||
    text.includes("insufficient balance") ||
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota")
  if (outOfCredit) {
    return {
      message:
        "API credit exhausted for this model. Try another model, or top up the " +
        "provider account and try again.",
      // Nothing changes until someone pays, so this is not worth a retry.
      retryable: false,
      status: 402,
    }
  }

  if (status === 429 || text.includes("rate limit") || text.includes("rate_limit")) {
    return {
      message:
        "Rate limit reached for this model. Wait a moment and try again, or " +
        "switch to another model.",
      retryable: true,
      status: 429,
    }
  }

  if (status === 401 || status === 403 || text.includes("invalid api key")) {
    return {
      message:
        "This model's API key was rejected. Check the provider key in the " +
        "server environment, or pick a model on a different provider.",
      retryable: false,
      // Not 401: the caller's own credentials are fine, ours are not.
      status: 502,
    }
  }

  // 529 is Anthropic's "overloaded"; 5xx generally means the provider, not us.
  if (text.includes("overloaded") || (status !== null && status >= 500)) {
    return {
      message:
        "The model provider is unavailable right now. Try again shortly, or " +
        "switch to another model.",
      retryable: true,
      status: 503,
    }
  }

  // Unrecognised: as likely a bug on our side as the provider's, so 500.
  return { message: "Server error", retryable: false, status: 500 }
}
