import { beforeAll, describe, expect, it } from 'vitest'
import { traceCSharpOrigins } from '../src/lib/csharp/flow'
import type { FlowTrace } from '../src/lib/flow'
import { csharpParser } from './support/csharp'

type OtherFiles = Record<string, string>

let render: (source: string, others?: OtherFiles) => string[]
let renderAcross: (source: string, others: OtherFiles) => string[]
/** The trace itself, for the few assertions that are about a node rather than about the shape. */
let traceOf: (source: string, others?: OtherFiles) => FlowTrace | null

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
  const parser = await csharpParser()
  const traceAt = (source: string, others: OtherFiles = {}) => {
    const offset = source.indexOf('|')
    expect(offset, 'fixture must contain a | cursor marker').toBeGreaterThan(-1)
    const text = source.replace('|', '')
    const active = { name: 'Main.cs', root: parser.parse(text)!.rootNode, text }
    const open = [
      active,
      ...Object.entries(others).map(([name, body]) => ({
        name,
        root: parser.parse(body)!.rootNode,
        text: body,
      })),
    ]
    return traceCSharpOrigins(active, open, offset)
  }
  render = (source, others = {}) => {
    const trace = traceAt(source, others)
    return trace ? lines(trace) : ['<no trace>']
  }
  renderAcross = (source, others) => {
    const trace = traceAt(source, others)
    return trace ? lines(trace, true) : ['<no trace>']
  }
  traceOf = (source, others = {}) => traceAt(source, others)
})

describe('intraprocedural flow', () => {
  it('walks an initializer chain down to a constant', () => {
    expect(render(`class A { void M() { string a = "seed"; string b = a; Use(b|); } }`)).toEqual([
      'variable `b`: string b = a;',
      '  initialised from: a',
      '    initialised from: "seed" [literal]',
    ])
  })

  it('reports every write, not just the first', () => {
    const out = render(`class A { void M(string p) { string s = "a"; s = p; Use(s|); } }`)
    expect(out[1]).toBe('  initialised from: "a" [literal]')
    expect(out[2]).toBe('  reassigned: p')
  })

  it('keeps both arms of a conditional', () => {
    expect(
      render(`class A { void M(string p, string q) { var s = c ? p : q; Use(s|); } }`),
    ).toEqual([
      'variable `s`: var s = c ? p : q;',
      '  initialised from: c ? p : q',
      '    contributes: p',
      '      parameter `p`: string p [entry]',
      '    contributes: q',
      '      parameter `q`: string q [entry]',
    ])
  })

  it('treats an interpolated string as operands rather than a literal', () => {
    // `$"…{id}…"` is where a query gets built, so calling it a constant loses the value at exactly
    // the point a taint review is looking at. Same rule as Python's f-string.
    expect(
      render(`class A { void M(string id) { var sql = $"select {id} from p"; Use(sql|); } }`),
    ).toEqual([
      'variable `sql`: var sql = $"select {id} from p";',
      '  initialised from: $"select {id} from p"',
      '    contributes: id',
      '      parameter `id`: string id [entry]',
    ])
  })

  it('walks through a foreach binding', () => {
    expect(
      render(`class A { void M(string[] xs) { foreach (var x in xs) { Use(x|); } } }`),
    ).toEqual([
      'binding `x`: foreach (var x in xs) { Use(x); }',
      '  an element of: xs',
      '    parameter `xs`: string[] xs [entry]',
    ])
  })

  it('terminates a plain literal at the declaration', () => {
    expect(render(`class A { void M() { var s = "x"; Use(s|); } }`)).toEqual([
      'variable `s`: var s = "x";',
      '  initialised from: "x" [literal]',
    ])
  })
})

describe('across methods', () => {
  it('follows a return value back into the method that produced it', () => {
    expect(
      render(`class A { string Src() { return "s"; } void M() { var v = Src(); Use(v|); } }`),
    ).toEqual([
      'variable `v`: var v = Src();',
      '  initialised from: Src()',
      '    returned from: "s" [literal]',
    ])
  })

  it('reads an expression-bodied method as a return', () => {
    expect(render(`class A { string Src() => "s"; void M() { var v = Src(); Use(v|); } }`)).toEqual(
      [
        'variable `v`: var v = Src();',
        '  initialised from: Src()',
        '    returned from: "s" [literal]',
      ],
    )
  })

  it('follows a parameter out to its call sites', () => {
    expect(render(`class A { void Sink(string v) { Use(v|); } void M() { Sink("x"); } }`)).toEqual([
      'parameter `v`: string v',
      '  passed to `Sink`: "x" [literal]',
    ])
  })

  it('reports a parameter with no call site as an entry point', () => {
    expect(render(`class A { public void Handle(string body) { Use(body|); } }`)).toEqual([
      'parameter `body`: string body [entry]',
    ])
  })

  it('unwraps a named argument', () => {
    // C# wraps every argument in an `argument` node, which may carry a name in front of it.
    expect(
      render(`class A { void Sink(string v) { Use(v|); } void M() { Sink(v: "x"); } }`),
    ).toEqual(['parameter `v`: string v', '  passed to `Sink`: "x" [literal]'])
  })

  it('stops at a cycle rather than looping', () => {
    const trace = traceOf(
      `class A { string F(string a) { return G(a); } string G(string b) { return F(b); } void M() { var v = F("x"); Use(v|); } }`,
    )
    expect(lines(trace!).some((line) => line.includes('[cycle]'))).toBe(true)
  })
})

