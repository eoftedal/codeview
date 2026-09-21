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
        case 'error': {
          const error = new Error(message.message)
          // A failure during load and a failure mid-answer land in different places.
          ready?.reject(error)
          pending?.reject(error)
          ready = null
          pending = null
          break
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      ready = { onToken: () => {}, resolve: () => resolve(), reject }
      worker.onerror = (event) => reject(new Error(event.message || 'The model worker failed.'))
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
        worker.terminate()
      },
    }
  },
}
