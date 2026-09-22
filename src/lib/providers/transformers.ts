/**
 * Transformers.js: ONNX weights from the Hugging Face hub, executed through WebGPU. Reaches models
 * WebLLM has no compiled build for, at the cost of driving a lower-level pipeline — the worker next
 * door does that part, and this file is only the conversation and the stream.
 */

import {
  CODE_ACK,
  type Availability,
  type LoadOptions,
  type ModelEngine,
  type Provider,
} from '../chat'
import { withoutThoughts } from './thoughts'
import type { FromWorker, ToWorker } from './transformersWorker'
import { hasGpuAdapter } from './webgpu'

type Message = { role: 'system' | 'user' | 'assistant'; content: string }

/* `AskOptions.thinking` rides each question over to the worker, which spends it on the chat
 * template — there is no session-level switch here, and none is wanted: the flag belongs to the
 * question. A model without a thinking mode never sees it, since the pane only offers the choice
 * where `ModelChoice.thinking` says there is one. */

/** One request in flight at a time, which is all the pane ever asks for. */
interface Pending {
  onToken: (text: string) => void
  /** `truncated`: the worker's ceiling ended the answer, not the model. */
  resolve: (truncated: boolean) => void
  reject: (error: Error) => void
}

export const transformers: Provider = {
  async availability(): Promise<Availability> {
    return (await hasGpuAdapter()) ? 'downloadable' : 'unavailable'
  },

  async load({
    model,
    onProgress,
    dtype,
    sampling,
    cpuEmbeddings,
  }: LoadOptions): Promise<ModelEngine> {
    if (!model) throw new Error('Transformers.js needs a model id.')

    const worker = new Worker(new URL('./transformersWorker.ts', import.meta.url), {
      type: 'module',
    })
    const send = (message: ToWorker) => worker.postMessage(message)

    let pending: Pending | null = null
    let ready: Pending | null = null
    /**
     * Set once the worker itself has died, so every later question fails at once instead of being
     * posted to something that is gone. A message to a terminated worker is not an error — it is
     * silence, and silence here is indistinguishable from a slow model.
     */
    let broken: Error | null = null

    /**
     * Whatever went wrong, to whoever is waiting for it. Exactly one of the two ever is: a load, or
     * a question. `fatal` says the worker is gone rather than merely unhappy — an exception it
     * caught and reported leaves it alive and able to answer the next question, while an error on
     * the worker itself does not.
     *
     * This exists because the obvious spelling was wrong in a way that cost nothing until it cost
     * everything: `worker.onerror` used to close over the *load* promise's `reject`, so once load
     * had settled every later failure was delivered to a settled promise and dropped. The pane went
     * on waiting for a stream that had already stopped.
     */
    function fail(error: Error, fatal = false): void {
      if (fatal) broken = error
      const waiting = ready ?? pending
      ready = null
      pending = null
      waiting?.reject(error)
    }

    // On the worker, not on a promise: a worker can fail at any point, including between questions.
    worker.onerror = (event) => fail(new Error(event.message || 'The model worker failed.'), true)

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data
      switch (message.type) {
        case 'progress':
          onProgress?.(message.loaded)
          break
        case 'ready':
          ready?.resolve(false)
          ready = null
          break
        case 'token':
          pending?.onToken(message.text)
          break
        case 'done':
          pending?.resolve(message.truncated)
          pending = null
          break
        case 'error':
          // Reported by the worker, so it caught it and is still there: a failure during load and
          // one mid-answer land in different places, and `fail` knows which is waiting.
          fail(new Error(message.message))
          break
      }
    }

    await new Promise<void>((resolve, reject) => {
      ready = { onToken: () => {}, resolve: () => resolve(), reject }
      // Only the repetition penalty crosses: the pipeline has no presence penalty to give it to.
      send({
        type: 'load',
        model,
        dtype,
        repetitionPenalty: sampling?.repetitionPenalty,
        cpuEmbeddings,
      })
    })

    return {
      // The worker holds the loaded pipeline; a conversation is only its list of turns, so a new
      // chat costs an array rather than a reload.
      async chat(system, code) {
        // Its own turn, ahead of the question. Not a `tool` message: `apply_chat_template` runs the
        // model's own Jinja template, and Gemma's has no tool role to render one into — while the
        // acknowledgement below is what keeps that same template happy, since it raises on two
        // user turns in a row.
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

            return new ReadableStream<string>({
              start(controller) {
                // The worker is already gone: say so now rather than post into the dark.
                if (broken) {
                  controller.error(broken)
                  return
                }

                const onAbort = () => send({ type: 'stop' })
                options?.signal?.addEventListener('abort', onAbort, { once: true })

                const finish = () => {
                  options?.signal?.removeEventListener('abort', onAbort)
                  // Interrupted or not, what was said stays in the history so a follow-up has
                  // context — the answer, that is, not the thinking that came before it, which is
                  // what the model's own template drops from a past turn too.
                  messages.push({ role: 'assistant', content: withoutThoughts(answer) })
                }

                pending = {
                  onToken: (text) => {
                    answer += text
                    controller.enqueue(text)
                  },
                  resolve: (truncated) => {
                    finish()
                    if (options?.signal?.aborted) {
                      controller.error(new DOMException('Aborted', 'AbortError'))
                    } else {
                      // Said before the close, so the reader of the stream learns it before the
                      // stream tells them there is nothing more.
                      if (truncated) options?.onTruncated?.()
                      controller.close()
                    }
                  },
                  reject: (error) => {
                    finish()
                    controller.error(error)
                  },
                }

                // The whole conversation goes over each turn: re-prefilling is slower than
                // carrying a KV cache across turns, but it is obviously correct, and these are
                // short chats.
                send({ type: 'ask', messages, thinking: options?.thinking === true })
              },
            })
          },

          // The turns go out of scope with this session; the loaded pipeline stays in the worker.
          destroy() {},
        }
      },

      destroy() {
        // A question still in flight would otherwise wait forever on a worker that no longer
        // exists — the reader changing model mid-answer is the ordinary way to get here.
        fail(new Error('The model was unloaded.'), true)
        worker.terminate()
      },
    }
  },
}
