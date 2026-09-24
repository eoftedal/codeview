/**
 * A model server the reader runs themselves — Ollama, LM Studio, llama.cpp's `server`, vLLM. All
 * four speak OpenAI's `/chat/completions` with SSE, which is the same shape `openrouter.ts` speaks,
 * so the streaming is `./openaiCompatible.ts`'s and what is left here is this provider's own four
 * facts: where it posts, what ceiling it allows, how it asks for a thought, and how it words a
 * failure.
 *
 * **This is not a second exception to "every model runs on the reader's machine" — it is that rule,
 * reached by a different road.** The code never leaves the machine, nothing downloads into the
 * browser and no key is spent; what crosses the wire is a loopback request to a server the reader
 * started. It sits beside `openrouter.ts` only because they share an API, and the two should not be
 * read as two kinds of the same thing.
 *
 * The gate is the base URL, not the build mode — see `./localServerUrl.ts` for why that is a
 * choice about CORS and Chrome's local-network prompt rather than about mixed content.
 */

import { type Availability, type LoadOptions, type ModelEngine, type Provider } from '../chat'
import { getLocalServerUrl } from './localServerUrl'
import { refreshLocalServerModels } from './localServerModels'
import { openAiEngine } from './openaiCompatible'

/**
 * The ceiling for one answer, in tokens — the same figure, and for the same reason, as
 * `openrouter.ts`'s: on this API `max_tokens` also pays for the reasoning, so `ceiling.ts`'s 4096
 * would leave a thinking model having spent its whole allowance and come back with no answer.
 *
 * That `MAX_NEW_TOKENS` exists to stop a local model that loops does apply here in a way it does
 * not to a hosted one — but the two guards that matter are already in place: reaching this is
 * reported rather than swallowed (`AskOptions.onTruncated`), and the reader has a stop button on a
 * server whose GPU is their own.
 */
const MAX_LOCAL_TOKENS = 16_384

/** The OpenAI error body, which all four of these servers produce for a bad request — and a couple
 *  of statuses worth naming, since a model that is not pulled is the common one. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } | string }
    const message = typeof body.error === 'string' ? body.error : body.error?.message
    if (message) return `Local server: ${message}`
  } catch {
    // Not JSON, or no message in it — fall through to the status.
  }
  if (response.status === 404) {
    return 'Local server: no such model — check it is pulled and the name matches exactly.'
  }
  if (response.status === 401 || response.status === 403) {
    return 'Local server: refused the request — it may be expecting an API key.'
  }
  return `Local server: request failed (${response.status})`
}

/** The failure this provider actually produces, and the one a bare `TypeError: Failed to fetch`
 *  describes worst. All three causes are worth naming, because which one it is decides what the
 *  reader does next, and none of them is visible from the browser side. */
function networkMessage(): string {
  const base = getLocalServerUrl() ?? 'the configured address'
  return (
    `No server answered at ${base} — check it is running, that the address and port are ` +
    `right, and that it allows requests from ${location.origin} ` +
    `(Ollama needs OLLAMA_ORIGINS set for anything but a loopback page).`
  )
}

/** An error the server reported inside the stream rather than as a status — a runtime that hit a
 *  fault mid-answer, in its own words where it gave any. */
function streamError(error: { message?: string } | undefined): string {
  return error?.message
    ? `Local server: ${error.message}`
    : 'Local server: the answer stopped with an error the server did not describe'
}

/**
 * How a local server is asked to think, or not, on a question — for an entry the reader flagged as
 * able to. Two fields, because these servers read two different ones and each ignores the other:
 *
 * - `chat_template_kwargs.enable_thinking` is llama.cpp's and vLLM's road to a model's own
 *   template switch (Qwen3, Gemma 4, GLM) — the same flag the ONNX pipeline reaches through
 *   `tokenizer_encode_kwargs`;
 * - `reasoning_effort` is what Ollama's `/v1/chat/completions` reads, and it reads nothing else —
 *   `chat_template_kwargs` never reaches its template, which is why the first field alone left
 *   the switch dead there. `"none"` turns a thinking model off; any effort turns a model with a
 *   plain on/off mode on, and names a level on one that has levels (gpt-oss). llama.cpp and vLLM
 *   read it too, for the templates that have an effort to apply.
 *
 * Sent **only** for a flagged entry: these servers disagree about unknown body fields, and a
 * discovered entry — which `/models` cannot flag, though the settings panel now can — must not be
 * the one that finds out. Ollama also answers a thinking request on a model that has no such mode
 * with an error saying so, which is the right answer for a reader who flagged one that cannot.
 */
export function localReasoningFields(reasons: boolean, asked: boolean): Record<string, unknown> {
  if (!reasons) return {}
  return {
    chat_template_kwargs: { enable_thinking: asked },
    reasoning_effort: asked ? 'medium' : 'none',
  }
}

export const localServer: Provider = {
  /**
   * No URL is this provider's `'needs-key'`: a fact about the reader's own settings rather than
   * about the browser, so the entry is not hidden for it — though with no URL there are no entries
   * to hide, since `localServerChoices()` is empty until one is set.
   *
   * With a URL, the probe is a real request: `/models` both settles whether anything is listening
   * and refreshes what the picker offers, so availability and the catalogue come from one call.
   * `useModel.probe()` wraps this in its own try/catch, but a refusal is reported rather than
   * thrown — "no server there" is an ordinary state here, not an error.
   */
  async availability(): Promise<Availability> {
    if (!getLocalServerUrl()) return 'needs-key'
    return (await refreshLocalServerModels()) ? 'available' : 'unavailable'
  },

  async load({ model, thinking, sampling, thinkingSampling }: LoadOptions): Promise<ModelEngine> {
    if (!model) throw new Error('A local model server needs a model name.')
    // `useModel.load()` already refuses to reach this with no URL, but a URL cleared between that
    // check and this call should still fail plainly rather than post to a relative path.
    const base = getLocalServerUrl()
    if (!base) {
      throw new Error('No local model server is configured — add its address in the chat settings.')
    }

    return openAiEngine(
      {
        endpoint: `${base}/chat/completions`,
        headers: {},
        maxTokens: MAX_LOCAL_TOKENS,
        // Unlike OpenRouter's fleet, one local runtime accepts this uniformly: it is the reader's
        // own server, and a model's own `generation_config` is what the catalogue leaves alone.
        repetitionPenalty: true,
        reasoningFields: localReasoningFields,
        errorMessage,
        networkMessage,
        streamError,
      },
      { model, thinking, sampling, thinkingSampling },
    )
  },
}
