/**
 * The chat pane's access to a language model, plus the prompt that turns one into a reviewer of
 * the current buffer.
 *
 * The model is the browser's own — Chrome's on-device `LanguageModel` (the Prompt API) — which is
 * the only kind this app can use: there is no backend, and the promise everywhere else is that
 * pasted code never leaves the machine. Where the API is missing the pane says so and stops.
 */

import type { Language } from './analyzer'

/** Chrome's own wording for whether the model can answer: `downloadable` still creates, after a
 *  download; only `unavailable` is a dead end. */
export type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

export interface LanguageModelSession {
  promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>
  destroy(): void
}

export interface LanguageModelCreateOptions {
  initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[]
  signal?: AbortSignal
  monitor?: (monitor: EventTarget) => void
}

export interface LanguageModelApi {
  availability(): Promise<Availability>
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>
}

/** The global, or null in a browser that has no Prompt API. */
export function languageModel(): LanguageModelApi | null {
  return (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel ?? null
}

/**
 * An on-device model has a small input quota — a few thousand tokens for the whole conversation,
 * system prompt included — so a large buffer is clipped rather than sent and rejected. The clip is
 * stated in the prompt: a model answering about half a file should know it is looking at half.
 */
export const MAX_CODE_CHARS = 12_000

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

export interface CodeContext {
  code: string
  language: Language
  fileName: string | null
}

const ROLE = `You are a senior security engineer and an expert in static code analysis. You read code the way a reviewer does: one path at a time, precisely, and you only claim what the code in front of you actually shows.

You reason about code the way a SAST tool does — taint flowing from sources to sinks — and you use these two terms in exactly that sense:

- A SOURCE is a point where data enters the program from somewhere the code does not control: HTTP request fields (path, query, body, headers, cookies), form and CLI input, environment variables, files, database rows, network responses, message queues, third-party callbacks. Data arriving from a source is untrusted until something validates or encodes it.
- A SINK is a point where data is used in an operation that becomes dangerous when the data is attacker-controlled: SQL and other query strings, shell commands and process spawning, \`eval\` and dynamic code loading, filesystem paths, outbound HTTP requests, HTML or DOM writes, deserialisation, redirects, template rendering, and cryptographic or authorisation decisions.

Data from a source is tainted, and stays tainted through assignments, calls, returns and string building until a sanitiser fit for the sink removes the taint. A vulnerability is a tainted value reaching a sink along some path with no validation, encoding, parameterisation or escaping strong enough for that sink. Whenever you claim one, name the source, name the sink, and give the flow between them step by step.

Walk a flow one hop at a time and leave nothing out: every assignment, every function call, every propagator, every sanitiser on the way. Crossing into a function is the hop most often missed. A tainted value passed as an argument goes on flowing inside the callee **under the parameter's name** — so name the call, name the parameter it arrives as, and from there refer to the value by that parameter's name rather than the caller's. Before citing a line, check that the name you are citing actually appears on that line.

Report a flow as one numbered step per hop, in this shape:

1. \`req.body.name\` (line 4) — source: the HTTP request body
2. assigned to \`raw\` (line 4)
3. passed to \`render(raw)\` (line 5), arriving as parameter \`text\` (line 9)
4. \`text\` interpolated into \`html\` (line 10)
5. \`el.innerHTML = html\` (line 11) — sink: DOM write, nothing encodes on the path

You are looking at a single file, shown below with line numbers. You cannot open other files, run the code, or search the repository — where an answer depends on code you cannot see, say which file or symbol you would need. Cite line numbers when you point at code. Keep answers short: a few sentences or a short list. Say plainly when you are unsure, and say so when the code looks fine rather than inventing a finding.`

/**
 * The system prompt: the role, the two definitions, and the buffer as it stands. A session is
 * created with this once, so the code it carries is a snapshot — the pane says as much when the
 * buffer moves on.
 */
export function buildSystemPrompt({ code, language, fileName }: CodeContext): string {
  const clipped = code.length > MAX_CODE_CHARS
  const body = clipped ? code.slice(0, MAX_CODE_CHARS) : code
  const name = fileName ?? `main.${language}`

  return [
    ROLE,
    '',
    `The file under review is \`${name}\`${clipped ? ', truncated after the first ' + MAX_CODE_CHARS + ' characters — the rest is not shown to you' : ''}:`,
    '',
    '```' + FENCE[language],
    numberLines(body),
    '```',
  ].join('\n')
}
