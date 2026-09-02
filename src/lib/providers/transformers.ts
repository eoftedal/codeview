/**
 * Transformers.js: ONNX weights from the Hugging Face hub, executed through WebGPU. Reaches models
 * WebLLM has no compiled build for, at the cost of driving a lower-level pipeline — the worker next
 * door does that part, and this file is only the conversation and the stream.
 */

import type { Availability, LoadOptions, ModelEngine, Provider } from '../chat'
import type { FromWorker, ToWorker } from './transformersWorker'
import { hasGpuAdapter } from './webgpu'

type Message = { role: 'system' | 'user' | 'assistant'; content: string }

/* `AskOptions.thinking` is accepted and ignored here: driving a chat template's `enable_thinking`
 * through the text-generation pipeline has no route in Transformers.js, and nothing in the ONNX
 * half of the catalogue reasons anyway. */

/** One request in flight at a time, which is all the pane ever asks for. */
interface Pending {
  onToken: (text: string) => void
  resolve: () => void
  reject: (error: Error) => void
}

export const transformers: Provider = {
  async availability(): Promise<Availability> {
    return (await hasGpuAdapter()) ? 'downloadable' : 'unavailable'
  },

  async load({ model, onProgress, dtype }: LoadOptions): Promise<ModelEngine> {
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
          ready?.resolve()
          ready = null
          break
        case 'token':
          pending?.onToken(message.text)
          break
        case 'done':
          pending?.resolve()
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
      ready = { onToken: () => {}, resolve, reject }
      worker.onerror = (event) => reject(new Error(event.message || 'The model worker failed.'))
      send({ type: 'load', model, dtype })
    })

    return {
      // The worker holds the loaded pipeline; a conversation is only its list of turns, so a new
      // chat costs an array rather than a reload.
      async chat(system) {
        const messages: Message[] = [{ role: 'system', content: system }]
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
                  // Interrupted or not, what was said stays in the history so a follow-up has context.
                  messages.push({ role: 'assistant', content: answer })
                }

                pending = {
                  onToken: (text) => {
                    answer += text
                    controller.enqueue(text)
                  },
                  resolve: () => {
                    finish()
                    if (options?.signal?.aborted) {
                      controller.error(new DOMException('Aborted', 'AbortError'))
                    } else {
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
                send({ type: 'ask', messages })
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
