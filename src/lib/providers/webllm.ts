/**
 * WebLLM: MLC-compiled weights executed through WebGPU, from a catalogue of models this app names
 * in `chat.ts`. The library and its worker are imported lazily, so a reader who never picks a
 * downloadable model never pays for either.
 */

import {
  CODE_ACK,
  type Availability,
  type LoadOptions,
  type ModelEngine,
  type Provider,
} from '../chat'
import { MAX_NEW_TOKENS } from './ceiling'
import { withoutThoughts } from './thoughts'
import { hasGpuAdapter } from './webgpu'

/** Where the catalogue names no window: the MLC list compiles every model here to 4096 tokens,
 *  which is less than the browser's own model and too tight for a file plus a conversation. What
 *  a model actually runs at is `ModelChoice.contextTokens`; this is only the floor beneath it. */
const DEFAULT_CONTEXT_WINDOW = 8192

type Message = { role: 'system' | 'user' | 'assistant'; content: string }

export const webllm: Provider = {
  async availability(): Promise<Availability> {
    // Whether the weights are already cached is not worth probing for: `downloadable` is the
    // honest answer either way, and a cached model simply never reports progress. Whether the
    // GPU can be had at all is worth probing, and is the question this actually answers.
    return (await hasGpuAdapter()) ? 'downloadable' : 'unavailable'
  },

  async load({
    model,
    onProgress,
    thinking: reasons,
    sampling,
    thinkingSampling,
    contextTokens = DEFAULT_CONTEXT_WINDOW,
  }: LoadOptions): Promise<ModelEngine> {
    if (!model) throw new Error('WebLLM needs a model id.')

    const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import('@mlc-ai/web-llm')
    const worker = new Worker(new URL('./webllmWorker.ts', import.meta.url), { type: 'module' })

    const engine = await CreateWebWorkerMLCEngine(worker, model, {
      initProgressCallback: (report) => onProgress?.(report.progress),
      appConfig: {
        ...prebuiltAppConfig,
        model_list: prebuiltAppConfig.model_list.map((record) =>
          record.model_id === model
            ? { ...record, overrides: { ...record.overrides, context_window_size: contextTokens } }
            : record,
        ),
      },
    })

    return {
      // Completions are stateless, so a conversation is nothing but its own list of turns: a new
      // chat costs an array, not a reload.
      async chat(system, code) {
        // The code opens the history as a user turn, answered at once, rather than being folded
        // into the system message. `tool` is a role this schema has but cannot use here: it
        // requires a `tool_call_id`, and MLC drops an assistant turn's `tool_calls` when it
        // renders the prompt, so the call it was meant to answer would never exist.
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
            // A publisher that names a row for thinking names a different one for answering
            // plainly, and which applies is settled per question, not per load. Falls back to the
            // one row where there is only one.
            const row =
              (options?.thinking === true ? thinkingSampling : undefined) ?? sampling ?? {}

            return new ReadableStream<string>({
              async start(controller) {
                const onAbort = () => void engine.interruptGenerate()
                options?.signal?.addEventListener('abort', onAbort, { once: true })
                try {
                  const chunks = await engine.chat.completions.create({
                    messages,
                    stream: true,
                    max_tokens: MAX_NEW_TOKENS,
                    // Left out rather than sent as null, so the weights' own config still decides
                    // whatever the catalogue does not.
                    ...(row.temperature !== undefined ? { temperature: row.temperature } : {}),
                    ...(row.topP !== undefined ? { top_p: row.topP } : {}),
                    ...(row.presencePenalty !== undefined
                      ? { presence_penalty: row.presencePenalty }
                      : {}),
                    ...(row.repetitionPenalty !== undefined
                      ? { repetition_penalty: row.repetitionPenalty }
                      : {}),
                    // Only a model with a thinking mode is asked about it either way: WebLLM turns
                    // thinking off by prefilling an empty block, which would corrupt one without.
                    ...(reasons
                      ? { extra_body: { enable_thinking: options?.thinking === true } }
                      : {}),
                  })
                  // `length` is WebLLM's word for both ends it can run into — the ceiling above,
                  // and a context window with no room left, which is where a long thought over a
                  // large listing goes. Either way the model did not finish, and the reader should
                  // hear it. It rides the closing chunk, whose delta is empty, so it is read first.
                  let truncated = false
                  for await (const chunk of chunks) {
                    const choice = chunk.choices[0]
                    if (choice?.finish_reason === 'length') truncated = true
                    const delta = choice?.delta?.content
                    if (!delta) continue
                    answer += delta
                    controller.enqueue(delta)
                  }
                  // Whatever was said stays in the history, interrupted or not, so a follow-up
                  // about "that" still has something to point at — the answer, not the thinking
                  // before it, which Qwen's own template drops from a past turn too, and which
                  // would otherwise spend the next question's window on old working-out.
                  messages.push({ role: 'assistant', content: withoutThoughts(answer) })
                  if (options?.signal?.aborted) {
                    controller.error(new DOMException('Aborted', 'AbortError'))
                  } else {
                    if (truncated) options?.onTruncated?.()
                    controller.close()
                  }
                } catch (caught) {
                  messages.push({ role: 'assistant', content: withoutThoughts(answer) })
                  controller.error(caught)
                } finally {
                  options?.signal?.removeEventListener('abort', onAbort)
                }
              },
            })
          },

          // Nothing to tear down: the turns go out of scope with this session, and the model the
          // engine holds is exactly what we want to keep.
          destroy() {},
        }
      },

      destroy() {
        void engine.unload()
        worker.terminate()
      },
    }
  },
}
