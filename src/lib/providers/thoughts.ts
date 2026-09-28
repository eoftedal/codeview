/**
 * Gemma 4 thinks in *channels*, and this turns them into the `<think>` block the pane already
 * folds away — so `markdown.ts` keeps one syntax for thinking rather than one per model.
 *
 * A thinking answer comes back as `<|channel>thought\n…reasoning…<channel|>…the answer…`, and the
 * two markers are **special tokens**. That matters twice over. It is why the ONNX worker must turn
 * `skip_special_tokens` off while thinking: skipped, the markers vanish and the reasoning is
 * pasted onto the front of the answer with nothing to tell them apart. And it is why this can work
 * chunk by chunk without buffering — `TextStreamer` flushes on a special token and hands it over
 * alone, so a marker never arrives split down the middle, while the ordinary text around it splits
 * wherever it likes.
 *
 * Everything here is exact string work on those markers, named as the tokenizer names them, and
 * nothing else is touched: an answer that happens to talk *about* `<eos>` in a code fence is
 * ordinary text arriving in ordinary chunks, not the token.
 */

/** The tokenizer's `soc_token` and `eoc_token`: a channel opens and closes. */
const CHANNEL_OPEN = '<|channel>'
const CHANNEL_CLOSE = '<channel|>'

/** Protocol, never content: `eot_token`, then the two the model can end on. A turn marker in the
 *  stream means the model is done, not that it said "<turn|>". */
const PROTOCOL = new Set(['<turn|>', '<eos>', '<bos>', '<pad>'])

/**
 * A per-answer filter over the streamed chunks. Returns what to show, which is `''` for a chunk
 * that was pure protocol.
 *
 * The channel's *name* — `thought`, and the newline after it — is ordinary text arriving right
 * after the opening marker, so it is dropped by hand. Any channel is folded, not only `thought`:
 * whatever else a channel carries, it is not the answer.
 */
export function foldChannels(): (chunk: string) => string {
  let naming = false

  return (chunk) => {
    if (chunk === CHANNEL_OPEN) {
      naming = true
      return '<think>'
    }
    if (chunk === CHANNEL_CLOSE) {
      // A close with no open is the model's business, not ours; the pane renders what arrives.
      naming = false
      return '</think>'
    }
    if (PROTOCOL.has(chunk)) return ''

    if (naming) {
      const newline = chunk.indexOf('\n')
      // The name is one line. Until it ends, every chunk is still the name.
      if (newline === -1) return ''
      naming = false
      return chunk.slice(newline + 1)
    }

    return chunk
  }
}

/**
 * Gemma 4's protocol tokens, for the case where a server hands them over as **content**.
 *
 * `foldChannels` above is the worker's, and it can compare whole chunks because `TextStreamer`
 * flushes a special token on its own. An OpenAI-compatible server gives no such guarantee: it has
 * already detokenized, and what arrives in `delta.content` is whatever text it decided to send. A
 * server that routes the thought into `reasoning_content` but leaves the closing `<channel|>` in
 * the content — which is what an MLX build of Gemma 4 does — puts a protocol token in front of the
 * reader in the middle of a sentence.
 *
 * So these are dropped rather than translated. Turning `<channel|>` into `</think>` would be right
 * only where the *opening* marker leaked too, and a stray closer with no block open renders as
 * literal `</think>`: worse than the thing being fixed. A server that leaks the whole channel shows
 * its thought as text, which is honest and is not what was seen.
 */
const GEMMA_PROTOCOL = ['<|channel>', '<channel|>', '<turn|>', '<eos>', '<bos>', '<pad>']

/**
 * Which tokens are protocol for this model, which is the whole of what keeps this from being a
 * find-and-replace over everybody's answers. These strings are Gemma's, and an answer from any
 * other model that happens to contain one is an answer containing one — this file's own source is
 * full of them, and a chat about this repository must not have its text eaten.
 *
 * It is still a rule with a hole in it: ask a Gemma about `thoughts.ts` and it loses the tokens it
 * quotes. Worth it, because the alternative is protocol in the middle of every thinking answer on
 * that server, and the narrower rule is the one that can be stated.
 */
