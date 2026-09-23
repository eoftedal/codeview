/**
 * The OpenAI `/chat/completions` streaming client both `openrouter.ts` and `localServer.ts` are
 * built from. One shape, two roads to it: a hosted API reached with a key, and a server the reader
 * runs themselves. Neither has a library to lean on the way `webllm.ts` does, so all of the
 * streaming, history, abort and truncation bookkeeping lives here — once, because the three rules
 * at the bottom of `start()` are exactly the kind that drift when copied:
 *
 * 1. the partial answer goes into the history on **both** the success and the error path, so a
 *    follow-up about "that" still has something to point at;
 * 2. an aborted stream always fails as `DOMException('Aborted', 'AbortError')`, which is the one
 *    shape `stream.ts`'s `isAbort` recognises;
 * 3. `fold.end()` closes a `<think>` the stream left open, so an answer that was all thought is
 *    filed as a finished one rather than as thinking still in progress.
 *
 * What differs between the two providers is entirely `OpenAiConfig`: where to post, what headers to
 * send, how many tokens to allow, which body field asks for reasoning, and how a failure is worded.
 */

import { CODE_ACK, type LoadOptions, type ModelEngine } from '../chat'
import { foldReasoning, withoutThoughts } from './thoughts'

type Message = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * One SSE frame's payload. Four names for the same thing, because the servers disagree: OpenRouter
 * puts a thinking model's thought in `reasoning`, llama.cpp and LM Studio in `reasoning_content`,
 * Ollama in `thinking`. A server that instead writes `<think>` tags into `content` needs nothing
 * here — `markdown.ts` already folds that syntax. Reading only one of the four would silently drop
 * the thought on two of the three.
 */
interface Delta {
  choices?: {
    delta?: {
      content?: string
      reasoning?: string
      reasoning_content?: string
      thinking?: string
    }
    finish_reason?: string | null
  }[]
}

export interface OpenAiConfig {
  /** The full chat-completions URL, not a base — the two providers spell the path differently. */
  endpoint: string
  headers: Record<string, string>
  /** The ceiling for one answer, in tokens. On this API the reasoning is spent from the same
   *  allowance as the answer, so it has to be roomy enough for both. */
  maxTokens: number
  /** Whether a `repetition_penalty` in the sampling row is sent. OpenRouter drops it — not
   *  uniformly accepted across the models it fronts — while a local server takes it. */
  repetitionPenalty: boolean
  /** The provider's own way of asking for reasoning. `reasons` is whether this model *has* a
   *  thinking mode at all; `thinking` whether this question should use it. Returning `{}` sends
   *  nothing, which is the right answer for a server that may reject a field it does not know. */
  reasoningFields(reasons: boolean, thinking: boolean): Record<string, unknown>
  /** A message worth showing for a response that arrived but was not `ok`. */
  errorMessage(response: Response): Promise<string>
  /** A message for a `fetch` that produced no response at all — nothing listening, wrong port, or
   *  an origin the server does not allow. The status code path above cannot describe these. */
  networkMessage(): string
}

/** Everything of a `ModelChoice` this client reads. A subset of `LoadOptions`, since neither
 *  provider downloads anything: no progress, no quantisation, no device split. */
type Options = Pick<LoadOptions, 'model' | 'thinking' | 'sampling' | 'thinkingSampling'>

export function openAiEngine(config: OpenAiConfig, options: Options): ModelEngine {
  const { model, thinking: reasons, sampling, thinkingSampling } = options

  return {
    // Completions are stateless on this API: a conversation is nothing but its own turns.
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
        promptStreaming(input, askOptions) {
          messages.push({ role: 'user', content: input })
          let answer = ''
          // Per question, the same as WebLLM: a card that names a thinking row names another for
          // answering plainly.
          const row =
            (askOptions?.thinking === true ? thinkingSampling : undefined) ?? sampling ?? {}

          return new ReadableStream<string>({
            async start(controller) {
              const controllerAbort = new AbortController()
              const onAbort = () => controllerAbort.abort()
              askOptions?.signal?.addEventListener('abort', onAbort, { once: true })

              try {
                const response = await fetch(config.endpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', ...config.headers },
                  body: JSON.stringify({
                    model,
                    messages,
                    stream: true,
                    max_tokens: config.maxTokens,
                    // Left out rather than sent as null, so the weights' own config still decides
                    // whatever the catalogue does not.
                    ...(row.temperature !== undefined ? { temperature: row.temperature } : {}),
                    ...(row.topP !== undefined ? { top_p: row.topP } : {}),
                    ...(row.presencePenalty !== undefined
                      ? { presence_penalty: row.presencePenalty }
                      : {}),
                    ...(config.repetitionPenalty && row.repetitionPenalty !== undefined
                      ? { repetition_penalty: row.repetitionPenalty }
                      : {}),
                    ...config.reasoningFields(reasons === true, askOptions?.thinking === true),
                  }),
                  signal: controllerAbort.signal,
                })

                if (!response.ok || !response.body) {
                  throw new Error(await config.errorMessage(response))
                }

                const reader = response.body.getReader()
                const decoder = new TextDecoder()
                let buffer = ''
                let truncated = false
                // Folded whether or not the model was asked to think: a model that reasons by
                // default still streams its thought here, and it must not vanish.
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
                    // Skips both `[DONE]` and a server's comment keep-alives — OpenRouter's
                    // `: OPENROUTER PROCESSING`, llama.cpp's own.
                    if (!line.startsWith('data:')) continue
                    const data = line.slice('data:'.length).trim()
                    if (data === '[DONE]') continue
                    const parsed = JSON.parse(data) as Delta
                    const choice = parsed.choices?.[0]
                    if (choice?.finish_reason === 'length') truncated = true
                    const delta = choice?.delta
                    emit(
                      fold.delta(
                        delta?.reasoning ?? delta?.reasoning_content ?? delta?.thinking,
                        delta?.content,
                      ),
                    )
                  }
                }
                emit(fold.end())

                messages.push({ role: 'assistant', content: withoutThoughts(answer) })
                if (askOptions?.signal?.aborted) {
                  controller.error(new DOMException('Aborted', 'AbortError'))
                } else {
                  if (truncated) askOptions?.onTruncated?.()
                  controller.close()
                }
              } catch (caught) {
                messages.push({ role: 'assistant', content: withoutThoughts(answer) })
                if (askOptions?.signal?.aborted) {
                  controller.error(new DOMException('Aborted', 'AbortError'))
                } else {
                  // `fetch` rejects with a `TypeError` when it never reached a server at all, and
                  // the bare "Failed to fetch" that carries says nothing a reader can act on. A
                  // non-ok response threw above with a message of its own, so it is left alone.
                  controller.error(
                    caught instanceof TypeError ? new Error(config.networkMessage()) : caught,
                  )
                }
              } finally {
                askOptions?.signal?.removeEventListener('abort', onAbort)
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
}
