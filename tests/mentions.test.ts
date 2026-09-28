import { describe, expect, it } from 'vitest'
import {
  applyMention,
  describeAddedFiles,
  describeDraftScope,
  describeScope,
  findMentions,
  mentionAt,
  mentionedFiles,
} from '../src/lib/mentions'

const open = ['routes.ts', 'src/lib/db.ts', 'ProductId.java', 'app.py']

describe('the files a question names', () => {
  it('takes a tag written as the tab is labelled', () => {
    expect(mentionedFiles('Is @routes.ts reachable?', open)).toEqual(['routes.ts'])
    expect(mentionedFiles('Check @src/lib/db.ts', open)).toEqual(['src/lib/db.ts'])
  })

  it('takes a basename, which is how a reader names a file in prose', () => {
    expect(mentionedFiles('Look at @db.ts', open)).toEqual(['src/lib/db.ts'])
  })

  it('refuses a basename two tabs answer to', () => {
    // Guessing between them would narrow the question onto the wrong file, which is worse than
    // not narrowing it at all — the same rule `read_file` follows.
    const both = ['a/db.ts', 'b/db.ts']
    expect(mentionedFiles('@db.ts please', both)).toEqual([])
  })

  it('prefers the longest name, so a path is not read as a basename with a prefix', () => {
    const both = ['db.ts', 'src/lib/db.ts']
    expect(mentionedFiles('@src/lib/db.ts', both)).toEqual(['src/lib/db.ts'])
    expect(mentionedFiles('@db.ts', both)).toEqual(['db.ts'])
  })

  it('keeps first-mention order and names each file once', () => {
    // The order is the budget's: it is spent from the front, so what a tight one clips is the far
    // end of a path rather than the value the question is about.
    expect(mentionedFiles('@app.py then @routes.ts, and @app.py again', open)).toEqual([
      'app.py',
      'routes.ts',
    ])
  })

  it('answers with the tab’s own spelling, whatever case the tag used', () => {
    expect(mentionedFiles('@ROUTES.TS', open)).toEqual(['routes.ts'])
  })

  it('reads a tag through the punctuation a sentence puts after it', () => {
    expect(mentionedFiles('Start in @routes.ts, then @app.py.', open)).toEqual([
      'routes.ts',
      'app.py',
    ])
    expect(mentionedFiles('(@routes.ts)', open)).toEqual(['routes.ts'])
  })

  it('leaves an annotation, a decorator and an address alone', () => {
    // A pasted trace is full of `@`. A tag is only a tag where it names an open file, so the
    // Java annotation below stays prose even with a tab of that name open — the tag has to name
    // the file whole.
    expect(
      mentionedFiles('public X(@PathVariable String id)', [...open, 'PathVariable.java']),
    ).toEqual([])
    expect(mentionedFiles('@app.route("/x")', open)).toEqual([])
    expect(mentionedFiles('mail user@app.py for it', open)).toEqual([])
  })

  it('does not match a name that is only the start of another', () => {
    expect(mentionedFiles('@routes.tsx', ['routes.ts', 'routes.tsx'])).toEqual(['routes.tsx'])
    expect(mentionedFiles('@routes.tsx', ['routes.ts'])).toEqual([])
  })

  it('reports a tag that names nothing, so a composer can say so', () => {
    expect(findMentions('@gone.ts and @routes.ts', open)).toEqual([
      { start: 0, end: 8, name: null },
      { start: 13, end: 23, name: 'routes.ts' },
    ])
  })
})

describe('the tag under the caret', () => {
  it('is the run back to an `@`, however little of a name has been typed', () => {
    expect(mentionAt('look at @rou', 12)).toEqual({ start: 8, query: 'rou' })
    // A bare `@` lists everything, which is what makes it discoverable at all.
    expect(mentionAt('look at @', 9)).toEqual({ start: 8, query: '' })
  })

  it('ends at whitespace, and is nothing outside one', () => {
    expect(mentionAt('@routes.ts is fine', 18)).toBeNull()
    expect(mentionAt('no tag here', 5)).toBeNull()
  })

  it('is not an address, so a mail in the box offers no list', () => {
    expect(mentionAt('user@example', 12)).toBeNull()
  })

  it('reads the text before the caret, not the whole token', () => {
    // Completing in the middle of a half-typed name is ordinary: the query is what has been typed
    // so far, and the tail is the completion's to replace.
    expect(mentionAt('@rou.ts', 4)).toEqual({ start: 0, query: 'rou' })
  })
})

describe('completing a tag', () => {
  it('replaces the whole token, not merely what was typed before the caret', () => {
    // Otherwise completing `@rou|.ts` leaves `.ts` stranded behind the name.
    expect(applyMention('@rou.ts', 0, 'routes.ts')).toEqual({
      text: '@routes.ts ',
      caret: 11,
    })
  })

  it('leaves the rest of the sentence alone and lands the caret after the name', () => {
    const done = applyMention('is @db reachable?', 3, 'src/lib/db.ts')
    expect(done.text).toBe('is @src/lib/db.ts reachable?')
    expect(done.text.slice(done.caret)).toBe('reachable?')
  })

  it('adds no second space where one is already there, and lands past it either way', () => {
    // A caret between the name and an existing space would put the next keystroke inside the tag.
    const done = applyMention('@rou then', 0, 'routes.ts')
    expect(done.text).toBe('@routes.ts then')
    expect(done.text.slice(done.caret)).toBe('then')
  })
})

describe('what a pane says about the tags', () => {
  it('names the files, since an answer over two reads like one over twelve', () => {
    expect(describeScope(['routes.ts', 'app.py'])).toBe(
      'only the 2 files the question names (routes.ts, app.py)',
    )
    expect(describeScope(['routes.ts'])).toBe('only the file the question names (routes.ts)')
  })

  it('says what a tag on a follow-up will do, which is not what one on the first does', () => {
    // A conversation cannot be re-scoped, so a later tag adds instead — and the three outcomes
    // have to be told apart, since all three are typed the same way.
    expect(describeAddedFiles(['auth.ts'], [], false)).toBe('auth.ts will be added to this chat')
    expect(describeAddedFiles([], ['routes.ts'], false)).toBe('routes.ts is already in it')
    expect(describeAddedFiles(['auth.ts'], ['routes.ts'], false)).toBe(
      'auth.ts will be added to this chat; routes.ts is already in it',
    )
    // Nothing is ever added for a model that opens its own files; it is told to read them.
    expect(describeAddedFiles([], ['auth.ts', 'routes.ts'], true)).toBe(
      'auth.ts, routes.ts — the model is told to read them',
    )
  })

  it('promises something different of a model that reads its own files', () => {
    // The two are not the same fact. A model handed the code is handed these and no others; one
    // that reads for itself is only pointed at them, and may follow a path that leaves them.
    expect(describeDraftScope(['routes.ts'], false)).toContain('only these go to the model')
    expect(describeDraftScope(['routes.ts'], true)).toContain('the rest can still be read')
  })
})
