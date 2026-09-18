/**
 * Reading an answer out of a session. Every provider hands back a plain `ReadableStream` of deltas
 * rather than snapshots, so the accumulating is ours to do — and both panes that hold a
 * conversation do it exactly the same way.
 */

import type { AskOptions, ChatSession } from './chat'

/** Ask, and accumulate. `onDelta` is given the answer so far, not the piece that just arrived. */
export async function streamAnswer(
  session: ChatSession,
  input: string,
  options: AskOptions,
  onDelta: (answer: string) => void,
): Promise<string> {
  const reader = session.promptStreaming(input, options).getReader()
  let answer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    answer += value
    onDelta(answer)
  }
  return answer
}

/** A stop the reader asked for, as opposed to something going wrong. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
