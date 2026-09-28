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
 *    filed as a finished one rather than as thinking still in progress;
 * 4. an error the server reports *inside* the stream fails the answer rather than ending it. Once
 *    the HTTP response is committed a status code can no longer say anything, so OpenRouter sends
 *    a provider dying mid-answer as an SSE chunk carrying an `error` object and a `finish_reason`
 *    of `error` — read only the delta and it is a short answer that happened to stop.
 *
 * What differs between the two providers is entirely `OpenAiConfig`: where to post, what headers to
 * send, how many tokens to allow, which body field asks for reasoning, and how a failure is worded.
 *
 * **This is also the one provider that can carry a tool call**, which is what turns a question from
 * one request into a loop of them: the model asks for a file, the answer is appended to the history
 * as a `tool` turn, and the same question is asked again with it. The loop is bounded
 * (`MAX_TOOL_ROUNDS`), and what it does when it reaches the bound is ask one more time with
 * `tool_choice: 'none'` rather than stopping — a question that ends in an answer, however partial,
 * beats one that ends in silence. Each call is written into the stream as *thinking*
 * (`<think>`), which is the honest place for it: it is the model working towards its answer, the
 * pane already folds it away, and `withoutThoughts` already keeps it out of both the history and
 * an agent's relay.
 */

import { CODE_ACK, type LoadOptions, type ModelEngine } from '../chat'
import { MAX_TOOL_ROUNDS, NO_READS_NOTE } from '../tools'
import { dropTokens, foldReasoning, protocolTokensFor, withoutThoughts } from './thoughts'

/** A turn as this API spells one. `tool_calls` rides the assistant turn that asked for them, and
 *  every one of them must be answered by a `tool` turn carrying its `tool_call_id` — a pair that
 *  has to be pushed together, since a history holding the ask without the answer is rejected by
 *  the next request. */
type Message =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; tool_calls: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string }

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** A tool call as it arrives: in pieces, across frames, with `index` saying which call each piece
 *  belongs to. The name comes whole on the first frame; the arguments arrive as JSON text a few
 *  characters at a time. */
interface ToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/**
 * One SSE frame's payload. Four names for the same thing, because the servers disagree: OpenRouter
 * puts a thinking model's thought in `reasoning`, llama.cpp and LM Studio in `reasoning_content`,
 * Ollama in `thinking`. A server that instead writes `<think>` tags into `content` needs nothing
 * here — `markdown.ts` already folds that syntax. Reading only one of the four would silently drop
 * the thought on two of the three.
 */
/** What a mid-stream error chunk carries — rule 4 above. Both fields are the server's to fill. */
export interface StreamError {
  code?: unknown
  message?: string
}

interface Delta {
  choices?: {
    delta?: {
      content?: string
      reasoning?: string
      reasoning_content?: string
      thinking?: string
      tool_calls?: ToolCallDelta[]
    }
    finish_reason?: string | null
  }[]
  /** Present on the chunk that reports a failure after the response was committed; the choice
   *  beside it closes with `finish_reason: 'error'` and an empty delta. */
  error?: StreamError
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
  /** A message for an error the server reported inside the stream — rule 4 above. Given whatever
   *  the chunk carried, which may be nothing but the finish reason. */
  streamError(error: StreamError | undefined): string
}

/** Everything of a `ModelChoice` this client reads. A subset of `LoadOptions`, since neither
 *  provider downloads anything: no progress, no quantisation, no device split. */
type Options = Pick<LoadOptions, 'model' | 'thinking' | 'sampling' | 'thinkingSampling'>

