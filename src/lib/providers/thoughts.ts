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

const THOUGHT = /<think>[\s\S]*?(?:<\/think>|$)/g

/**
 * The answer without the thinking that preceded it, for the history a follow-up question is asked
 * against. Gemma's own chat template drops a past turn's channels the same way, and the room it
 * saves in a small context is better spent on the code.
 *
 * A block left unterminated — a stopped answer, thinking still in progress — takes the rest with
 * it: there was no answer yet to keep.
 */
export function withoutThoughts(answer: string): string {
  return answer.replace(THOUGHT, '').trim()
}
