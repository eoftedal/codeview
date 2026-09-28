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
  type ToolBox,
} from '../chat'
import { MAX_TOOL_ROUNDS, NO_READS_NOTE } from '../tools'
import { dialectFor, type ParsedCall } from './onnxTools'
import { withoutThoughts } from './thoughts'
import type { FromWorker, ToWorker, WorkerMessage } from './transformersWorker'
import { hasGpuAdapter } from './webgpu'

type Message = WorkerMessage

/* `AskOptions.thinking` rides each question over to the worker, which spends it on the chat
 * template — there is no session-level switch here, and none is wanted: the flag belongs to the
 * question. A model without a thinking mode never sees it, since the pane only offers the choice
 * where `ModelChoice.thinking` says there is one. */

/** One request in flight at a time, which is all the pane ever asks for. */
interface Pending {
  onToken: (text: string) => void
  /** `truncated`: the worker's ceiling ended the answer, not the model. `calls`: what it asked to
   *  read, if anything — the loop below runs them and asks again. */
  resolve: (truncated: boolean, calls: ParsedCall[]) => void
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
          ready?.resolve(false, [])
          ready = null
          break
        case 'token':
          pending?.onToken(message.text)
          break
        case 'done':
          pending?.resolve(message.truncated, message.calls)
          pending = null
          break
        case 'error':
          // Reported by the worker, so it caught it and is still there: a failure during load and
          // one mid-answer land in different places, and `fail` knows which is waiting.
          fail(new Error(message.message))
          break
      }
    }

    /** How this model writes a call, or null for one whose template has no tools in it. Settled
     *  once, at load: the catalogue only flags an entry that has one, and a toolbox handed to a
     *  model without is simply not declared. */
    const dialect = dialectFor(model)

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
      async chat(system, code, tools) {
        // Its own turn, ahead of the question. Not a `tool` message: `apply_chat_template` runs the
        // model's own Jinja template, and a tool turn there answers a call that was never made —
        // while the acknowledgement below is what keeps that same template happy, since it raises
        // on two user turns in a row.
        const messages: Message[] = [
          { role: 'system', content: system },
          ...(code
            ? ([
                { role: 'user', content: code },
                { role: 'assistant', content: CODE_ACK },
              ] as Message[])
            : []),
        ]
        // A toolbox is only worth declaring to a model whose template can render it and whose
        // syntax we can read back — otherwise the call arrives as prose in the middle of an answer.
        const box: ToolBox | undefined = dialect ? tools : undefined
        /** Whether this conversation has ever opened a file — see `NO_READS_NOTE`. Per session,
         *  since a later answer resting on a file already read is ordinary. */
        let everRead = false
        return {
          promptStreaming(input, options) {
            messages.push({ role: 'user', content: input })
            /** What the model has said in the round under way. The history takes one assistant turn
             *  per round — the turn that asked for the files, then the turn that answered — so it
             *  is reset at every boundary; the pane's copy of the whole answer is the pane's own. */
            let said = ''

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
                  messages.push({ role: 'assistant', content: withoutThoughts(said) })
                }

                /** One question to the worker, resolved when it has finished generating. */
                const askWorker = (offer: boolean) =>
                  new Promise<{ truncated: boolean; calls: ParsedCall[] }>((resolve, reject) => {
                    pending = {
                      onToken: (text) => {
                        said += text
                        controller.enqueue(text)
                      },
                      resolve: (truncated, calls) => resolve({ truncated, calls }),
                      reject,
                    }
                    // The whole conversation goes over each turn: re-prefilling is slower than
                    // carrying a KV cache across turns, but it is obviously correct, and these are
                    // short chats.
                    send({
                      type: 'ask',
                      messages,
                      thinking: options?.thinking === true,
                      ...(offer && box ? { tools: box.schemas, dialect: dialect! } : {}),
                    })
                  })

                void (async () => {
                  try {
                    for (let asked = 0; ; asked += 1) {
                      const { truncated, calls } = await askWorker(asked < MAX_TOOL_ROUNDS)
                      if (options?.signal?.aborted) {
                        finish()
                        controller.error(new DOMException('Aborted', 'AbortError'))
                        return
                      }
                      // A run that stopped at the ceiling may have stopped in the middle of the
                      // call it was writing, so what it asked for is not something to run: the
                      // answer ends here, with the note that says why.
                      if (truncated || !box || calls.length === 0) {
                        finish()
                        // A conversation with a toolbox that never opened a file answered from the
                        // index alone, and nothing else about the answer would say so — a model
                        // that narrates "I will read the files" and then ends its turn otherwise
                        // leaves a well-formed answer with no sign that it never looked.
                        if (box && !everRead) {
                          controller.enqueue(`\n\n<tool>${NO_READS_NOTE}</tool>\n\n`)
                        }
                        // Said before the close, so the reader of the stream learns it before the
                        // stream tells them there is nothing more.
                        if (truncated) options?.onTruncated?.()
                        controller.close()
                        return
                      }

                      // The ask and its answers go into the history together, in the shape both
                      // templates render: an assistant turn carrying the calls, then one `tool`
                      // turn per call naming which it answers.
                      messages.push({
                        role: 'assistant',
                        content: withoutThoughts(said),
                        tool_calls: calls.map((call) => ({
                          id: call.id,
                          type: 'function' as const,
                          // An object, not a string: Qwen's template runs `tojson` over this and
                          // Gemma's walks its keys, so a string would be rendered as one.
                          function: { name: call.name, arguments: call.args },
                        })),
                      })
                      said = ''
                      everRead = true

                      const trace: string[] = []
                      for (const call of calls) {
                        const args = JSON.stringify(call.args)
                        trace.push(box.describe(call.name, args))
                        messages.push({
                          role: 'tool',
                          tool_call_id: call.id,
                          name: call.name,
                          content: box.call(call.name, args),
                        })
                      }
                      // One visible row per call, in place of the raw call syntax the worker hid.
                      // Shown rather than folded — what the model read is the first thing a reader
                      // checks — and still stripped from the history and from an agent's relay by
                      // `withoutThoughts`, since it is what the model did rather than what it said.
                      controller.enqueue(
                        `\n\n${trace.map((line) => `<tool>${line}</tool>`).join('\n\n')}\n\n`,
                      )
                    }
                  } catch (caught) {
                    finish()
                    controller.error(caught instanceof Error ? caught : new Error(String(caught)))
                  }
                })()
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
