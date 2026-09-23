/**
 * OpenRouter: the one hosted provider in this catalogue. Everything else here runs on the reader's
 * own machine; this one sends the system prompt, the open files and every question to
 * `openrouter.ai` over `fetch`, using a key the reader supplies themselves (`./openrouterKey.ts`).
 * Its `/api/v1/chat/completions` endpoint is OpenAI-compatible and — unlike Anthropic's or
 * Google's own APIs — allows CORS from a browser origin, so no backend of ours is needed even for
 * this exception.
 *
 * Shaped closest to `builtin.ts` in that there is no Worker: network I/O does not block the main
 * thread the way on-device inference does, so nothing here needs to be kept off it. The streaming
 * itself lives in `./openaiCompatible.ts`, shared with `./localServer.ts` — what is left here is
 * the four things that are OpenRouter's own: its URL, its headers, its generation ceiling and the
 * wording of its failures.
 */

import { type Availability, type LoadOptions, type ModelEngine, type Provider } from '../chat'
import { openAiEngine } from './openaiCompatible'
import { getOpenRouterKey } from './openrouterKey'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * The ceiling for one answer, in tokens. Deliberately not `ceiling.ts`'s `MAX_NEW_TOKENS`: that one
 * exists to stop a local model that never emits its end of turn, and 4096 is roomy for that. Here
 * `max_tokens` also pays for the reasoning — on an OpenAI-compatible API the thought is spent from
 * the same allowance — and a hosted reasoning model can think through 4096 tokens and come back
 * with no answer at all. Nothing on this side is looping, and the cost is the reader's own key,
 * so the figure only has to be high enough to be out of the way.
 */
const MAX_HOSTED_TOKENS = 16_384

/** OpenRouter's own error body shape, read for a message worth showing rather than a bare status
 *  code — the reader typed a key or picked a model, and the failure is usually about one of those. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    if (body.error?.message) return `OpenRouter: ${body.error.message}`
  } catch {
    // Not JSON, or no `error.message` — fall through to the status.
  }
  if (response.status === 401) return 'OpenRouter: invalid API key'
  if (response.status === 402) return 'OpenRouter: insufficient credits'
  if (response.status === 429) return 'OpenRouter: rate limited, try again shortly'
  return `OpenRouter: request failed (${response.status})`
}

export const openrouter: Provider = {
  async availability(): Promise<Availability> {
    return getOpenRouterKey() !== null ? 'available' : 'needs-key'
  },

  async load({ model, thinking, sampling, thinkingSampling }: LoadOptions): Promise<ModelEngine> {
    if (!model) throw new Error('OpenRouter needs a model id.')
    // `useModel.engine()`/`engineFor()` already refuse to reach this without a key — see
    // `useModel.ts` — but a key cleared between that check and this call (or a caller that skips
    // it) should still fail plainly rather than send an unauthenticated request. Captured once and
    // closed over by every session this engine opens.
    const key = getOpenRouterKey()
    if (!key) throw new Error('OpenRouter needs an API key — add one in the chat settings.')

    return openAiEngine(
      {
        endpoint: ENDPOINT,
        headers: {
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': location.origin,
          'X-Title': 'codeview',
        },
        maxTokens: MAX_HOSTED_TOKENS,
        // Not uniformly accepted across the models OpenRouter fronts, so no shipped entry carries
        // one and none is sent — `tests/chat.test.ts` holds that end of it.
        repetitionPenalty: false,
        // Only a model with a thinking mode is asked about it, the same rule the on-device
        // providers apply.
        reasoningFields: (reasons, asked) => (reasons ? { reasoning: { enabled: asked } } : {}),
        errorMessage,
        networkMessage: () => 'OpenRouter could not be reached — check this machine’s connection.',
      },
      { model, thinking, sampling, thinkingSampling },
    )
  },
}
