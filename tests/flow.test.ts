import { describe, expect, it } from 'vitest'
import { createAnalyzer, type Language } from '../src/lib/analyzer'
import { traceOrigins, type FlowTrace } from '../src/lib/flow'

/** Further open files a fixture can import from, keyed by name. */
type OtherFiles = Record<string, string>

/** Trace at the offset marked by `|`. Fixtures must not use `||`, which would move the marker. */
function traceAt(
  source: string,
  language: Language = 'ts',
  others: OtherFiles = {},
): FlowTrace | null {
  const offset = source.indexOf('|')
  expect(offset, 'fixture must contain a | cursor marker').toBeGreaterThan(-1)
  const text = source.replace('|', '')

  const analyzer = createAnalyzer()
  analyzer.update([
    { name: `main.${language}`, text, language },
    ...Object.entries(others).map(([name, body]) => ({ name, text: body, language })),
  ])
  return traceOrigins(analyzer.service(), analyzer.sourceFile(), analyzer.fileName(), offset)
}

/** The trace as indented `label: excerpt [origin]` lines — the whole shape in one assertion. */
function render(source: string, language: Language = 'ts'): string[] {
  const trace = traceAt(source, language)
  if (!trace) return ['<no trace>']
  return lines(trace)
}

/** Same, with every step's file in front of it — for the traces that leave the first file. */
function renderAcross(source: string, others: OtherFiles): string[] {
  const trace = traceAt(source, 'ts', others)
  if (!trace) return ['<no trace>']
  return lines(trace, true)
}

