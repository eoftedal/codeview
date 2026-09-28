/**
 * Tool calling for the ONNX (Transformers.js) models, which is a different thing from tool calling
 * on an OpenAI-compatible API and has to be, because there is no API here: there is a chat
 * template, and the model writes its call into the *text*.
 *
 * So two halves live here. `apply_chat_template` is given the tools and renders each model's own
 * declaration block — that part the pipeline does for us — and what comes back has to be read in
 * the syntax that same template taught the model to write, which differs per family. Hence a
 * **dialect**, and hence `dialectFor`: a model whose template has no tools in it (GLM-Edge) has no
 * dialect, is never offered any, and is never flagged in the catalogue.
 *
 * Both dialects are read off the publisher's own files rather than guessed:
 *
 * - **qwen** — Qwen2.5's template prints the instruction itself: *"return a json object with
 *   function name and arguments within `<tool_call></tool_call>` XML tags"*. The two markers are
 *   added tokens but not *special* ones, so they survive `skip_special_tokens` and arrive as text.
 * - **gemma** — Gemma 4's tokenizer config carries a `response_schema` saying exactly how to read
 *   one: `<\|tool_call>(.*?)<tool_call\|>`, then `call:(?P<name>\w+)(?P<arguments>\{.*\})`, then a
 *   parser it calls `gemma4-tool-call` for the arguments. That last one is not JSON: it is
 *   `key:value` pairs, with strings wrapped in the tokenizer's `escape_token`, `<|"|>` — which is
 *   what `parseGemmaArguments` implements. These markers *are* special tokens, which is why the
 *   worker keeps special tokens when tools are in play for this dialect.
 *
 * The filter is a marker machine over the stream rather than a search over each chunk: a marker
 * that arrives split across two chunks is ordinary — nothing guarantees token boundaries line up
 * with it — and a missed one would put raw call syntax in front of the reader.
 *
 * Everything here is pure, and `tests/onnxTools.test.ts` pins both dialects.
 */

export type ToolDialect = 'qwen' | 'gemma'

/** One call, read out of what the model wrote. `args` is an object because both templates render
 *  a call back into the history from one — Qwen's through `tojson`, Gemma's through `dictsort` —
 *  and handing either a JSON *string* would render the string, quotes and all. */
export interface ParsedCall {
  id: string
  name: string
  args: Record<string, unknown>
}

const MARKERS: Record<ToolDialect, { open: string; close: string }> = {
  qwen: { open: '<tool_call>', close: '</tool_call>' },
  gemma: { open: '<|tool_call>', close: '<tool_call|>' },
}

/**
 * Which dialect a model writes, or null for one that cannot call a tool at all.
 *
 * Matched on the repo name because that is the only thing a provider has before the weights are
 * down — and kept to the families whose template was actually read, rather than to a guess about
 * what a name implies: GLM-Edge's template has no `tools` variable, so there is nothing to render
 * and nothing to read back.
 */
export function dialectFor(model: string): ToolDialect | null {
  const name = model.toLowerCase()
  if (name.includes('qwen')) return 'qwen'
  if (name.includes('gemma-4')) return 'gemma'
  return null
}

/** Gemma's markers are special tokens, so the worker has to stop skipping those to see them at
 *  all — which also lets the protocol tokens through, and `foldChannels` is what drops those. */
export function keepsSpecialTokens(dialect: ToolDialect): boolean {
  return dialect === 'gemma'
}

/** The longest tail of `text` that is a prefix of `marker` — what has to be held back in case the
 *  rest of the marker is in the next chunk. */
