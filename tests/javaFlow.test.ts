import { beforeAll, describe, expect, it } from 'vitest'
import type { FlowTrace } from '../src/lib/flow'
import { traceJavaOrigins } from '../src/lib/java/flow'
import { javaParser } from './support/java'

type OtherFiles = Record<string, string>

let render: (source: string, others?: OtherFiles) => string[]
let renderAcross: (source: string, others: OtherFiles) => string[]

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

beforeAll(async () => {
  const parser = await javaParser()
  const traceAt = (source: string, others: OtherFiles = {}) => {
    const offset = source.indexOf('|')
    expect(offset, 'fixture must contain a | cursor marker').toBeGreaterThan(-1)
    const text = source.replace('|', '')
    const active = { name: 'Main.java', root: parser.parse(text)!.rootNode, text }
    const open = [
      active,
      ...Object.entries(others).map(([name, body]) => ({
        name,
        root: parser.parse(body)!.rootNode,
        text: body,
      })),
    ]
    return traceJavaOrigins(active, open, offset)
  }
  render = (source, others = {}) => {
    const trace = traceAt(source, others)
    return trace ? lines(trace) : ['<no trace>']
  }
  renderAcross = (source, others) => {
    const trace = traceAt(source, others)
    return trace ? lines(trace, true) : ['<no trace>']
  }
})

describe('intraprocedural flow', () => {
  it('walks an initializer chain down to a constant', () => {
    expect(
      render(`class A { String m() { String s = "seed"; String t = s; return t|; } }`),
    ).toEqual([
      'variable `t`: String t = s;',
      '  initialised from: s',
      '    initialised from: "seed" [literal]',
    ])
  })

  it('follows a reassignment, which Java writes as an expression rather than a declaration', () => {
    // Python's binder records every `x = …` as a binding; Java's `x = …` declares nothing, so this
    // comes from a scan that resolves each assignment back to the same declaration.
    expect(render(`class A { void m() { String x = "a"; x = "b"; use(x|); } }`)).toEqual([
      'variable `x`: String x = "a";',
      '  initialised from: "a" [literal]',
      '  reassigned: "b" [literal]',
    ])
  })

  it('follows both arms of a ternary and skips the condition', () => {
    expect(render(`class A { void m() { String s = c ? "a" : "b"; use(s|); } }`)).toEqual([
      'variable `s`: String s = c ? "a" : "b";',
      '  initialised from: c ? "a" : "b"',
      '    contributes: "a" [literal]',
      '    contributes: "b" [literal]',
    ])
  })

  it('follows string concatenation, which is how Java builds a query', () => {
    expect(
      render(`class A { String q(String id) { return "SELECT " + i|d; } void r() { q(req()); } }`),
    ).toEqual(['parameter `id`: String id', '  passed to `q`: req() [external]'])
  })

  it('falls back to the container for an array access', () => {
    expect(render(`class A { void m() { String r = data[i]; use(r|); } }`)).toEqual([
      'variable `r`: String r = data[i];',
      '  initialised from: data[i]',
      '    element of: data [external]',
    ])
  })
})

describe('across calls', () => {
  it('walks a parameter back out to its call site', () => {
    expect(render(`class A { String m(String p) { return p|; } void c() { m("arg"); } }`)).toEqual([
      'parameter `p`: String p',
      '  passed to `m`: "arg" [literal]',
    ])
  })

  it('calls a method nobody calls an entry point', () => {
    expect(render(`class A { String m(String p) { return p|; } }`)).toEqual([
      'parameter `p`: String p [entry]',
    ])
  })

  it('walks a field back through the constructor to the construction', () => {
    expect(
      render(
        `class A { String f; A(String h) { this.f = h; } String g() { return this.f|; } void c() { new A("x"); } }`,
      ),
    ).toEqual([
      'property `f`: String f;',
      '  initialised from: h',
      '    passed to `A`: "x" [literal]',
    ])
  })

  it('shows what was fed into a call it cannot follow, minus the constants', () => {
    expect(render(`class A { void m() { String v = Ext.call(x, "lit"); use(v|); } }`)).toEqual([
      'variable `v`: String v = Ext.call(x, "lit");',
      '  initialised from: Ext.call(x, "lit") [external]',
      '    flows into the call: Ext [external]',
      '    flows into the call: x [external]',
    ])
  })
})

describe('binding statements', () => {
  it('walks a for-each target back to what is iterated', () => {
    expect(render(`class A { void m() { for (String r : rows()) { use(r|); } } }`)).toEqual([
      'binding `r`: for (String r : rows()) { use(r); }',
      '  an element of: rows() [external]',
    ])
  })

  it('walks a try-with-resources binding back to what was opened', () => {
    expect(render(`class A { void m() { try (var r = open()) { use(r|); } } }`)).toEqual([
      'binding `r`: var r = open()',
      '  entered from: open() [external]',
    ])
  })
})

describe('terminals', () => {
  it('stops at a name nothing open declares', () => {
    expect(render(`class A { void m() { String v = unknown; use(v|); } }`)).toEqual([
      'variable `v`: String v = unknown;',
      '  initialised from: unknown [external]',
    ])
  })

  it('reports a cycle rather than looping', () => {
    const out = render(
      `class A { String a() { return b(); } String b() { return a(); } void m() { String v = a(); use(v|); } }`,
    )
    expect(out.join('\n')).toContain('[cycle]')
  })

  it('has no trace where there is no definition', () => {
    expect(render(`class A { void m() { Strin|g s = ""; } }`)).toEqual(['<no trace>'])
  })
})

describe('across tabs', () => {
  it('walks into a method in another tab through a receiver’s written-down type', () => {
    // Java says what `b` is on the line, which is what makes this reachable at all.
    expect(
      renderAcross(`class A { void m() { B b = new B(); String v = b.get(); use(v|); } }`, {
        'B.java': 'class B { String get() { return "row"; } }',
      }),
    ).toEqual([
      'Main.java variable `v`: String v = b.get();',
      '  Main.java initialised from: b.get()',
      '    B.java returned from: "row" [literal]',
    ])
  })

  it('walks a parameter back to a call site in another tab', () => {
    expect(
      renderAcross(`class Main { String use(String value) { return valu|e; } }`, {
        'Caller.java': 'class Caller { void go() { new Main().use("payload"); } }',
      }),
    ).toEqual([
      'Main.java parameter `value`: String value',
      '  Caller.java passed to `use`: "payload" [literal]',
    ])
  })
})
