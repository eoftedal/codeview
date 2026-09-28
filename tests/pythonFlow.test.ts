import { beforeAll, describe, expect, it } from 'vitest'
import type { FlowTrace } from '../src/lib/flow'
import { tracePythonOrigins } from '../src/lib/python/flow'
import { pythonParser } from './support/python'

/** Further open tabs a fixture can import from, keyed by module path. */
type OtherFiles = Record<string, string>

let render: (source: string, others?: OtherFiles) => string[]
let renderAcross: (source: string, others: OtherFiles) => string[]

/** The trace as indented `label: excerpt [origin]` lines — the whole shape in one assertion. */
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
  const parser = await pythonParser()
  /** Trace at the offset marked by `|`. Fixtures must not use `||`, which would move the marker. */
  const traceAt = (source: string, others: OtherFiles = {}) => {
    const offset = source.indexOf('|')
    expect(offset, 'fixture must contain a | cursor marker').toBeGreaterThan(-1)
    const text = source.replace('|', '')
    const active = { name: 'main.py', root: parser.parse(text)!.rootNode, text }
    const open = [
      active,
      ...Object.entries(others).map(([name, body]) => ({
        name,
        root: parser.parse(body)!.rootNode,
        text: body,
      })),
    ]
    return tracePythonOrigins(active, open, offset)
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
    expect(render(`a = "seed"\nb = a\nc = b\nc|\n`)).toEqual([
      'variable `c`: c = b',
      '  initialised from: b',
      '    initialised from: a',
      '      initialised from: "seed" [literal]',
    ])
  })

  it('follows every reassignment, not just the first', () => {
    expect(render(`x = "one"\nx = "two"\nx|\n`)).toEqual([
      'variable `x`: x = "two"',
      '  initialised from: "one" [literal]',
      '  reassigned: "two" [literal]',
    ])
  })

  it('follows both arms of a conditional and skips the condition', () => {
    expect(render(`v = "yes" if flag else "no"\nv|\n`)).toEqual([
      'variable `v`: v = "yes" if flag else "no"',
      '  initialised from: "yes" if flag else "no"',
      '    contributes: "yes" [literal]',
      '    contributes: "no" [literal]',
    ])
  })

  it('follows every interpolation of an f-string', () => {
    expect(render(`name = "n"\nq = f"SELECT {name} FROM t"\nq|\n`)).toEqual([
      'variable `q`: q = f"SELECT {name} FROM t"',
      '  initialised from: f"SELECT {name} FROM t"',
      '    contributes: name',
      '      initialised from: "n" [literal]',
    ])
  })

  it('treats a plain string as a literal but a formatted one as built', () => {
    expect(render(`q = "SELECT 1"\nq|\n`)).toEqual([
      'variable `q`: q = "SELECT 1"',
      '  initialised from: "SELECT 1" [literal]',
    ])
  })

  it('follows concatenation and falls back to the container for a subscript', () => {
    expect(render(`q = "a" + b\nq|\n`)).toEqual([
      'variable `q`: q = "a" + b',
      '  initialised from: "a" + b',
      '    contributes: "a" [literal]',
      '    contributes: b [external]',
    ])
    expect(render(`row = data["k"]\nrow|\n`)).toEqual([
      'variable `row`: row = data["k"]',
      '  initialised from: data["k"]',
      '    element of: data [external]',
    ])
  })
})

