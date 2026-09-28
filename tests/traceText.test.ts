import { describe, expect, it } from 'vitest'
import { createAnalyzer } from '../src/lib/analyzer'
import { traceOrigins, type FlowNode, type FlowTrace } from '../src/lib/flow'
import { mentionedFiles } from '../src/lib/mentions'
import { ANALYZE_TASK, traceQuestion, traceToText, tracedFiles } from '../src/lib/traceText'

/** A trace built by hand, for the shapes a fixture cannot conveniently produce — a walk that ran
 *  out of budget, an origin of every kind. */
function synthetic(nodes: Partial<FlowNode>[], extra: Partial<FlowTrace> = {}): FlowTrace {
  return {
    nodes: nodes.map((node, id) => ({
      id,
      span: { start: 0, end: 1 },
      file: 'main.ts',
      line: 1,
      step: null,
      label: 'value',
      excerpt: 'x',
      children: [],
      ...node,
    })),
    root: 0,
    externalCount: nodes.filter((node) => node.origin === 'external').length,
    truncated: false,
    ...extra,
  }
}

/** The real thing, so the text is pinned against a trace the analyzer actually produces rather
 *  than against a shape only this test believes in. */
function traceOf(source: string, others: Record<string, string> = {}): FlowTrace {
  const offset = source.indexOf('|')
  const text = source.replace('|', '')
  const analyzer = createAnalyzer()
  analyzer.update([
    { name: 'main.ts', text, language: 'ts' },
    ...Object.entries(others).map(([name, body]) => ({
      name,
      text: body,
      language: 'ts' as const,
    })),
  ])
  const trace = traceOrigins(analyzer.service(), analyzer.sourceFile(), analyzer.fileName(), offset)
  expect(trace).not.toBeNull()
  return trace!
}

describe('a trace copied as text', () => {
  it('names a file and a line on every step, not only on the ones elsewhere', () => {
    // The pane leaves the file off a step in the tab on screen, because the editor beside it says
    // which that is. Pasted into a chat there is no editor, and a bare line number would point
    // into whichever file the conversation happens to be about.
    const text = traceToText(
      traceOf(`import { read } from './db'\nconst raw = read()\nconst out = ra|w\n`, {
        'db.ts': `export function read() {\n  return process.env.SEED\n}\n`,
      }),
    )
    const steps = text.split('\n').filter((line) => line.trim().startsWith('- '))
    expect(steps.length).toBeGreaterThan(1)
    for (const step of steps) expect(step).toMatch(/\((main\.ts|db\.ts) line \d+\)/)
    // Both files are named, which is the whole reason a step carries one.
    expect(text).toContain('(main.ts line')
    expect(text).toContain('(db.ts line')
  })

  it('opens with what was traced, from where, and how much of it there is', () => {
    const text = traceToText(traceOf(`const a = 'seed'\nconst b = |a\n`))
    expect(text.split('\n')[0]).toBe(
      'Backward trace of variable `a`, from main.ts line 1 — 2 steps, 1 file, no origin outside the open files.',
    )
  })

  it('counts the files and the external origins it actually crossed', () => {
    const text = traceToText(
      traceOf(`import { read } from './db'\nconst raw = read()\nconst out = ra|w\n`, {
        'db.ts': `export function read() {\n  return process.env.SEED\n}\n`,
      }),
    )
    expect(text.split('\n')[0]).toBe(
      'Backward trace of variable `raw`, from main.ts line 2 — 3 steps, 2 files, 1 origin outside the open files.',
    )
    // The step that left the first file says so itself, which is the point of the whole format.
    expect(text).toContain(
      '    - returned by `read`: process.env.SEED (db.ts line 2) — from outside the open files',
    )
  })

  it('is a markdown nested list, so the tree survives being read and re-rendered', () => {
    // A model reads a list as a tree; and wherever the text is rendered as markdown — a model
    // quoting it back, a report built from it — `markdown.ts`'s paragraph rule would fold bare
    // indentation into one paragraph, losing which step came from which.
    const text = traceToText(traceOf(`const a = 'seed'\nconst b = a\nconst c = |b\n`))
    const steps = text.split('\n').filter((line) => line.includes('- '))
    expect(steps[0]!.startsWith('- ')).toBe(true)
    expect(steps[1]!.startsWith('  - ')).toBe(true)
    expect(steps[2]!.startsWith('    - ')).toBe(true)
  })

  it('cites in the shape the brief asks a model to answer in', () => {
    // `DEFAULT_ROLE`'s own example is `\`req.body.name\` (routes.ts line 4)`, so a pasted trace
    // reads like the answer it is asking for rather than like a second notation to learn.
    const text = traceToText(traceOf(`const a = 'seed'\nconst b = |a\n`))
    expect(text).toContain("- variable `a`: const a = 'seed' (main.ts line 1)")
  })

  it('spells out what each kind of terminal means', () => {
    const text = traceToText(
      synthetic([
        { label: 'root', children: [1, 2, 3, 4, 5, 6, 7] },
        { label: 'one', origin: 'literal' },
        { label: 'two', origin: 'import' },
        { label: 'three', origin: 'external' },
        { label: 'four', origin: 'entry' },
        { label: 'five', origin: 'callback' },
        { label: 'six', origin: 'cycle' },
        { label: 'seven', origin: 'budget' },
      ]),
    )
    expect(text).toContain('— defined here')
    expect(text).toContain('— imported from a module that is not open')
    expect(text).toContain('— from outside the open files')
    expect(text).toContain('— a parameter of a function nothing open calls')
    expect(text).toContain('— a parameter supplied by whoever calls back')
    expect(text).toContain('— already traced above')
    expect(text).toContain('— the walk stopped at its budget here')
  })

  it('says the excerpts are excerpts, since a rich trace is enough to fake an answer from', () => {
    // The failure this closes: a trace carries an excerpt, a file and a line per step, which is
    // enough to write a plausible review without opening anything — so a model that *could* read
    // the files often reviews the trace instead. True on both paths: one holding the listing has
    // the file already, one with `read_file` can go and get it.
    const text = traceToText(traceOf(`const a = 'seed'\nconst b = |a\n`))
    expect(text).toContain('single-line excerpts and not the code')
    expect(text).toContain('check every step against the file it names')
    expect(text).toContain('do not report a finding from this text alone')
  })

  it('carries the limit with it, since a may-analysis read as a claim invents findings', () => {
    const text = traceToText(traceOf(`const a = 'seed'\nconst b = |a\n`))
    expect(text).toContain('may-analysis')
    expect(text).toContain('no aliasing and no path sensitivity')
    // Nothing about a budget, on a walk that finished.
    expect(text).not.toContain('incomplete')
  })

  it('says when the walk stopped at its budget, as the pane does', () => {
    const text = traceToText(synthetic([{ label: 'root' }], { truncated: true }))
    expect(text).toContain('stopped at its budget before it finished, so this trace is incomplete')
  })

  it('copies the whole trace, however much of it a reader folded away', () => {
    // Collapsing is how a large trace is read, not a statement about which steps matter — so the
    // pane's own expanded set is no part of this.
    const trace = synthetic([
      { label: 'root', children: [1] },
      { label: 'deep', children: [2] },
      { label: 'deeper', origin: 'literal' },
    ])
    expect(
      traceToText(trace)
        .split('\n')
        .filter((line) => line.includes('- ')),
    ).toHaveLength(3)
  })

  it('leaves out the colon where a step has no source to quote', () => {
    expect(traceToText(synthetic([{ label: 'value', excerpt: '' }]))).toContain(
      '- value (main.ts line 1)',
    )
  })
})