describe('calls we cannot see into', () => {
  it('keeps what was fed into an unresolvable call', () => {
    expect(render(`class A { void M(string id) { var v = Db.Query(id); Use(v|); } }`)).toEqual([
      'variable `v`: var v = Db.Query(id);',
      '  initialised from: Db.Query(id) [external]',
      // The receiver is kept as well as the arguments, exactly as the Java walk keeps it: where a
      // receiver *is* a value (`req.Body.Get(k)`) that is the whole flow, and nothing here can
      // tell that apart from a type name.
      '    flows into the call: Db [external]',
      '    flows into the call: id',
      '      parameter `id`: string id [entry]',
    ])
  })

  it('drops a constant argument from an opaque call', () => {
    const out = render(`class A { void M(string id) { var v = Db.Query("all", id); Use(v|); } }`)
    // The literal is in the declaration's own excerpt; what matters is that it gets no row.
    expect(out.some((line) => line.includes('flows into the call: "all"'))).toBe(false)
    expect(out.some((line) => line.includes('flows into the call: id'))).toBe(true)
  })
})

describe('wrapper objects', () => {
  it('follows a value through a positional record and back out', () => {
    // The shape most taint takes: read a value, put it in a wrapper, pass the wrapper down, read
    // the value back out. `ProductId` has no constructor of its own, so no constructor row.
    expect(
      render(
        `record ProductId(string Value);\nclass A {\n  void Handle(string id) { Load(new ProductId(id)); }\n  void Load(ProductId p) { Db.Run(p.Value|); }\n}`,
      ),
    ).toEqual([
      'property `Value`: p.Value',
      '  `.Value` read from: p',
      '    passed to `Load`: new ProductId(id)',
      '      passed to `ProductId`: id',
      '        parameter `id`: string id [entry]',
    ])
  })

  it('follows a value through an ordinary constructor, and shows the constructor', () => {
    // A constructor is where a value is validated or rejected, so a trace that steps over it reads
    // as though the value arrived untouched.
    expect(
      render(
        `class W {\n  public string V;\n  public W(string v) { V = v.Trim(); }\n}\nclass A {\n  void Handle(string id) { Load(new W(id)); }\n  void Load(W w) { Db.Run(w.V|); }\n}`,
      ),
    ).toEqual([
      'property `V`: w.V',
      '  `.V` read from: w',
      '    passed to `Load`: new W(id)',
      '      constructed by `W`: public W(string v)',
      '        passed to `W`: id',
      '          parameter `id`: string id [entry]',
    ])
  })

  it('follows a value through an object initializer', () => {
    // C#'s own way of filling a property with no constructor involved.
    expect(
      render(
        `class W { public string V { get; set; } }\nclass A {\n  void Handle(string id) { Load(new W { V = id }); }\n  void Load(W w) { Db.Run(w.V|); }\n}`,
      ),
    ).toEqual([
      'property `V`: w.V',
      '  `.V` read from: w',
      '    passed to `Load`: new W { V = id }',
      '      passed to `W`: id',
      '        parameter `id`: string id [entry]',
    ])
  })

  it('follows a value through a primary constructor', () => {
    expect(
      render(
        `class W(string v) { public string Get() { return v; } }\nclass A {\n  void Handle(string id) { Load(new W(id)); }\n  void Load(W w) { Db.Run(w.Get|()); }\n}`,
      ),
    ).toEqual([
      'function `Get`: w.Get()',
      '  `.v` read from: w',
      '    passed to `Load`: new W(id)',
      '      passed to `W`: id',
      '        parameter `id`: string id [entry]',
    ])
  })

  it('follows a hand-written getter the same way', () => {
    expect(
      render(
        `class W {\n  string _v;\n  public W(string v) { _v = v; }\n  public string Get() => _v;\n}\nclass A {\n  void Handle(string id) { Load(new W(id)); }\n  void Load(W w) { Db.Run(w.Get|()); }\n}`,
      ).slice(0, 3),
    ).toEqual([
      'function `Get`: w.Get()',
      '  `._v` read from: w',
      '    passed to `Load`: new W(id)',
    ])
  })

  it('never reports a construction the value did not come through', () => {
    // The regression that matters. Expanding the member instead of following the receiver reaches
    // *every* `new ProductId(…)` in the open tabs — including the one a repository builds while
    // mapping a row, which nothing ever passes to `Load`. That is a path that cannot happen, and a
    // false path costs a reviewer more than a noisy one.
    const out = render(
      `record ProductId(string Value);\nclass Repo {\n  ProductId Map(IDataReader rs) { return new ProductId(rs.GetString("id")); }\n}\nclass A {\n  void Handle(string id) { Load(new ProductId(id)); }\n  void Load(ProductId p) { Db.Run(p.Value|); }\n}`,
    )
    expect(out.some((line) => line.includes('rs.GetString'))).toBe(false)
    expect(out.some((line) => line.includes('parameter `id`'))).toBe(true)
  })

  it('shows no constructor row where the primary constructor is the one that runs', () => {
    // A record that *also* declares a longer constructor must not have it reported for a call the
    // primary one answers — a primary constructor has no body to show, so no row is the honest
    // answer where "arity, then first declared" would name the wrong one.
    const out = render(
      `record P(string V) { public P(string v, bool check) : this(v) { } }\nclass A {\n  void Handle(string id) { Load(new P(id)); }\n  void Load(P p) { Db.Run(p.V|); }\n}`,
    )
    expect(out.some((line) => line.includes('constructed by'))).toBe(false)
    expect(out.some((line) => line.includes('parameter `id`'))).toBe(true)
  })

  it('keeps a construction with nothing fed into it a literal', () => {
    expect(render(`class W { }\nclass A { void M() { var w = new W(); Use(w|); } }`)).toEqual([
      'variable `w`: var w = new W();',
      '  initialised from: new W() [literal]',
    ])
  })
})