describe('across calls', () => {
  it('walks into a function body and out through its returns', () => {
    expect(render(`def make():\n    return "seed"\n\nv = make()\nv|\n`)).toEqual([
      'variable `v`: v = make()',
      '  initialised from: make()',
      '    returned from: "seed" [literal]',
    ])
  })

  it('walks a parameter back out to every call site', () => {
    expect(render(`def use(value):\n    return value|\n\nuse("a")\nuse("b")\n`)).toEqual([
      'parameter `value`: value',
      '  passed to `use`: "a" [literal]',
      '  passed to `use`: "b" [literal]',
    ])
  })

  it('matches a keyword argument by name rather than by position', () => {
    expect(render(`def use(a, b):\n    return b|\n\nuse(b="second", a="first")\n`)).toEqual([
      'parameter `b`: b',
      '  passed to `use`: "second" [literal]',
    ])
  })

  it('calls a function nobody calls an entry point', () => {
    expect(render(`def handler(request):\n    return request|\n`)).toEqual([
      'parameter `request`: request [entry]',
    ])
  })

  it('shows what was fed into a call it cannot follow, minus the constants', () => {
    // A constant handed to an opaque call says nothing about where anything came from, so it is
    // left out — the same rule lib/flow.ts applies, and what keeps these lists readable.
    expect(render(`user = "u"\nout = run(user, shell=True)\nout|\n`)).toEqual([
      'variable `out`: out = run(user, shell=True)',
      '  initialised from: run(user, shell=True) [external]',
      '    flows into the call: user',
      '      initialised from: "u" [literal]',
    ])
  })

  it('shows the receiver of a method call it cannot follow', () => {
    expect(render(`c = conn.execute(q)\nc|\n`)).toEqual([
      'variable `c`: c = conn.execute(q)',
      '  initialised from: conn.execute(q) [external]',
      '    flows into the call: conn [external]',
      '    flows into the call: q [external]',
    ])
  })
})

describe('methods and attributes', () => {
  it('walks a method parameter back to the argument, allowing for self', () => {
    expect(
      render(`class C:\n    def use(self, value):\n        return value|\n\nC().use("a")\n`),
    ).toEqual(['parameter `value`: value', '  passed to `use`: "a" [literal]'])
  })

  it('walks self.x back through __init__ to the construction', () => {
    // Constructing a class is a call to its `__init__`, and nothing in the source says so — the
    // call site reads `C("example")`. Without that link every constructor parameter would
    // terminate as an entry point, which is most of the state in object-shaped code.
    expect(
      render(
        `class C:\n    def __init__(self, host):\n        self.host = host\n    def show(self):\n        return self.host|\n\nC("example")\n`,
      ),
    ).toEqual([
      'property `host`: self.host = host',
      '  initialised from: host',
      '    passed to `C`: "example" [literal]',
    ])
  })

  it('gives the object hop its own row when an attribute cannot be named', () => {
    expect(render(`def view(request):\n    q = request.args\n    return q|\n`)).toEqual([
      'variable `q`: q = request.args',
      '  initialised from: request.args',
      '    `.args` read from: request',
      '      parameter `request`: request [entry]',
    ])
  })
})

describe('binding statements', () => {
  it('walks a for target back to what is iterated', () => {
    expect(render(`for row in rows:\n    print(row|)\n`)).toEqual([
      'binding `row`: row',
      '  an element of: rows [external]',
    ])
  })

  it('walks a with alias back to what was entered', () => {
    expect(render(`with open(path) as handle:\n    handle|\n`)).toEqual([
      'binding `handle`: handle',
      '  entered from: open(path) [external]',
      '    flows into the call: path [external]',
    ])
  })

  it('treats a caught exception as external', () => {
    expect(render(`try:\n    pass\nexcept ValueError as error:\n    error|\n`)).toEqual([
      'binding `error`: error [external]',
    ])
  })
})

describe('terminals', () => {
  it('stops at an import of something no tab holds', () => {
    expect(render(`from flask import request\nrequest|\n`)).toEqual([
      'import `request`: from flask import request [import]',
    ])
  })

  it('stops at a name nothing open declares', () => {
    expect(render(`v = undefined_thing\nv|\n`)).toEqual([
      'variable `v`: v = undefined_thing',
      '  initialised from: undefined_thing [external]',
    ])
  })

  it('reports a cycle rather than looping', () => {
    const out = render(`def a():\n    return b()\n\ndef b():\n    return a()\n\nv = a()\nv|\n`)
    expect(out.join('\n')).toContain('[cycle]')
  })

  it('has no trace where there is no definition', () => {
    expect(render(`print|("hi")\n`)).toEqual(['<no trace>'])
  })
})

