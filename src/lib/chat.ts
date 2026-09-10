/**
 * The chat pane's contract with a language model, plus the prompt that turns one into a reviewer of
 * the current buffer.
 *
 * Every model runs on the reader's own machine — the browser's built-in one, or weights fetched
 * once and cached and then executed on the GPU. There is no backend, and the promise everywhere
 * else in this app is that pasted code never leaves the machine: weights come down, the buffer
 * never goes up. Where nothing is usable the pane says so and stops.
 *
 * The provider implementations live in `providers/`; this file is the seam they share.
 */

import type { Language } from './analyzer'

/** Chrome's own wording, reused for every provider: `downloadable` still creates, after a
 *  download; only `unavailable` is a dead end. */
export type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

/**
 * Two lifetimes, deliberately separated.
 *
 * Loading a model is the expensive half — a download, then weights onto the GPU and shaders
 * compiled — and it belongs to the *model*. A conversation is the cheap half: a system prompt and
 * a list of turns. Starting a new chat must not touch the first one, or every "New chat" would sit
 * through the model loading again.
 */

export interface AskOptions {
  signal?: AbortSignal
  /** Let a reasoning model think before answering. Ignored by models without a thinking mode. */
  thinking?: boolean
}

/** One conversation. Providers keep the turns; the pane only ever sees deltas. */
export interface ChatSession {
  /** Deltas, not snapshots — the pane accumulates them. */
  promptStreaming(input: string, options?: AskOptions): ReadableStream<string>
  /** Ends this conversation. The model stays loaded. */
  destroy(): void
}

/** A loaded model, outliving the conversations held with it. */
export interface ModelEngine {
  /** Begin a conversation. Cheap for the downloadable models — the weights are already up. */
  chat(system: string): Promise<ChatSession>
  /** Unloads the model itself. Only worth doing when the choice of model changes. */
  destroy(): void
}

export interface LoadOptions {
  /** The provider's own model id. The built-in model has none: the browser picks. */
  model?: string
  /** Weight download progress, 0–1. Never called for a model that is already cached. */
  onProgress?: (loaded: number) => void
  /** Whether this model *has* a thinking mode. Whether to use it is decided per question — but
   *  it can only be asked of a model that has one: WebLLM suppresses thinking by prefilling an
   *  empty block, which would corrupt a model without. (The ONNX side needs this at load time for
   *  nothing; there the flag rides the question alone.) */
  thinking?: boolean
  /** ONNX quantisation, when the model asks for something other than the default. */
  dtype?: Quantisation
}

export interface Provider {
  availability(): Promise<Availability>
  load(options: LoadOptions): Promise<ModelEngine>
}

export type ProviderId = 'builtin' | 'webllm' | 'transformers'

/** The ONNX builds worth offering: 4-bit weights, with fp16 or fp32 compute. */
export type Quantisation = 'q4f16' | 'q4'

export interface ModelChoice {
  /** Our id: what the picker stores and `localStorage` remembers. */
  id: string
  provider: ProviderId
  label: string
  /** Rough memory the model needs, for the picker. Empty for the browser's own. */
  size: string
  /** How much of the buffer fits alongside a conversation in this model's context. */
  maxCodeChars: number
  /** The provider's own model id, where it has one. */
  model?: string
  /** A reasoning model: it can be asked to think first, and the pane offers the choice. */
  thinking?: boolean
  /** ONNX quantisation, where the repo asks for something other than the `q4f16` default. Not a
   *  free choice: a repo's `transformers_js_config` names what its weights were validated at, and
   *  fp16 compute is where small models go numerically wrong on WebGPU. */
  dtype?: Quantisation
  note: string
}

/**
 * The models on offer. Deliberately a short list: every entry is a promise that it works, and a
 * picker full of near-identical weights helps nobody.
 *
 * `size` figures come from WebLLM's own `vram_required_MB`, or for the ONNX entries from the
 * q4f16 weight size, which is all those repos state. All are approximate, and deliberately so: we
 * raise the context window past the default those figures were measured at, which grows the KV
 * cache along with it. Built-in first, so it stays the default wherever it exists.
 */