export function openAiEngine(config: OpenAiConfig, options: Options): ModelEngine {
  const { model, thinking: reasons, sampling, thinkingSampling } = options

  return {
    // Completions are stateless on this API: a conversation is nothing but its own turns.
    async chat(system, code, tools) {
      const messages: Message[] = [
        { role: 'system', content: system },
        ...(code
          ? ([
              { role: 'user', content: code },
              { role: 'assistant', content: CODE_ACK },
            ] as Message[])
          : []),
      ]

      /** Whether this conversation has ever actually opened a file. Per session, not per
       *  question: the row below is about a model that never looked, and a later answer resting on
       *  a file already read is ordinary. */
      let everRead = false

      return {
        promptStreaming(input, askOptions) {
          messages.push({ role: 'user', content: input })
          let answer = ''
          // Per question, the same as WebLLM: a card that names a thinking row names another for
          // answering plainly.
          const row =
            (askOptions?.thinking === true ? thinkingSampling : undefined) ?? sampling ?? {}

          // The read loop fills a queue of its own, and the stream takes from it one chunk at a
          // time in `pull` — rather than the loop enqueueing straight into the stream. The reason
          // is what `controller.error()` does to a stream that still holds chunks: it drops them.
          // The chunk that reports a failure (rule 4) shares a network read with the last of the
          // answer more often than not, and enqueued together the tail would be thrown away by the
          // error right behind it. Handed over on demand, an error or a close only ever lands on
          // an empty stream, so everything the model said before it reaches the pane.
          const queue: string[] = []
          let outcome: { kind: 'done' } | { kind: 'error'; error: unknown } | null = null
          let wake: (() => void) | null = null
          const notify = () => {
            const waiting = wake
            wake = null
            waiting?.()
          }
          const emit = (text: string) => {
            if (!text) return
            answer += text
            queue.push(text)
            notify()
          }
          const end = (error?: unknown) => {
            outcome = error === undefined ? { kind: 'done' } : { kind: 'error', error }
            notify()
          }

          // One fold for the whole question rather than one per request: a tool loop is several
          // requests answering a single question, and a `<think>` opened while the model was
          // deciding what to read has to be closed by whichever round finally speaks.
          const fold = foldReasoning()
          /** What the model has said *as content* in the round under way — the answer itself, with
           *  neither its reasoning nor the tool trace in it. This is what the history gets for that
           *  round, and it is reset at each boundary so nothing is filed twice. */
          let spoken = ''
          let truncated = false

          /**
           * One request, streamed. Returns the tool calls it asked for, in the order it asked —
           * empty when it simply answered, which is what ends the loop.
           *
           * `offer` is whether this round may ask for another: false on the last one, where the
           * tools are still declared (the history holds calls, and this API rejects those with
           * nothing to declare them) but `tool_choice: 'none'` takes the option away.
           */
          const round = async (offer: boolean, signal: AbortSignal): Promise<ToolCall[]> => {
            // Per request, not per question: a token cannot be split across two HTTP responses,
            // and holding one back over a round boundary would delay it behind a tool call.
            const strip = dropTokens(protocolTokensFor(model))
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
                ...(tools ? { tools: tools.schemas } : {}),
                ...(tools && !offer ? { tool_choice: 'none' } : {}),
                ...config.reasoningFields(reasons === true, askOptions?.thinking === true),
              }),
              signal,
            })

            if (!response.ok || !response.body) {
              throw new Error(await config.errorMessage(response))
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            // A call arrives in pieces across frames, `index` saying which is which — so it is
            // assembled by index and read back in that order, not in the order the pieces landed.
            const building = new Map<number, ToolCall>()

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
                // Rule 4. Thrown from inside the loop, since the status was 200 and nothing
                // after the loop would notice: the catch below keeps what streamed first.
                if (parsed.error || choice?.finish_reason === 'error') {
                  throw new Error(config.streamError(parsed.error))
                }
                if (choice?.finish_reason === 'length') truncated = true
                const delta = choice?.delta
                for (const piece of delta?.tool_calls ?? []) {
                  const key = piece.index ?? 0
                  let call = building.get(key)
                  if (!call) {
                    call = {
                      id: piece.id ?? `call_${key}`,
                      type: 'function',
                      function: { name: '', arguments: '' },
                    }
                    building.set(key, call)
                  }
                  if (piece.id) call.id = piece.id
                  if (piece.function?.name) call.function.name += piece.function.name
                  if (piece.function?.arguments) call.function.arguments += piece.function.arguments
                }
                // A server that leaves the model's own protocol tokens in the content puts them
                // in front of the reader mid-sentence. Filtered once, so the history the next
                // question is asked against does not keep them either.
                const content = delta?.content ? strip.chunk(delta.content) : delta?.content
                if (content) spoken += content
                emit(
                  fold.delta(
                    delta?.reasoning ?? delta?.reasoning_content ?? delta?.thinking,
                    content,
                  ),
                )
              }
            }

            // Whatever was held back in case it became a token and did not: ordinary text, and it
            // goes through the fold like any other so it lands inside an open thought rather than
            // after it.
            const rest = strip.end()
            if (rest) {
              spoken += rest
              emit(fold.delta(undefined, rest))
            }

            return [...building.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, call]) => call)
              .filter((call) => call.function.name)
          }

          const produce = async () => {
            const controllerAbort = new AbortController()
            const onAbort = () => controllerAbort.abort()
            askOptions?.signal?.addEventListener('abort', onAbort, { once: true })

            try {
              for (let asked = 0; ; asked += 1) {
                const offer = tools !== undefined && asked < MAX_TOOL_ROUNDS
                if (tools && !offer) {
                  // Closed first: a row is a sibling of a thought, never inside one.
                  emit(fold.end())
                  emit(
                    `\n\n<tool>read enough — answering from what has been read (${MAX_TOOL_ROUNDS} calls)</tool>\n\n`,
                  )
                }
                const calls = await round(offer, controllerAbort.signal)
                // A round that stopped at the token ceiling may have stopped in the middle of the
                // arguments it was writing, so the calls it asked for are not ones to run: the
                // answer ends here, with its note saying why.
                if (truncated || !tools || calls.length === 0) break
                // The ask and its answers go in together. Nothing awaits between them — the
                // toolbox is synchronous on purpose — because a history holding an ask with no
                // answer is one the next request refuses, and an abort landing in that gap would
                // leave the conversation unusable rather than merely stopped.
                messages.push({
                  role: 'assistant',
                  content: withoutThoughts(spoken),
                  tool_calls: calls,
                })
                spoken = ''
                // A thought the model was in the middle of is closed before the rows: a row is a
                // sibling of a thought, and one nested inside the other renders as neither.
                emit(fold.end())
                everRead = true
                for (const call of calls) {
                  const { name, arguments: args } = call.function
                  // One visible row per call. What a model was allowed to read is the first thing
                  // a reader checks about an answer built by reading — and it is still stripped
                  // from the history and from an agent's relay, since it is what the model did
                  // rather than what it said.
                  emit(`\n\n<tool>${tools.describe(name, args)}</tool>\n\n`)
                  messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: tools.call(name, args),
                  })
                }
              }
              emit(fold.end())
              // A conversation with a toolbox that has never opened a file has answered from the
              // index alone — and says so, because nothing else about the answer would. A model
              // that narrates "I will read the files" and then ends its turn otherwise produces a
              // well-formed answer with no sign that it never looked.
              if (tools && !everRead) emit(`\n\n<tool>${NO_READS_NOTE}</tool>\n\n`)

              messages.push({ role: 'assistant', content: withoutThoughts(spoken) })
              if (askOptions?.signal?.aborted) {
                end(new DOMException('Aborted', 'AbortError'))
              } else {
                // Said before the close, so the reader of the stream learns it before the
                // stream tells them there is nothing more.
                if (truncated) askOptions?.onTruncated?.()
                end()
              }
            } catch (caught) {
              messages.push({ role: 'assistant', content: withoutThoughts(spoken) })
              if (askOptions?.signal?.aborted) {
                end(new DOMException('Aborted', 'AbortError'))
              } else {
                // `fetch` rejects with a `TypeError` when it never reached a server at all, and
                // the bare "Failed to fetch" that carries says nothing a reader can act on. A
                // non-ok response threw above with a message of its own, so it is left alone.
                end(caught instanceof TypeError ? new Error(config.networkMessage()) : caught)
              }
            } finally {
              askOptions?.signal?.removeEventListener('abort', onAbort)
            }
          }

          return new ReadableStream<string>({
            start() {
              void produce()
            },
            // Called only when the stream has room, which with the default high-water mark
            // means the chunk before was taken — so the queue below is the only place anything
            // waits, and the end is reported once it is empty.
            async pull(controller) {
              for (;;) {
                const next = queue.shift()
                if (next !== undefined) {
                  controller.enqueue(next)
                  return
                }
                const finished = outcome
                if (finished) {
                  if (finished.kind === 'done') controller.close()
                  else controller.error(finished.error)
                  return
                }
                await new Promise<void>((resolve) => {
                  wake = resolve
                })
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
