/**
 * Reading an answer out of a session. Every provider hands back a plain `ReadableStream` of deltas
 * rather than snapshots, so the accumulating is ours to do — and both panes that hold a
 * conversation do it exactly the same way.
 */

import type { AskOptions, ChatSession } from './chat'

export interface Answer {
  text: string
  /** The provider's generation ceiling ended it, not the model — see `AskOptions.onTruncated`. */
  truncated: boolean
}

/**
 * What both panes append to an answer that was cut off. It is text, not a flag, for the same
 * reason the code listing states its own clip: the note travels with the answer wherever it goes,
 * which for an agent's report includes the next hop — a reviewer handed half a report should know
 * it is half.
 */
export const TRUNCATED_NOTE = '[…cut off: the model reached its generation limit before finishing]'

/** The answer, trimmed, as it should be shown or passed on: with the note when there is one to
 *  add — and none on an empty answer, which has nothing for a note to qualify. */
export function withTruncatedNote({ text, truncated }: Answer): string {
  const trimmed = text.trim()
  return truncated && trimmed ? `${trimmed}\n\n${TRUNCATED_NOTE}` : trimmed
}

/** Ask, and accumulate. `onDelta` is given the answer so far, not the piece that just arrived. */
export async function streamAnswer(
  session: ChatSession,
  input: string,
  options: AskOptions,
  onDelta: (answer: string) => void,
): Promise<Answer> {
  let truncated = false
  // The stream itself is only text, and stays so — the built-in provider hands Chrome's own
  // stream straight through — so a cut-off is reported beside it rather than in it.
  const reader = session
    .promptStreaming(input, { ...options, onTruncated: () => (truncated = true) })
    .getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += value
    onDelta(text)
  }
  return { text, truncated }
}

/** A stop the reader asked for, as opposed to something going wrong. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