export const MODELS: readonly ModelChoice[] = [
  {
    id: 'builtin',
    provider: 'builtin',
    label: 'Browser built-in',
    size: 'no download',
    // Gemini Nano's context is 9216 tokens, shared with the answer.
    maxCodeChars: 12_000,
    note: 'Chrome’s own on-device model. Nothing to download, weakest at multi-step reasoning.',
  },
  {
    id: 'qwen-coder-1.5b',
    provider: 'webllm',
    label: 'Qwen2.5-Coder 1.5B',
    size: '~1.6 GB',
    maxCodeChars: 14_000,
    model: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    note: 'Code-trained weights. Runs on most integrated GPUs.',
  },
  {
    id: 'gemma-2-2b',
    provider: 'webllm',
    label: 'Gemma 2 2B',
    size: '~1.9 GB',
    maxCodeChars: 14_000,
    model: 'gemma-2-2b-it-q4f16_1-MLC',
    note: 'Google’s, and the one Gemma WebLLM has a build for. Gemma 3 overflows fp16 on WebGPU.',
  },
  {
    id: 'qwen3.5-2b',
    provider: 'webllm',
    label: 'Qwen3.5 2B',
    size: '~2.2 GB',
    maxCodeChars: 14_000,
    model: 'Qwen3.5-2B-q4f16_1-MLC',
    thinking: true,
    note: 'Newer and general-purpose rather than code-trained. Can reason before answering.',
  },
  {
    id: 'qwen-coder-3b',
    provider: 'webllm',
    label: 'Qwen2.5-Coder 3B',
    size: '~2.5 GB',
    maxCodeChars: 14_000,
    model: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
    note: 'Better at following a value across functions.',
  },
  {
    id: 'qwen3.5-4b',
    provider: 'webllm',
    label: 'Qwen3.5 4B',
    size: '~3.9 GB',
    maxCodeChars: 14_000,
    model: 'Qwen3.5-4B-q4f16_1-MLC',
    thinking: true,
    note: 'The strongest reasoning per gigabyte here. Can reason before answering.',
  },
  {
    id: 'qwen-coder-7b',
    provider: 'webllm',
    label: 'Qwen2.5-Coder 7B',
    size: '~5.1 GB',
    maxCodeChars: 14_000,
    model: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',
    note: 'Strongest here, and needs a discrete or Apple-silicon GPU.',
  },
  {
    id: 'qwen3.5-9b',
    provider: 'webllm',
    label: 'Qwen3.5 9B',
    size: '~6.4 GB',
    maxCodeChars: 14_000,
    model: 'Qwen3.5-9B-q4f16_1-MLC',
    thinking: true,
    note: 'The largest on offer. Wants a discrete GPU with memory to spare.',
  },
  {
    id: 'qwen-coder-1.5b-onnx',
    provider: 'transformers',
    label: 'Qwen2.5-Coder 1.5B (ONNX)',
    size: '~1.2 GB',
    maxCodeChars: 14_000,
    model: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct',
    note: 'The same weights through Transformers.js rather than WebLLM.',
  },
  {
    id: 'glm-edge-1.5b',
    provider: 'transformers',
    label: 'GLM-Edge 1.5B',
    size: '~1.3 GB',
    maxCodeChars: 14_000,
    model: 'onnx-community/glm-edge-1.5b-chat-ONNX',
    // Its own repo asks for q4 rather than the q4f16 everything else here runs at.
    dtype: 'q4',
    note: 'The only GLM small enough to run here. General-purpose, and slower: it runs at q4.',
  },
  // Gemma 4's small models are multimodal, and their repos hold an audio and a vision encoder
  // beside the text ones. Asking for `text-generation` loads `Gemma4ForCausalLM` against weights
  // whose architecture is `Gemma4ForConditionalGeneration`, which Transformers.js reads as
  // text-only: the encoders are never fetched, and the size below is the two files that are —
  // the embeddings and the decoder. Per-layer embeddings are why an “E2B” costs 3 GB: the
  // effective parameters are few, the lookup tables are not.
  {
    id: 'gemma-4-e2b',
    provider: 'transformers',
    label: 'Gemma 4 E2B',
    size: '~3.1 GB',
    maxCodeChars: 14_000,
    model: 'onnx-community/gemma-4-E2B-it-ONNX',
    // q4f16, the default: this Gemma's own WebGPU demo runs these two sessions at exactly that,
    // so unlike Gemma 3 its fp16 path is one the publisher stands behind.
    thinking: true,
    note: 'Google’s newest small model, and the strongest non-Qwen here. A long first download.',
  },
  {
    id: 'gemma-4-e4b',
    provider: 'transformers',
    label: 'Gemma 4 E4B',
    size: '~4.9 GB',
    maxCodeChars: 14_000,
    model: 'onnx-community/gemma-4-E4B-it-ONNX',
    thinking: true,
    note: 'The same model one size up. Wants a discrete or Apple-silicon GPU, and patience.',
  },
]