describe('handing a trace to the chat', () => {
  const across = () =>
    traceOf(`import { read } from './db'\nconst raw = read()\nconst out = ra|w\n`, {
      'db.ts': `export function read() {\n  return process.env.SEED\n}\n`,
    })

  it('asks the bare question, leaving what “analyze” means to the brief', () => {
    // A question that named what to look for would compete with the reader's own brief — a
    // hunter, a rewritten role — the way an orchestrator brief naming its own review beat the
    // task in the box.
    const question = traceQuestion(across())
    expect(question.startsWith(ANALYZE_TASK)).toBe(true)
    expect(question).toContain('Backward trace of variable `raw`')
    expect(ANALYZE_TASK.split('\n')).toHaveLength(1)
    expect(ANALYZE_TASK).not.toMatch(/taint|sink|vulnerab/i)
  })

  it('tags the files it cites, which is the whole of how it narrows the chat', () => {
    // The scope rides the question rather than an argument beside it: the reader can see what
    // narrowed the conversation, and can edit it before asking. What `useChat` then reads out of
    // the question has to be exactly the files the trace names, in the same order.
    const trace = across()
    const question = traceQuestion(trace)
    expect(question.split('\n')[0]).toBe(`${ANALYZE_TASK} @main.ts @db.ts`)
    expect(mentionedFiles(question, ['main.ts', 'db.ts', 'unrelated.ts'])).toEqual([
      'main.ts',
      'db.ts',
    ])
  })

  it('does not let an annotation in the trace itself name a file', () => {
    // The text below the tags is full of `@`: `@PathVariable` in Java, `@app.route` in Python.
    // A tag is resolved against the open tabs and nowhere else, so an annotation stays prose —
    // and a file that happens to share its name is only tagged when the tag names it whole.
    const trace = synthetic([
      { label: 'parameter', excerpt: '@PathVariable String id', file: 'Controller.java' },
    ])
    expect(traceQuestion(trace)).toContain('@PathVariable')
    expect(mentionedFiles(traceQuestion(trace), ['Controller.java', 'PathVariable.java'])).toEqual([
      'Controller.java',
    ])
  })

  it('names the files the trace cites, root first', () => {
    // The order is the budget's: a tight one should clip the far end of the path, not the value
    // the reader asked about.
    expect(tracedFiles(across())).toEqual(['main.ts', 'db.ts'])
  })

  it('names each file once, however many steps are in it', () => {
    expect(tracedFiles(traceOf(`const a = 'seed'\nconst b = a\nconst c = |b\n`))).toEqual([
      'main.ts',
    ])
  })

  it('adds the tab a wrapper is declared in, which no row may name', () => {
    // `new ProductId(id)` runs code in whichever tab declares the record. Where that type
    // declares no constructor there is no row to land there, and the chat would be asked to
    // judge a path through a wrapper it was never shown — so the step records the tab and the
    // scope takes it. See `FlowNode.definedIn`.
    const trace = synthetic([
      { label: 'variable `productId`', file: 'Controller.java', children: [1] },
      { label: 'initialised from', file: 'Controller.java', definedIn: 'ProductId.java' },
    ])
    expect(tracedFiles(trace)).toEqual(['Controller.java', 'ProductId.java'])
  })

  it('cites every file it names, and names every file it cites', () => {
    // A chat missing a file the text cites cannot check the citation. The other direction holds
    // for the rows — a file may additionally come from a step's `definedIn`, which is a tab the
    // path went through rather than one it cites.
    const trace = across()
    const cited = new Set(
      [...traceToText(trace).matchAll(/\(([\w./-]+) line \d+\)/g)].map((match) => match[1]!),
    )
    for (const file of cited) expect(tracedFiles(trace)).toContain(file)
    expect([...cited].sort()).toEqual([...tracedFiles(trace)].sort())
  })
})
