/**
 * OpenRouter: the one hosted provider in this catalogue. Everything else here runs on the reader's
 * own machine; this one sends the system prompt, the open files and every question to
 * `openrouter.ai` over `fetch`, using a key the reader supplies themselves (`./openrouterKey.ts`).
 * Its `/api/v1/chat/completions` endpoint is OpenAI-compatible and — unlike Anthropic's or
 * Google's own APIs — allows CORS from a browser origin, so no backend of ours is needed even for
 * this exception.
 *
 * Shaped closest to `builtin.ts` in that there is no Worker: network I/O does not block the main
 * thread the way on-device inference does, so nothing here needs to be kept off it. But unlike
 * `builtin.ts` there is no browser-native session object to lean on, so this provider does the same
 * streaming/history/abort/truncation bookkeeping `webllm.ts` and `transformers.ts` do, over SSE
 * instead of a library's own stream.
 */

import {
  CODE_ACK,
  type Availability,
  type LoadOptions,
  type ModelEngine,
  type Provider,
} from '../chat'
import { getOpenRouterKey } from './openrouterKey'
import { foldReasoning, withoutThoughts } from './thoughts'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

type Message = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * The ceiling for one answer, in tokens. Deliberately not `ceiling.ts`'s `MAX_NEW_TOKENS`: that one
 * exists to stop a local model that never emits its end of turn, and 4096 is roomy for that. Here
 * `max_tokens` also pays for the reasoning — on an OpenAI-compatible API the thought is spent from
 * the same allowance — and a hosted reasoning model can think through 4096 tokens and come back
 * with no answer at all. Nothing on this side is looping, and the cost is the reader's own key,
 * so the figure only has to be high enough to be out of the way.
 */
const MAX_HOSTED_TOKENS = 16_384

interface Delta {
  choices?: {
    /** `reasoning` is where OpenRouter puts a thinking model's thought, beside the answer rather
     *  than in it — see `foldReasoning`. */
    delta?: { content?: string; reasoning?: string }
    finish_reason?: string | null
  }[]
}

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

  async load({
    model,
    thinking: reasons,
    sampling,
    thinkingSampling,
  }: LoadOptions): Promise<ModelEngine> {
    if (!model) throw new Error('OpenRouter needs a model id.')
    // `useModel.engine()`/`engineFor()` already refuse to reach this without a key — see
    // `useModel.ts` — but a key cleared between that check and this call (or a caller that skips
    // it) should still fail plainly rather than send an unauthenticated request.
    const key = getOpenRouterKey()
    if (!key) throw new Error('OpenRouter needs an API key — add one in the chat settings.')

    return {
      // Completions are stateless here too: a conversation is nothing but its own turns.
      async chat(system, code) {
        const messages: Message[] = [
          { role: 'system', content: system },
          ...(code
            ? ([
                { role: 'user', content: code },
                { role: 'assistant', content: CODE_ACK },
              ] as Message[])
            : []),
        ]

        return {
          promptStreaming(input, options) {
            messages.push({ role: 'user', content: input })
            let answer = ''
            // Per question, the same as WebLLM: a card that names a thinking row names another
            // for answering plainly. No shipped OpenRouter entry carries either yet.
            const row =
              (options?.thinking === true ? thinkingSampling : undefined) ?? sampling ?? {}

            return new ReadableStream<string>({
              async start(controller) {
                const controllerAbort = new AbortController()
                const onAbort = () => controllerAbort.abort()
                options?.signal?.addEventListener('abort', onAbort, { once: true })

                try {
                  const response = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${key}`,
                      'Content-Type': 'application/json',
                      'HTTP-Referer': location.origin,
                      'X-Title': 'codeview',
                    },
                    body: JSON.stringify({
                      model,
                      messages,
                      stream: true,
                      max_tokens: MAX_HOSTED_TOKENS,
                      ...(row.temperature !== undefined ? { temperature: row.temperature } : {}),
                      ...(row.topP !== undefined ? { top_p: row.topP } : {}),
                      ...(row.presencePenalty !== undefined
                        ? { presence_penalty: row.presencePenalty }
                        : {}),
                      // Only a model with a thinking mode is asked about it, the same rule the
                      // on-device providers apply.
                      ...(reasons ? { reasoning: { enabled: options?.thinking === true } } : {}),
                    }),
                    signal: controllerAbort.signal,
                  })

                  if (!response.ok || !response.body) {
                    throw new Error(await errorMessage(response))
                  }

                  const reader = response.body.getReader()
                  const decoder = new TextDecoder()
                  let buffer = ''
                  let truncated = false
                  // Folded whether or not the model was asked to think: a custom slug that
                  // reasons by default still streams its thought here, and it must not vanish.
                  const fold = foldReasoning()
                  const emit = (text: string) => {
                    if (!text) return
                    answer += text
                    controller.enqueue(text)
                  }

                  for (;;) {
                    const { done, value } = await reader.read()
                    if (done) break
                    buffer += decoder.decode(value, { stream: true })
                    const events = buffer.split('\n\n')
                    buffer = events.pop() ?? ''
                    for (const event of events) {
                      const line = event.trim()
                      if (!line.startsWith('data:')) continue
                      const data = line.slice('data:'.length).trim()
                      if (data === '[DONE]') continue
                      const parsed = JSON.parse(data) as Delta
                      const choice = parsed.choices?.[0]
                      if (choice?.finish_reason === 'length') truncated = true
                      emit(fold.delta(choice?.delta?.reasoning, choice?.delta?.content))
                    }
                  }
                  emit(fold.end())

                  messages.push({ role: 'assistant', content: withoutThoughts(answer) })
                  if (options?.signal?.aborted) {
                    controller.error(new DOMException('Aborted', 'AbortError'))
                  } else {
                    if (truncated) options?.onTruncated?.()
                    controller.close()
                  }
                } catch (caught) {
                  messages.push({ role: 'assistant', content: withoutThoughts(answer) })
                  if (options?.signal?.aborted) {
                    controller.error(new DOMException('Aborted', 'AbortError'))
                  } else {
                    controller.error(caught)
                  }
                } finally {
                  options?.signal?.removeEventListener('abort', onAbort)
                }
              },
            })
          },

          // Nothing local was ever allocated for this conversation.
          destroy() {},
        }
      },

      // No weights, no worker — nothing here to unload.
      destroy() {},
    }
  },
}