describe('across files', () => {
  it('walks into an imported function and out through its return', () => {
    expect(
      renderAcross(`from db import fetch\nv = fetch()\nv|\n`, {
        'db.py': 'def fetch():\n    return "row"\n',
      }),
    ).toEqual([
      'main.py variable `v`: v = fetch()',
      '  main.py initialised from: fetch()',
      '    db.py returned from: "row" [literal]',
    ])
  })

  it('walks a parameter back to a call site in another tab', () => {
    // The declaration is here and the caller is over there — the direction an import is normally
    // read in reverse, and the reason the walk has to cross files in both directions.
    expect(
      renderAcross(`def use(value):\n    return valu|e\n`, {
        'caller.py': 'from main import use\n\nuse("payload")\n',
      }),
    ).toEqual([
      'main.py parameter `value`: value',
      '  caller.py passed to `use`: "payload" [literal]',
    ])
  })
})

describe('a value carried inside a wrapper', () => {
  const WRAPPER = {
    'wrapper.py': 'class Wrapper:\n    def __init__(self, value):\n        self.value = value\n',
  }

  it('follows a value into a wrapper object and out the other side', () => {
    // The shape that motivated this: a value is read from a request, put in an object, the object
    // is passed down, and the value is read back out. `w` is untyped, so `w.value` cannot be named
    // — but the attribute's *name* rides the fallback branch and a construction of a class that
    // has one answers it.
    expect(
      renderAcross(`def run(w):\n    return w.valu|e\n`, {
        ...WRAPPER,
        'controller.py':
          'from wrapper import Wrapper\nfrom main import run\n\ndef handle(request):\n    run(Wrapper(request.args["id"]))\n',
      }),
    ).toEqual([
      'main.py parameter `w`: w',
      '  controller.py passed to `run`: Wrapper(request.args["id"])',
      // The constructor the value passes through, in the tab that defines it: `__init__` is where
      // a value is validated, normalised or rejected, and a trace that steps over it reads as
      // though the value arrived untouched.
      '    wrapper.py constructed by `Wrapper`: def __init__(self, value):',
      '      wrapper.py initialised from: value',
      '        controller.py passed to `Wrapper`: request.args["id"]',
      '          controller.py element of: request.args',
      '            controller.py `.args` read from: request',
      '              controller.py parameter `request`: request [entry]',
    ])
  })

  it('ignores a construction the value never came through', () => {
    // A second, unrelated `Wrapper(...)` is not a way this value could have arrived. The walk
    // rides the receiver's own chain, so only constructions on that chain are reached.
    const out = renderAcross(
      `def run(w):\n    other = Wrapper("never-flows-here")\n    return w.valu|e\n`,
      {
        ...WRAPPER,
        'controller.py':
          'from wrapper import Wrapper\nfrom main import run\n\ndef handle(request):\n    run(Wrapper(request.args["id"]))\n',
      },
    ).join('\n')
    expect(out).toContain('request.args["id"]')
    expect(out).not.toContain('never-flows-here')
  })

  it('still calls a construction a literal when nothing was fed into it', () => {
    // A constant went in, so there is nothing to follow: the object really is made right here.
    expect(render(`from wrapper import Wrapper\n\nw = Wrapper("x")\nuse(w|)\n`, WRAPPER)).toEqual([
      'variable `w`: w = Wrapper("x")',
      '  initialised from: Wrapper("x") [literal]',
    ])
  })

  it('shows the constructor and what went into it, with nothing being sought', () => {
    // Tracing the wrapper itself, which is what a reader does first. The object is made here, but
    // what is *in* it came from the argument, so the construction is not a terminal.
    expect(
      renderAcross(
        `from wrapper import Wrapper\n\ndef handle(request):\n    w = Wrapper(request.args["id"])\n    return use(|w)\n`,
        WRAPPER,
      ),
    ).toEqual([
      'main.py variable `w`: w = Wrapper(request.args["id"])',
      '  main.py initialised from: Wrapper(request.args["id"])',
      '    wrapper.py constructed by `Wrapper`: def __init__(self, value):',
      '      main.py passed to `Wrapper`: request.args["id"]',
      '        main.py element of: request.args',
      '          main.py `.args` read from: request',
      '            main.py parameter `request`: request [entry]',
    ])
  })

  it('and when the class has no such attribute', () => {
    expect(
      render(`def run(w):\n    return w.missin|g\n`, {
        ...WRAPPER,
        'c.py': 'from wrapper import Wrapper\nfrom main import run\n\nrun(Wrapper("x"))\n',
      }).join('\n'),
    ).toContain('[literal]')
  })
})