export function protocolTokensFor(model: string | undefined): readonly string[] {
  return model && /gemma[-_ ]?4/i.test(model) ? GEMMA_PROTOCOL : []
}

/** The longest tail of `text` that is a prefix of `token` — what has to be held back in case the
 *  rest of it is in the next chunk. */
function partialTail(text: string, token: string): number {
  const most = Math.min(text.length, token.length - 1)
  for (let length = most; length > 0; length -= 1) {
    if (token.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}

/**
 * A filter over one response's content: the named tokens removed, split across chunks or not.
 *
 * Streamed text has no reason to break where a token does, so a search per chunk would miss a
 * marker arriving in two pieces — and a missed one is exactly what the reader sees. Hence the hold:
 * a tail that could still become a token waits for the next chunk, and `end()` releases whatever
 * turned out to be ordinary text after all.
 */
export function dropTokens(tokens: readonly string[]): {
  chunk(text: string): string
  end(): string
} {
  if (tokens.length === 0) return { chunk: (text) => text, end: () => '' }
  let held = ''
  return {
    chunk(text) {
      held += text
      let out = ''
      for (;;) {
        // The earliest token in hand, so two overlapping ones cannot be taken out of order.
        let at = -1
        let found = ''
        for (const token of tokens) {
          const index = held.indexOf(token)
          if (index >= 0 && (at === -1 || index < at)) {
            at = index
            found = token
          }
        }
        if (at >= 0) {
          out += held.slice(0, at)
          held = held.slice(at + found.length)
          continue
        }
        const keep = Math.max(...tokens.map((token) => partialTail(held, token)))
        out += held.slice(0, held.length - keep)
        held = held.slice(held.length - keep)
        return out
      }
    },
    end() {
      const rest = held
      held = ''
      return rest
    },
  }
}

/**
 * The same translation for an OpenAI-compatible stream, where a reasoning model's thinking does not
 * arrive in the text at all: OpenRouter hands it back as a separate `delta.reasoning` beside
 * `delta.content`. Read only the content and the thought is simply gone — the pane shows nothing
 * for as long as the model thinks, and there is no block for `withoutThoughts` to drop.
 *
 * Each delta is given as the pair it arrived as, and what comes back is text in the one syntax
 * the pane folds: the first reasoning opens a `<think>`, the first content after it closes the
 * block. `end()` closes a block still open when the stream ends — an answer that was all thought
 * and ran out of room — so it is filed as a finished thought, not one still in progress.
 */
export function foldReasoning(): {
  delta(reasoning: string | undefined, content: string | undefined): string
  end(): string
} {
  let thinking = false
  return {
    delta(reasoning, content) {
      let out = ''
      if (reasoning) {
        if (!thinking) {
          thinking = true
          out += '<think>'
        }
        out += reasoning
      }
      if (content) {
        if (thinking) {
          thinking = false
          out += '</think>'
        }
        out += content
      }
      return out
    },
    end() {
      if (!thinking) return ''
      thinking = false
      return '</think>'
    },
  }
}

const THOUGHT = /<think>[\s\S]*?(?:<\/think>|$)/g
/** A tool row — see `markdown.ts`. Shown to the reader, but no part of the answer. */
const TOOL = /<tool>[\s\S]*?(?:<\/tool>|$)/g

/**
 * The answer without the working-out around it, for the history a follow-up question is asked
 * against and for the report an agent hands on.
 *
 * Two kinds of working-out, and they are shown differently but kept out of the same places. A
 * **thought** is folded away on screen; Gemma's own chat template drops a past turn's channels
 * the same way, and the room it saves in a small context is better spent on the code. A **tool
 * row** is shown — what the model read is worth seeing — but it is what the model *did*, not what
 * it said: the model already has the file contents in its own history, and relaying
 * `read_file routes.ts lines 1-40` to the next agent spends its window on a line that tells it
 * nothing it can check.
 *
 * A thought left unterminated — a stopped answer, thinking still in progress — takes the rest
 * with it: there was no answer yet to keep.
 */
export function withoutThoughts(answer: string): string {
  return answer.replace(THOUGHT, '').replace(TOOL, '').trim()
}
