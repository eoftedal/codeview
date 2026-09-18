import { describe, expect, it } from 'vitest'
import type { AskOptions, ChatSession } from '../src/lib/chat'
import { TRUNCATED_NOTE, streamAnswer, withTruncatedNote } from '../src/lib/stream'

/** A session that says its piece in chunks and, if asked to, admits it was cut off first. */
function session(chunks: string[], truncated = false): ChatSession & { asked: AskOptions[] } {
  const asked: AskOptions[] = []
  return {
    asked,
    promptStreaming(_input, options) {
      asked.push(options ?? {})
      return new ReadableStream<string>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          if (truncated) options?.onTruncated?.()
          controller.close()
        },
      })
    },
    destroy() {},
  }
}

describe('streamAnswer', () => {
  it('accumulates the deltas and hands each step the answer so far', async () => {
    const seen: string[] = []
    const answer = await streamAnswer(session(['a', 'b', 'c']), 'q', {}, (text) => seen.push(text))
    expect(answer).toEqual({ text: 'abc', truncated: false })
    expect(seen).toEqual(['a', 'ab', 'abc'])
  })

  it('reports a cut-off beside the text rather than in it', async () => {
    const answer = await streamAnswer(session(['half an ans'], true), 'q', {}, () => {})
    expect(answer).toEqual({ text: 'half an ans', truncated: true })
  })

  it('passes the caller’s options through, with the cut-off hook added', async () => {
    const asker = session([])
    const signal = new AbortController().signal
    await streamAnswer(asker, 'q', { signal, thinking: true }, () => {})
    expect(asker.asked[0]).toMatchObject({ signal, thinking: true })
    expect(asker.asked[0]!.onTruncated).toBeTypeOf('function')
  })
})

describe('withTruncatedNote', () => {
  it('leaves a finished answer alone, trimmed', () => {
    expect(withTruncatedNote({ text: '  done \n', truncated: false })).toBe('done')
  })

  it('appends the note to a cut-off answer', () => {
    expect(withTruncatedNote({ text: 'half', truncated: true })).toBe(`half\n\n${TRUNCATED_NOTE}`)
  })

  it('adds nothing to nothing — an empty answer must stay empty for the fallbacks to see', () => {
    expect(withTruncatedNote({ text: '  ', truncated: true })).toBe('')
  })
})