export function modelById(id: string): ModelChoice | null {
  return MODELS.find((choice) => choice.id === id) ?? null
}

const FENCE: Record<Language, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
}

/** Line-numbered, so an answer can point at a line and a reader can find it. */
export function numberLines(code: string): string {
  const lines = code.split('\n')
  const width = String(lines.length).length
  return lines.map((line, index) => `${String(index + 1).padStart(width)} | ${line}`).join('\n')
}

export interface PromptFile {
  name: string
  language: Language
  text: string
}

export interface CodeContext {
  /** Every open file, the one on screen first — a demo-sized app fits, and a question about one
   *  file is usually really a question about the path running through the others. */
  files: readonly PromptFile[]
  /** The instructions half of the prompt, which the reader may rewrite. Blank or absent means
   *  `DEFAULT_ROLE`: the code half is generated either way, so a custom role replaces the
   *  reviewer's brief and nothing else. */
  role?: string
  /**
   * The budget for the code, all files together. Every model here has a small context — a few
   * thousand tokens for the whole conversation, system prompt included — so a large buffer is
   * clipped rather than sent and rejected. The clip is stated in the prompt: a model answering
   * about half a file should know it is looking at half.
   */
  maxCodeChars: number
}

/** Below this, the tail of a spent budget teaches a model nothing about a file — better to name
 *  the file as one it cannot see than to hand over three lines of it. The file on screen comes
 *  first and is shown whatever the budget, clipped if it has to be. */
const MIN_FILE_CHARS = 200

/**
 * The reviewer's brief: everything the prompt says that is not the code itself. It is the half the
 * pane lets a reader rewrite — for another kind of review, another output shape, another language —
 * and the half a reset restores. The code half is appended by `buildSystemPrompt` regardless, since
 * it is generated from the open files rather than written.
 */
