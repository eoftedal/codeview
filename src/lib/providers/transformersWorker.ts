/**
 * The Transformers.js side of the pane, kept off the main thread for the same reason WebLLM is:
 * Monaco and the TypeScript compiler already live there.
 *
 * The protocol is small on purpose — `load`, `ask`, `stop` in; `progress`, `ready`, `token`,
 * `done`, `error` out.
 */

import {
  InterruptableStoppingCriteria,
  StoppingCriteria,
  TextStreamer,
  pipeline,
  type DataType,
  type TextGenerationPipeline,
} from '@huggingface/transformers'
import type { ToolSchema } from '../chat'
import { MAX_NEW_TOKENS } from './ceiling'
import { sessionDevices } from './devices'
import { keepsSpecialTokens, toolFilter, type ParsedCall, type ToolDialect } from './onnxTools'
import { foldChannels } from './thoughts'

export type ToWorker =
  | {
      type: 'load'
      model: string
      dtype?: DataType
      repetitionPenalty?: number
      /** Put `embed_tokens` on the CPU, leaving the GPU to the decoder alone. */
      cpuEmbeddings?: boolean
    }
  | {
      type: 'ask'
      /** The whole conversation, in the shape `apply_chat_template` renders: a turn that asked for
       *  tools carries `tool_calls`, and each answer to one is a `tool` turn naming the call it
       *  answers. Both shipped templates render exactly this. */
      messages: WorkerMessage[]
      thinking?: boolean
      /** Declared to the template for this question. Absent means none — which is also how the
       *  last round of a tool loop asks for an answer rather than another call. */
      tools?: readonly ToolSchema[]
      /** How this model writes a call, for reading one back out of the text. */
      dialect?: ToolDialect
    }
  | { type: 'stop' }

/** A turn as the chat templates take one. `content` is always present — an assistant turn that only
 *  called a tool carries the empty string — because a template that reads `message.content` on one
 *  without it renders `undefined` into the prompt. */
export interface WorkerMessage {
  role: string
  content: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: unknown } }[]
  tool_call_id?: string
  name?: string
}

export type FromWorker =
  | { type: 'progress'; loaded: number }
  | { type: 'ready' }
  | { type: 'token'; text: string }
  /** `truncated`: the answer ended at `MAX_NEW_TOKENS`, not at the model's own end of turn.
   *  `calls`: what the model asked to read, already parsed out of the text it wrote — the
   *  provider runs them, since the files are on its side of the worker boundary. */
  | { type: 'done'; truncated: boolean; calls: ParsedCall[] }
  | { type: 'error'; message: string }

/** Counts what the model generated. It stops nothing: a stopping criterion is simply the one hook
 *  `generate` offers per token, and the count is how the worker knows, afterwards, whether a run
 *  ended at the ceiling or at the model's own end of turn. */
class TokenCounter extends StoppingCriteria {
  generated = 0

  override _call(input_ids: number[][]): boolean[] {
    this.generated += 1
    return input_ids.map(() => false)
  }
}

let generator: TextGenerationPipeline | null = null
let stopper: InterruptableStoppingCriteria | null = null
/** The catalogue's, when it has one; otherwise the model's own `generation_config` decides. */
let repetitionPenalty: number | undefined

function post(message: FromWorker): void {
  self.postMessage(message)
}

async function load(
  model: string,
  dtype: DataType,
  penalty?: number,
  cpuEmbeddings = false,
): Promise<void> {
  repetitionPenalty = penalty
  generator = await pipeline('text-generation', model, {
    device: sessionDevices(cpuEmbeddings),
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

async function ask(
  messages: WorkerMessage[],
  thinking: boolean,
  tools?: readonly ToolSchema[],
  dialect?: ToolDialect,
): Promise<void> {
  if (!generator) throw new Error('The model is not loaded.')

  stopper = new InterruptableStoppingCriteria()
  // Two reasons to stop skipping special tokens, and they are the same reason twice. Thinking is
  // delimited by channel markers, which are special: skipped, the reasoning arrives glued to the
  // front of the answer with nothing to separate the two. Gemma's tool-call markers are special
  // too, so a call would arrive as its bare arguments with nothing saying it was one. Either way
  // the protocol tokens come through as well, which is what `foldChannels` is for.
  const reading = tools && dialect ? toolFilter(dialect) : null
  const specials = thinking || (reading !== null && keepsSpecialTokens(dialect!))
  const fold = specials ? foldChannels() : null
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: !specials,
    callback_function: (chunk: string) => {
      const folded = fold ? fold(chunk) : chunk
      const text = reading ? reading.chunk(folded) : folded
      if (text) post({ type: 'token', text })
    },
  })

  const counter = new TokenCounter()
  await generator(messages as Parameters<TextGenerationPipeline>[0], {
    max_new_tokens: MAX_NEW_TOKENS,
    // A security answer should be the same twice running, so no sampling.
    do_sample: false,
    ...(repetitionPenalty !== undefined ? { repetition_penalty: repetitionPenalty } : {}),
    streamer,
    stopping_criteria: [stopper, counter],
    // The pipeline hands these to `apply_chat_template`, which is where a model's thinking mode is
    // turned on — a template without the variable simply ignores it.
    ...(thinking ? { tokenizer_encode_kwargs: { enable_thinking: true } } : {}),
    // And the same road for the tools: the template renders each model's own declaration block
    // from them, which is the only place a tool is ever described to one of these.
    ...(tools ? { tools: tools as unknown as object[] } : {}),
  })
  if (reading) {
    const rest = reading.end()
    if (rest) post({ type: 'token', text: rest })
  }
  // Generation ends three ways — the model's end of turn, the reader's stop, or the ceiling — and
  // only the last is a cut-off. The reader's stop is an abort on the other side of the worker
  // boundary, whatever the count says.
  post({
    type: 'done',
    truncated: !stopper.interrupted && counter.generated >= MAX_NEW_TOKENS,
    calls: reading ? reading.calls() : [],
  })
}

/**
 * A rejection nobody awaited. The handler below catches what `load` and `ask` throw, but ORT does
 * async work of its own — a device that dies mid-run surfaces there rather than on the call we are
 * awaiting, and that call may then never settle at all. Reported rather than left to the console,
 * where the pane cannot see it: an unreported one leaves a stream open on an answer that has
 * already stopped arriving.
 */
self.onunhandledrejection = (event: PromiseRejectionEvent) => {
  event.preventDefault()
  const reason: unknown = event.reason
  post({ type: 'error', message: reason instanceof Error ? reason.message : String(reason) })
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data
  try {
    if (message.type === 'load') {
      await load(
        message.model,
        message.dtype ?? 'q4f16',
        message.repetitionPenalty,
        message.cpuEmbeddings,
      )
    } else if (message.type === 'ask') {
      await ask(message.messages, message.thinking === true, message.tools, message.dialect)
    } else if (message.type === 'stop') stopper?.interrupt()
  } catch (caught) {
    post({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) })
  }
}
