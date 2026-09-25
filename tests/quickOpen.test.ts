import { describe, expect, it } from 'vitest'
import { quickOpen, segmentsFor } from '../src/lib/quickOpen'

const named = (...names: string[]) => names.map((name) => ({ name }))

/** Just the names, in the order the palette would list them. */
const ranked = (names: string[], query: string) =>
  quickOpen(named(...names), query).map((match) => match.file.name)

describe('quickOpen', () => {
  it('lists every file, in the order given, when nothing is typed', () => {
    const files = named('handler.ts', 'lib/db.ts', 'example.ts')
    expect(quickOpen(files, '')).toEqual([
      { file: files[0], hits: [], score: 0 },
      { file: files[1], hits: [], score: 0 },
      { file: files[2], hits: [], score: 0 },
    ])
    // Whitespace alone is still nothing typed.
    expect(ranked(['a.ts', 'b.ts'], '   ')).toEqual(['a.ts', 'b.ts'])
  })

  it('matches a subsequence rather than a substring, which is the gesture it exists for', () => {
    expect(ranked(['src/lib/base.ts', 'other.ts'], 'slb')).toEqual(['src/lib/base.ts'])
    expect(ranked(['handler.ts'], 'hdlr')).toEqual(['handler.ts'])
  })

  it('leaves out a name the query cannot be threaded through', () => {
    expect(ranked(['handler.ts', 'lib/db.ts'], 'zz')).toEqual([])
    // Order matters in a subsequence: `bd` is not `db`.
    expect(ranked(['lib/db.ts'], 'bdd')).toEqual([])
  })

  it('reads the query case-insensitively, either way round', () => {
    expect(ranked(['Handler.ts'], 'handler')).toEqual(['Handler.ts'])
    expect(ranked(['handler.ts'], 'HANDLER')).toEqual(['handler.ts'])
  })

  it('drops whitespace instead of matching it, since no name holds a space', () => {
    expect(ranked(['lib/db.ts'], 'db ts')).toEqual(['lib/db.ts'])
  })

  /** The three that make the ranking usable, each on its own. */
  it('prefers letters that run together', () => {
    // `db` is contiguous in `lib/db.ts`, scattered in `dashboard.ts`.
    expect(ranked(['dashboard.ts', 'lib/db.ts'], 'db')).toEqual(['lib/db.ts', 'dashboard.ts'])
  })

  it('prefers letters that start a word', () => {
    expect(ranked(['unrelated.ts', 'user.ts'], 'us')).toEqual(['user.ts', 'unrelated.ts'])
    // A hump counts as a word start, so an initialism finds a camelCase name ahead of one where
    // the same two letters simply happen to appear in that order.
    expect(ranked(['quarto.ts', 'quickOpen.ts'], 'qo')).toEqual(['quickOpen.ts', 'quarto.ts'])
  })

  it('prefers the file’s own name over the directories above it', () => {
    expect(ranked(['store/index.ts', 'lib/store.ts'], 'store')).toEqual([
      'lib/store.ts',
      'store/index.ts',
    ])
  })

  /** Greedy-from-the-left alone would have condemned this to the `s` of `src`. */
  it('tries every starting position, not just the first', () => {
    const [match] = quickOpen(named('src/lib/store.ts'), 'store')
    expect(match!.hits).toEqual([8, 9, 10, 11, 12])
  })

  it('breaks a tie on the shorter name, then alphabetically', () => {
    expect(ranked(['deep/nested/app.ts', 'app.ts'], 'app')).toEqual([
      'app.ts',
      'deep/nested/app.ts',
    ])
    expect(ranked(['b.ts', 'a.ts'], 'ts')).toEqual(['a.ts', 'b.ts'])
  })

  it('reports where it matched, so a row can underline it', () => {
    const [match] = quickOpen(named('lib/db.ts'), 'db')
    expect(match!.hits).toEqual([4, 5])
  })
})

describe('segmentsFor', () => {
  it('cuts the name into runs that read the same way', () => {
    expect(segmentsFor('lib/db.ts', [4, 5])).toEqual([
      { text: 'lib/', hit: false, dim: true },
      { text: 'db', hit: true, dim: false },
      { text: '.ts', hit: false, dim: false },
    ])
  })

  it('ends a run where the directory does, even mid-match', () => {
    // `b/d` straddles the last slash: matched throughout, dimmed only up to it.
    expect(segmentsFor('lib/db.ts', [2, 3, 4])).toEqual([
      { text: 'li', hit: false, dim: true },
      { text: 'b/', hit: true, dim: true },
      { text: 'd', hit: true, dim: false },
      { text: 'b.ts', hit: false, dim: false },
    ])
  })

  it('is the whole name, unmarked, when nothing was typed', () => {
    expect(segmentsFor('app.ts', [])).toEqual([{ text: 'app.ts', hit: false, dim: false }])
  })
})