describe('across tabs', () => {
  it('follows a return value into the tab that declares the method', () => {
    expect(
      renderAcross(`class A { void M(Repo r) { var v = r.Load(); Use(v|); } }`, {
        'Repo.cs': `class Repo { public string Load() { return "secret"; } }`,
      }),
    ).toEqual([
      'Main.cs variable `v`: var v = r.Load();',
      '  Main.cs initialised from: r.Load()',
      '    Repo.cs returned from: "secret" [literal]',
    ])
  })

  it('follows a parameter out to a call site in another tab', () => {
    // There is no reference index, so this is a scan of every tab — which is why a trace stays on
    // an explicit request and is never wired to cursor movement.
    expect(
      renderAcross(`class Repo { public void Save(string v) { Db.Run(v|); } }`, {
        'Caller.cs': `class A { void Handle(string id) { new Repo().Save(id); } }`,
      }),
    ).toEqual([
      'Main.cs parameter `v`: string v',
      '  Caller.cs passed to `Save`: id',
      '    Caller.cs parameter `id`: string id [entry]',
    ])
  })

  it('names the tab a wrapper type is declared in, even with no row in it', () => {
    // `tracedFiles` builds the "Analyze this trace" tags out of the trace, and a wrapper with no
    // constructor leaves no row in its own file — a model asked whether the path is validated
    // cannot answer without the source.
    const trace = traceOf(
      `class A {\n  void Handle(string id) { Load(new ProductId(id)); }\n  void Load(ProductId p) { Db.Run(p.Value|); }\n}`,
      { 'ProductId.cs': `record ProductId(string Value);` },
    )
    expect(trace!.nodes.some((node) => node.definedIn === 'ProductId.cs')).toBe(true)
  })
})

describe('rooting', () => {
  it('roots a member read on the expression rather than on the declaration', () => {
    // Expanding the declaration is the very thing that reaches every object of the type.
    const trace = traceOf(
      `record ProductId(string Value);\nclass A { void M(ProductId p) { Db.Run(p.Value|); } }`,
    )
    expect(trace!.nodes[trace!.root]!.excerpt).toBe('p.Value')
  })

  it('roots a method call on the whole invocation, not on the name', () => {
    const trace = traceOf(
      `class Repo { public string Load(string id) { return id; } }\nclass A { void M(Repo r) { Db.Run(r.Load|("x")); } }`,
    )
    expect(trace!.nodes[trace!.root]!.excerpt).toBe('r.Load("x")')
  })

  it('answers null where nothing resolves', () => {
    expect(traceOf(`class A { void M() { Use(nowhere|); } }`)).toBeNull()
  })
})

describe('limits it states rather than guesses at', () => {
  it('does not follow a value out through an out parameter', () => {
    // `int.TryParse(s, out var n)` flows a value outward through an argument — an edge this walk
    // does not have. `n` reads as an entry rather than as coming from `s`.
    const out = render(`class A { void M(string s) { int.TryParse(s, out var n); Use(n|); } }`)
    expect(out.some((line) => line.includes('parameter `s`'))).toBe(false)
  })

  it('treats a lambda as a literal rather than walking into it', () => {
    expect(render(`class A { void M() { var f = (int a) => a + 1; Use(f|); } }`)).toEqual([
      'variable `f`: var f = (int a) => a + 1;',
      '  initialised from: (int a) => a + 1 [literal]',
    ])
  })
})
