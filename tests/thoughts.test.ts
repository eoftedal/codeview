import { describe, expect, it } from 'vitest'
import { foldChannels, withoutThoughts } from '../src/lib/providers/thoughts'

/** The chunks a `TextStreamer` hands over for a thinking answer: every special token alone, the
 *  ordinary text split wherever it likes. */
const ANSWER = [
  '<|channel>',
  'thought\n',
  'The ',
  'user ',
  'asks ',
  'where ',
  'taint ',
  'starts.\n',
  '<channel|>',
  'The ',
  'source ',
  'is ',
  '`req.body.name`.',
  '<turn|>',
  '<eos>',
]

const streamed = (chunks: string[]): string => {
  const fold = foldChannels()
  return chunks.map(fold).join('')
}

describe('folding Gemma’s channels', () => {
  it('turns a thought channel into the think block the pane already folds', () => {
    expect(streamed(ANSWER)).toBe(
      '<think>The user asks where taint starts.\n</think>The source is `req.body.name`.',
    )
  })

  it('drops the channel’s name, whichever chunk it arrives in', () => {
    expect(streamed(['<|channel>', 'tho', 'ught', '\nthinking', '<channel|>', 'said'])).toBe(
      '<think>thinking</think>said',
    )
  })

  it('drops the protocol tokens, since a turn marker is not something the model said', () => {
    expect(streamed(['answered', '<turn|>', '<eos>'])).toBe('answered')
  })

  it('leaves an answer with no channels exactly as it arrived', () => {
    const chunks = ['The ', 'sink ', 'is ', 'on ', 'line ', '5.']
    expect(streamed(chunks)).toBe(chunks.join(''))
  })

  it('marks thinking still in progress by leaving the block open', () => {
    // Nothing closes it, which is how `markdown.ts` tells thinking-in-progress from a finished
    // thought.
    expect(streamed(['<|channel>', 'thought\n', 'still ', 'going'])).toBe('<think>still going')
  })

  it('gives each answer its own filter, so one answer’s channel cannot leak into the next', () => {
    const first = foldChannels()
    first('<|channel>')
    const second = foldChannels()
    expect(second('The answer.')).toBe('The answer.')
  })
})

describe('the history a follow-up is asked against', () => {
  it('keeps the answer and drops the thinking', () => {
    expect(withoutThoughts('<think>reasoning</think>The source is `req.body.name`.')).toBe(
      'The source is `req.body.name`.',
    )
  })

  it('drops every block, not only the first', () => {
    expect(withoutThoughts('<think>one</think>first<think>two</think>second')).toBe('firstsecond')
  })

  it('keeps nothing from an answer stopped while it was still thinking', () => {
    expect(withoutThoughts('<think>halfway through a thoug')).toBe('')
  })

  it('leaves an answer that never thought alone', () => {
    expect(withoutThoughts('The sink is on line 5.')).toBe('The sink is on line 5.')
  })
})
