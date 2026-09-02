/**
 * The Transformers.js side of the pane, kept off the main thread for the same reason WebLLM is:
 * Monaco and the TypeScript compiler already live there.
 *
 * The protocol is small on purpose — `load`, `ask`, `stop` in; `progress`, `ready`, `token`,
 * `done`, `error` out.
 */

import {
  InterruptableStoppingCriteria,
  TextStreamer,
  pipeline,
  type DataType,
  type TextGenerationPipeline,
} from '@huggingface/transformers'

export type ToWorker =
  | { type: 'load'; model: string; dtype?: DataType }
  | { type: 'ask'; messages: { role: string; content: string }[] }
  | { type: 'stop' }

export type FromWorker =
  | { type: 'progress'; loaded: number }
  | { type: 'ready' }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

const MAX_NEW_TOKENS = 640

let generator: TextGenerationPipeline | null = null
let stopper: InterruptableStoppingCriteria | null = null

function post(message: FromWorker): void {
  self.postMessage(message)
}

async function load(model: string, dtype: DataType): Promise<void> {
  generator = await pipeline('text-generation', model, {
    device: 'webgpu',
    // q4f16 is the usual WebGPU build, but it is the model's call, not ours: a repo whose
    // `transformers_js_config` asks for q4 means its fp16 path was never sound.
    dtype,
    progress_callback: (info) => {
      // v4 aggregates across files for us, so there is no per-file bookkeeping to do here.
      if (info.status === 'progress_total') post({ type: 'progress', loaded: info.progress / 100 })
    },
  })
  post({ type: 'ready' })
}

async function ask(messages: { role: string; content: string }[]): Promise<void> {
  if (!generator) throw new Error('The model is not loaded.')

  stopper = new InterruptableStoppingCriteria()
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => post({ type: 'token', text }),
  })

  await generator(messages as Parameters<TextGenerationPipeline>[0], {
    max_new_tokens: MAX_NEW_TOKENS,
    // A security answer should be the same twice running, so no sampling.
    do_sample: false,
    streamer,
    stopping_criteria: stopper,
  })
  post({ type: 'done' })
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data
  try {
    if (message.type === 'load') await load(message.model, message.dtype ?? 'q4f16')
    else if (message.type === 'ask') await ask(message.messages)
    else if (message.type === 'stop') stopper?.interrupt()
  } catch (caught) {
    post({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) })
  }
}