function lines(trace: FlowTrace, withFiles = false): string[] {
  const out: string[] = []
  const walk = (id: number, depth: number): void => {
    const node = trace.nodes[id]!
    const origin = node.origin ? ` [${node.origin}]` : ''
    const where = withFiles ? `${node.file} ` : ''
    out.push(`${'  '.repeat(depth)}${where}${node.label}: ${node.excerpt}${origin}`)
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(trace.root, 0)
  return out
}

describe('intraprocedural flow', () => {
  it('walks an initializer chain down to a constant', () => {
    expect(render(`const a = 'seed'\nconst b = a\nconst c = b\nc|`)).toEqual([
      'variable `c`: const c = b',
      '  initialised from: b',
      '    initialised from: a',
      "      initialised from: 'seed' [literal]",
    ])
  })

  it('reports both branches of a ternary', () => {
    expect(render(`const pick = flag ? 'yes' : 'no'\npic|k`)).toEqual([
      "variable `pick`: const pick = flag ? 'yes' : 'no'",
      "  initialised from: flag ? 'yes' : 'no'",
      "    contributes: 'yes' [literal]",
      "    contributes: 'no' [literal]",
    ])
  })

  it('follows every assignment to a let, not just its initializer', () => {
    expect(render(`let v = 'first'\nv = 'second'\nv|`)).toEqual([
      "variable `v`: let v = 'first'",
      "  initialised from: 'first' [literal]",
      "  reassigned: 'second' [literal]",
    ])
  })

  it('does not look for writes to a const', () => {
    const lines = render(`const v = 'only'\nv|`)
    expect(lines.filter((line) => line.includes('reassigned'))).toEqual([])
  })
})

describe('across function calls', () => {
  const program = [
    "import { readInput } from './io'",
    '',
    'function sink(value: string) {',
    '  return value',
    '}',
    '',
    'function wrap(raw: string) {',
    '  return sink(raw)',
    '}',
    '',
    'const untrusted = readInput()',
    'const out = wrap(untrusted)',
  ].join('\n')

  it('walks return values and call-site arguments back to an import', () => {
    expect(render(`${program}\nou|t`)).toEqual([
      'variable `out`: const out = wrap(untrusted)',
      '  initialised from: wrap(untrusted)',
      '    returned by `wrap`: sink(raw)',
      '      returned by `sink`: value',
      '        passed to `sink`: raw',
      '          passed to `wrap`: untrusted',
      '            initialised from: readInput() [import]',
    ])
  })

  it('counts the import as an external source', () => {
    const trace = traceAt(`${program}\nou|t`)
    expect(trace?.externalCount).toBe(1)
    expect(trace?.truncated).toBe(false)
  })

  it('matches arguments through an arrow assigned to a const', () => {
    expect(render(`const arrow = (a: string) => a\nconst r = arrow('lit')\nar|row('x')`)).toEqual([
      'function `arrow`: const arrow = (a: string) =>',
      '  initialised from: (a: string) => a [literal]',
    ])
  })

  it('reaches a constructor parameter through `new`', () => {
    const source = [
      'class Box {',
      '  constructor(private readonly v: string) {}',
      '  read() {',
      '    return this.v|',
      '  }',
      '}',
      "const b = new Box('made')",
    ].join('\n')
    expect(render(source)).toEqual([
      'parameter `v`: private readonly v: string',
      "  passed to `Box`: 'made' [literal]",
    ])
  })

  it('reaches a method parameter through a property-access call', () => {
    const source = [
      'const obj = {',
      '  m(x: string) {',
      '    return x|',
      '  },',
      '}',
      "obj.m('viaMethod')",
    ].join('\n')
    expect(render(source)).toEqual([
      'parameter `x`: x: string',
      "  passed to `m`: 'viaMethod' [literal]",
    ])
  })

  it('collects every argument of a rest parameter', () => {
    const source = ['function rest(...xs: string[]) {', '  return xs|', '}', "rest('a', 'b')"].join(
      '\n',
    )
    expect(render(source)).toEqual([
      'parameter `xs`: ...xs: string[]',
      "  passed to `rest`: 'a' [literal]",
      "  passed to `rest`: 'b' [literal]",
    ])
  })

  it('falls back to a default when a call site omits the argument', () => {
    const source = [
      "const fallback = 'default'",
      'function greet(who = fallback) {',
      '  return who|',
      '}',
      'greet()',
    ].join('\n')
    expect(render(source)).toEqual([
      'parameter `who`: who = fallback',
      '  passed to `greet`: fallback',
      "    initialised from: 'default' [literal]",
    ])
  })

  it('merges the default into one node however many call sites omit it', () => {
    const source = [
      "const fallback = 'default'",
      'function greet(who = fallback) {',
      '  return who|',
      '}',
      'greet()',
      'greet()',
      'greet()',
    ].join('\n')
    expect(render(source).filter((line) => line.includes('passed to'))).toHaveLength(1)
  })
})

describe('terminals', () => {
  it('marks an unresolvable global as external', () => {
    expect(render('const secret = process.env.TOKEN\nsecr|et')).toEqual([
      'variable `secret`: const secret = process.env.TOKEN',
      '  initialised from: process.env.TOKEN [external]',
    ])
  })

  it('marks an uncalled named function’s parameter as an entry point', () => {
    expect(render('export function handler(body: string) {\n  return bod|y\n}')).toEqual([
      'parameter `body`: body: string [entry]',
    ])
    const trace = traceAt('export function handler(body: string) {\n  return bod|y\n}')
    expect(trace?.nodes[trace.root]!.origin).toBe('entry')
  })

  it('marks an inline callback’s parameter as caller-supplied, not an entry point', () => {
    const trace = traceAt('const doubled = [1, 2].map((n) => n| * 2)')
    expect(trace?.nodes[trace.root]!.origin).toBe('callback')
  })

  it('ends at a function declaration defined in the buffer', () => {
    expect(render('function make() {\n  return 1\n}\nconst f = make\nf|')).toEqual([
      'variable `f`: const f = make',
      '  initialised from: make',
      '    function `make`: function make() [literal]',
    ])
  })

  it('ends at a freshly constructed object', () => {
    expect(render('class Box {}\nconst b = new Box()\nb|')).toEqual([
      'variable `b`: const b = new Box()',
      '  initialised from: new Box() [literal]',
    ])
  })
})

describe('opaque calls', () => {
  it('keeps the chain alive through an unknown method on a tainted receiver', () => {
    expect(render('const raw = process.argv\nconst clean = raw.trim()\ncle|an')).toEqual([
      'variable `clean`: const clean = raw.trim()',
      '  initialised from: raw.trim() [external]',
      '    flows into the call: raw',
      '      initialised from: process.argv [external]',
    ])
  })

  it('carries arguments into an imported function’s result', () => {
    const source = [
      "import { parse } from './p'",
      'const tainted = process.argv',
      'const v = parse(tainted)',
      'v|',
    ].join('\n')
    expect(render(source)).toEqual([
      'variable `v`: const v = parse(tainted)',
      '  initialised from: parse(tainted) [import]',
      '    flows into the call: tainted',
      '      initialised from: process.argv [external]',
    ])
  })

  it('skips constant arguments, which cannot carry anything in', () => {
    const source = ["import { parse } from './p'", "const v = parse('literal')", 'v|'].join('\n')
    expect(render(source)).toEqual([
      "variable `v`: const v = parse('literal')",
      "  initialised from: parse('literal') [import]",
    ])
  })
})

describe('destructuring', () => {
  it('narrows to the property the binding pulls out', () => {
    const source = [
      "const config = { host: 'local', port: 8080 }",
      'const { host } = config',
      'ho|st',
    ].join('\n')
    expect(render(source)).toEqual(['binding `host`: host', "  property `host`: 'local' [literal]"])
  })

  it('follows a renamed binding to the right property', () => {
    const source = [
      "const config = { host: 'local', port: 8080 }",
      'const { port: p } = config',
      'p|',
    ].join('\n')
    expect(render(source)).toEqual(['binding `p`: port: p', '  property `port`: 8080 [literal]'])
  })

  it('narrows a destructured parameter through its call sites', () => {
    const source = [
      'function f({ nested }) {',
      '  return nest|ed',
      '}',
      "f({ nested: 'inline' })",
    ].join('\n')
    expect(render(source, 'js')).toEqual([
      'parameter `nested`: nested',
      "  passed to `f`: 'inline' [literal]",
    ])
  })
})

describe('untyped property chains', () => {
  // The case that motivated this: express's Request never resolves under `noResolve`, so
  // `req.params.id` has no declaration of its own. The chain must still reach `req`.
  const server = [
    "import express, { Request, Response } from 'express'",
    'const app = express()',
    '',
    'function getProductById(productId: string) {',
    '  return produc|tId',
    '}',
    '',
    "app.get('/product/:id', (req: Request, res: Response) => {",
    '  const productId = req.params.id',
    '  return getProductById(productId)',
    '})',
  ].join('\n')

  it('walks an unresolvable property chain back to the callback parameter', () => {
    expect(render(server)).toEqual([
      'parameter `productId`: productId: string',
      '  passed to `getProductById`: productId',
      '    initialised from: req.params.id',
      '      `.id` read from: req.params',
      '        `.params` read from: req',
      '          parameter `req`: req: Request [callback]',
    ])
  })

  it('counts the route handler as the one external source', () => {
    expect(traceAt(server)?.externalCount).toBe(1)
  })

  it('still narrows a property that does have a declaration', () => {
    // `config` is a typed object literal, so `.retries` resolves and there is no hop to show.
    expect(render('const config = { retries: 3 }\nconst n = config.retries\nn|')).toEqual([
      'variable `n`: const n = config.retries',
      '  initialised from: config.retries',
      '    property `retries`: 3 [literal]',
    ])
  })
})

describe('guards', () => {
  it('terminates on a recursive function', () => {
    const source = [
      'function loop(n: number): number {',
      '  return loop(n)',
      '}',
      'const r = loop(1)',
      'r|',
    ].join('\n')
    const lines = render(source)
    expect(lines.some((line) => line.includes('[cycle]'))).toBe(true)
    expect(traceAt(source)?.truncated).toBe(false)
  })

  it('terminates when a let is assigned from itself', () => {
    const source = ["let x = 'seed'", 'x = String(x)', 'x|'].join('\n')
    expect(() => render(source)).not.toThrow()
    expect(traceAt(source)).not.toBeNull()
  })

  it('stops at the depth budget on a very long chain', () => {
    const links = Array.from({ length: 40 }, (_, i) =>
      i === 0 ? "const v0 = 'seed'" : `const v${i} = v${i - 1}`,
    )
    const trace = traceAt(`${links.join('\n')}\nv39|`)
    expect(trace?.truncated).toBe(true)
    expect(trace!.nodes.some((node) => node.origin === 'budget')).toBe(true)
  })
})

describe('no trace', () => {
  it('returns null where nothing resolves', () => {
    expect(traceAt('const a = 1\n   |')).toBeNull()
  })
})

describe('across files', () => {
  // The shape this exists for: a request field in one tab reaching a query built in another.
  const DB = `import { open } from 'better-sqlite3'

const db = open('shop.db')

export function getProduct(productId) {
  const query = \`SELECT * FROM Products WHERE id = \${productId}\`
  return db.prepare(query).get()
}
`

  it('walks a value out of one file, through an imported callee, and back to the request', () => {
    expect(
      renderAcross(
        `import { getProduct } from './db'

app.get('/product/:id', (req) => {
  const row = getProduct(req.params.id)
  return row|
})
`,
        { 'db.ts': DB },
      ),
    ).toEqual([
      'main.ts variable `row`: const row = getProduct(req.params.id)',
      '  main.ts initialised from: getProduct(req.params.id)',
      '    db.ts returned by `getProduct`: db.prepare(query).get() [external]',
      '      db.ts flows into the call: db.prepare(query) [external]',
      '        db.ts flows into the call: db',
      "          db.ts initialised from: open('shop.db') [import]",
      '        db.ts flows into the call: query',
      '          db.ts initialised from: `SELECT * FROM Products WHERE id = ${productId}`',
      '            db.ts contributes: productId',
      // Back out of db.ts to the call site: the parameter's argument is in the other file.
      '              main.ts passed to `getProduct`: req.params.id',
      '                main.ts `.id` read from: req.params',
      '                  main.ts `.params` read from: req',
      '                    main.ts parameter `req`: req [callback]',
    ])
  })

  it('crosses an import that resolves, and ends at the constant behind it', () => {
    expect(
      renderAcross(`import { secret } from './config'\nconst token = secret\ntoken|\n`, {
        'config.ts': `export const secret = 'hunter2'\n`,
      }),
    ).toEqual([
      'main.ts variable `token`: const token = secret',
      '  main.ts initialised from: secret',
      // The hop into config.ts is the file column, not a row of its own: an identifier and the
      // declaration it resolves to are one step, the same as within a file.
      "    config.ts initialised from: 'hunter2' [literal]",
    ])
  })

  it('still stops at an import of something no tab holds', () => {
    expect(
      renderAcross(`import { secret } from 'dotenv'\nconst token = secret\ntoken|\n`, {
        'config.ts': `export const secret = 'hunter2'\n`,
      }),
    ).toEqual([
      'main.ts variable `token`: const token = secret',
      '  main.ts initialised from: secret',
      "    main.ts import `secret`: import { secret } from 'dotenv' [import]",
    ])
  })

  it('counts an origin in another file as external all the same', () => {
    const trace = traceAt(`import { readIt } from './io'\nconst body = readIt()\nbody|\n`, 'ts', {
      'io.ts': `export function readIt() {\n  return process.env.BODY\n}\n`,
    })
    expect(trace?.externalCount).toBe(1)
    expect(trace?.nodes.map((node) => node.file)).toEqual(['main.ts', 'main.ts', 'io.ts'])
  })
})