function partialTail(text: string, marker: string): number {
  const most = Math.min(text.length, marker.length - 1)
  for (let length = most; length > 0; length -= 1) {
    if (marker.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}

/**
 * The streaming half: text in, what the reader should see out, with everything between the call
 * markers held back and handed over as `calls()` once the answer is done.
 *
 * A call is **hidden rather than folded**. The `<think>` block the pane folds is already spoken
 * for by the model's own reasoning, and nesting one inside another renders as neither; the
 * provider writes its own one-line trace per round instead, from the calls this returns.
 */
export function toolFilter(dialect: ToolDialect): {
  chunk(text: string): string
  /** Anything held back that turned out not to be a marker after all. */
  end(): string
  calls(): ParsedCall[]
} {
  const { open, close } = MARKERS[dialect]
  let held = ''
  let inside = false
  let body = ''
  const bodies: string[] = []

  return {
    chunk(text) {
      held += text
      let out = ''
      for (;;) {
        const marker = inside ? close : open
        const at = held.indexOf(marker)
        if (at >= 0) {
          const before = held.slice(0, at)
          if (inside) {
            bodies.push(body + before)
            body = ''
          } else {
            out += before
          }
          held = held.slice(at + marker.length)
          inside = !inside
          continue
        }
        // No whole marker in hand: everything but a possible split one can be let go.
        const keep = partialTail(held, marker)
        const settled = held.slice(0, held.length - keep)
        if (inside) body += settled
        else out += settled
        held = held.slice(held.length - keep)
        return out
      }
    },

    end() {
      if (inside) {
        // A call the model never closed — a stopped answer, or one that ran out of room. Half a
        // call is not a call, and showing its syntax would be worse than showing nothing.
        body = ''
        held = ''
        return ''
      }
      const rest = held
      held = ''
      return rest
    },

    calls() {
      return bodies
        .map((text, index) => parseCall(dialect, text, index))
        .filter((call): call is ParsedCall => call !== null)
    },
  }
}

/** One call's body — what sat between the markers — in whichever syntax the dialect writes. */
export function parseCall(dialect: ToolDialect, body: string, index: number): ParsedCall | null {
  const id = `call_${index}`
  if (dialect === 'qwen') {
    try {
      const parsed = JSON.parse(body.trim()) as { name?: unknown; arguments?: unknown }
      if (typeof parsed.name !== 'string' || !parsed.name) return null
      // The template asks for an object; a model that wrote the object as a string is still
      // saying the same thing, and a round is too expensive to spend on the difference.
      const args =
        typeof parsed.arguments === 'string' ? safeJson(parsed.arguments) : parsed.arguments
      return { id, name: parsed.name, args: asRecord(args) }
    } catch {
      return null
    }
  }
  // Gemma: `call:read_file{file:<|"|>routes.ts<|"|>,start:1}` — its own `response_schema` names
  // this shape, down to the regex.
  const match = /call\s*:\s*(\w+)\s*(\{[\s\S]*\})?/.exec(body.trim())
  if (!match) return null
  return { id, name: match[1]!, args: parseGemmaArguments(match[2] ?? '{}') }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Gemma's `escape_token`: what wraps a string, in place of quotes. */
const ESCAPE = '<|"|>'

/**
 * Gemma's argument syntax — `{key:value,…}`, strings in `<|"|>…<|"|>`, keys either bare or escaped
 * the same way, values also objects and arrays. A hand-written scan rather than a regex because a
 * string may hold any character at all, commas and braces included: the escape markers are what
 * end it, and only they.
 */
export function parseGemmaArguments(text: string): Record<string, unknown> {
  let at = 0

  const skip = () => {
    while (at < text.length && /\s/.test(text[at]!)) at += 1
  }

  const string = (): string => {
    at += ESCAPE.length
    const end = text.indexOf(ESCAPE, at)
    const value = end === -1 ? text.slice(at) : text.slice(at, end)
    at = end === -1 ? text.length : end + ESCAPE.length
    return value
  }

  const value = (): unknown => {
    skip()
    if (text.startsWith(ESCAPE, at)) return string()
    if (text[at] === '{') return object()
    if (text[at] === '[') return array()
    const start = at
    let depth = 0
    while (at < text.length) {
      const char = text[at]!
      if (char === '{' || char === '[') depth += 1
      else if (char === '}' || char === ']') {
        if (depth === 0) break
        depth -= 1
      } else if (char === ',' && depth === 0) break
      at += 1
    }
    return scalar(text.slice(start, at).trim())
  }

  const key = (): string => {
    skip()
    if (text.startsWith(ESCAPE, at)) return string()
    const start = at
    while (at < text.length && text[at] !== ':' && text[at] !== '}') at += 1
    return text.slice(start, at).trim()
  }

  const object = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    at += 1
    for (;;) {
      skip()
      if (at >= text.length || text[at] === '}') {
        at += 1
        return out
      }
      const name = key()
      skip()
      if (text[at] === ':') at += 1
      out[name] = value()
      skip()
      if (text[at] === ',') at += 1
    }
  }

  const array = (): unknown[] => {
    const out: unknown[] = []
    at += 1
    for (;;) {
      skip()
      if (at >= text.length || text[at] === ']') {
        at += 1
        return out
      }
      out.push(value())
      skip()
      if (text[at] === ',') at += 1
    }
  }

  skip()
  return text[at] === '{' ? object() : {}
}

function scalar(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return raw
}