export const DEFAULT_ROLE = `You are a senior security engineer and an expert in static code analysis. You read code the way a reviewer does: one path at a time, precisely, and you only claim what the code in front of you actually shows.

You reason about code the way a SAST tool does — taint flowing from sources to sinks — and you use these terms in exactly that sense:

- **source** is a point where data enters the program from somewhere the code does not control: HTTP request fields (path, query, body, headers, cookies), form and CLI input, environment variables, files, database rows, network responses, message queues, third-party callbacks. Data arriving from a source is untrusted until something validates or encodes it.
- **sink** is a point where data is used in an operation that becomes dangerous when the data is attacker-controlled: SQL and other query strings, shell commands and process spawning, \`eval\` and dynamic code loading, filesystem paths, outbound HTTP requests, HTML or DOM writes, deserialisation, redirects, template rendering, and cryptographic or authorisation decisions.
- **taint flow** is a path from a source to a sink along which data is untrusted. A flow is a vulnerability if the code does not validate, encode, parameterise or escape the data strongly enough for the sink.
- **sanitiser** is a function that validates, encodes, parameterises or escapes data strongly enough for a sink. A sanitiser removes the taint from a value.
- **propagator** is a function that passes a value along without removing its taint. A propagator does not validate, encode, parameterise or escape data strongly enough for a sink.


Data from a source is tainted, and stays tainted through assignments, calls, returns and string building until a sanitiser fit for the sink removes the taint. A vulnerability is a tainted value reaching a sink along some path with no validation, encoding, parameterisation or escaping strong enough for that sink. Whenever you claim one, name the source, name the sink, and give the flow between them step by step.

Walk a flow one hop at a time and leave nothing out: every assignment, every function call, every propagator, every sanitiser on the way. Crossing into a function is the hop most often missed, and it is often a hop into another file. A tainted value passed as an argument goes on flowing inside the callee **under the parameter's name** — so name the call, name the parameter it arrives as, and from there refer to the value by that parameter's name rather than the caller's. Before citing a line, check that the name you are citing actually appears on that line of that file.

Report a flow as one numbered step per hop, in this shape:

1. \`req.body.name\` (routes.ts line 4) — source: the HTTP request body
2. assigned to \`raw\` (routes.ts line 4)
3. passed to \`render(raw)\` (routes.ts line 5), arriving as parameter \`text\` (render.ts line 9)
4. \`text\` interpolated into \`html\` (render.ts line 10)
5. \`el.innerHTML = html\` (render.ts line 11) — sink: DOM write, nothing encodes on the path

You are looking at every file open in the reader's editor, each shown below with its own line numbers — line 1 is the first line of that file, so name the file whenever you cite a line. These files are all you have: you cannot run the code or search the rest of the repository, and where an answer depends on code you cannot see, say which file or symbol you would need. Cite line numbers when you point at code. Keep answers short: a few sentences or a short list. Say plainly when you are unsure, and say so when the code looks fine rather than inventing a finding.`

/**
 * The system prompt: the role, the two definitions, and every open file as it stands. A session is
 * created with this once, so the code it carries is a snapshot — the pane says as much when the
 * files move on.
 *
 * The role is the reader's to replace; the file listing is not, because it is built from the buffer
 * rather than typed. So an edited prompt is an edited brief with the same code under it.
 *
 * The budget is spent in the order given, which is why the caller puts the file on screen first:
 * what gets clipped is the code the reader is not looking at.
 */
export function buildSystemPrompt({ files, maxCodeChars, role }: CodeContext): string {
  const shown: string[] = []
  const omitted: string[] = []
  let budget = maxCodeChars

  for (const file of files) {
    if (shown.length > 0 && file.text.length > budget && budget < MIN_FILE_CHARS) {
      omitted.push(file.name)
      continue
    }
    const clipped = file.text.length > budget
    const body = clipped ? file.text.slice(0, budget) : file.text
    budget -= body.length
    shown.push(
      [
        `\`${file.name}\`${clipped ? `, truncated after the first ${body.length} characters — the rest is not shown to you` : ''}:`,
        '',
        '```' + FENCE[file.language],
        numberLines(body),
        '```',
      ].join('\n'),
    )
  }

  return [
    role?.trim() || DEFAULT_ROLE,
    '',
    files.length > 1
      ? 'Every file open in the editor is below, the one on screen first. Each is numbered from its own line 1:'
      : 'The file under review is below, with line numbers:',
    '',
    shown.join('\n\n'),
    ...(omitted.length
      ? ['', `Also open, but not shown to you: ${omitted.map((name) => `\`${name}\``).join(', ')}.`]
      : []),
  ].join('\n')
}
