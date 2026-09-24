import { beforeAll, describe, expect, it } from 'vitest'
import { resolvePythonDefinition } from '../src/lib/python/definitions'
import { pythonParser } from './support/python'

interface Resolved {
  reason: string
  label: string
  line: number
  primaryText: string
  secondaryText: string | null
  definedIn?: string
}

/** Other open tabs, by module path — the same shape the tab strip produces. */
type OtherFiles = Record<string, string>

let defAt: (source: string, others?: OtherFiles, as?: string) => Resolved | null

beforeAll(async () => {
  const parser = await pythonParser()
  /** Resolve at the offset marked by `|`. Fixtures must not use `||`, which would move it. */
  defAt = (source, others = {}, as = 'main.py') => {
    const offset = source.indexOf('|')
    expect(offset, 'fixture must contain a | cursor marker').toBeGreaterThan(-1)
    const text = source.replace('|', '')
    const active = { name: as, root: parser.parse(text)!.rootNode, text }
    const open = [
      active,
      ...Object.entries(others).map(([name, body]) => ({
        name,
        root: parser.parse(body)!.rootNode,
        text: body,
      })),
    ]
    const result = resolvePythonDefinition(active, open, offset)
    if (!result) return null
    return {
      reason: result.reason,
      label: result.label,
      line: result.line,
      primaryText: text.slice(result.primary.start, result.primary.end),
      secondaryText: result.secondary
        ? text.slice(result.secondary.start, result.secondary.end)
        : null,
      definedIn: result.definedIn,
    }
  }
})

describe('variables', () => {
  it('resolves a plain assignment', () => {
    const def = defAt(`x = 1\nprint(x|)\n`)
    expect(def).toMatchObject({ reason: 'variable', label: 'variable `x`', primaryText: 'x = 1' })
  })

  it('resolves an annotated assignment and an augmented one', () => {
    expect(defAt(`y: int = 2\nprint(y|)\n`)?.primaryText).toBe('y: int = 2')
    expect(defAt(`z = 0\nz += 3\nprint(z|)\n`)?.primaryText).toBe('z += 3')
  })

  it('resolves a walrus', () => {
    expect(defAt(`if (n := f()):\n    print(n|)\n`)).toMatchObject({
      reason: 'variable',
      primaryText: 'n := f()',
    })
  })

  it('points at the element of a tuple unpack and dims the whole assignment', () => {
    expect(defAt(`a, b = f()\nprint(b|)\n`)).toMatchObject({
      reason: 'binding',
      primaryText: 'b',
      secondaryText: 'a, b = f()',
    })
  })

  it('reports the line the declaration is on', () => {
    expect(defAt(`\n\nx = 1\nprint(x|)\n`)?.line).toBe(3)
  })
})

describe('functions and classes', () => {
  it('clips a signature at the body', () => {
    expect(defAt(`def greet(name):\n    return name\n\ngreet|(1)\n`)).toMatchObject({
      reason: 'function',
      primaryText: 'def greet(name):',
    })
  })

  it('clips a multi-line signature at the end of its first line', () => {
    expect(defAt(`def wide(\n    a,\n    b,\n):\n    pass\n\nwide|()\n`)?.primaryText).toBe(
      'def wide(',
    )
  })

  it('clips a class at its header', () => {
    expect(defAt(`class C(Base):\n    pass\n\nC|()\n`)).toMatchObject({
      reason: 'class',
      primaryText: 'class C(Base):',
    })
  })

  it('resolves a decorated definition to the def, not the decorator', () => {
    expect(defAt(`@app.route("/x")\ndef handler():\n    pass\n\nhandler|()\n`)?.primaryText).toBe(
      'def handler():',
    )
  })
})

describe('parameters', () => {
  it('resolves every parameter form', () => {
    expect(defAt(`def f(a):\n    return a|\n`)).toMatchObject({
      reason: 'parameter',
      primaryText: 'a',
    })
    expect(defAt(`def f(b=1):\n    return b|\n`)?.primaryText).toBe('b=1')
    expect(defAt(`def f(c: int):\n    return c|\n`)?.primaryText).toBe('c: int')
    expect(defAt(`def f(d: int = 2):\n    return d|\n`)?.primaryText).toBe('d: int = 2')
    expect(defAt(`def f(*args):\n    return args|\n`)?.primaryText).toBe('*args')
    expect(defAt(`def f(**kw):\n    return kw|\n`)?.primaryText).toBe('**kw')
  })

  it('resolves a lambda parameter', () => {
    expect(defAt(`k = lambda z: z|\n`)).toMatchObject({ reason: 'parameter', primaryText: 'z' })
  })

  it('shadows a module-level name of the same name', () => {
    const def = defAt(`greeting = "hi"\ndef greet(greeting):\n    return greeting|\n`)
    expect(def).toMatchObject({ reason: 'parameter', primaryText: 'greeting' })
    expect(def!.line).toBe(2)
  })
})

describe('scope', () => {
  it('makes a name local throughout a function even when assigned below the use', () => {
    const def = defAt(`total = "module"\ndef f():\n    print(total|)\n    total = 1\n`)
    expect(def).toMatchObject({ reason: 'variable', primaryText: 'total = 1', line: 4 })
  })

  it('does not treat an if or a for body as a scope', () => {
    expect(defAt(`if cond:\n    label = "some"\nprint(label|)\n`)?.primaryText).toBe(
      'label = "some"',
    )
    expect(defAt(`for row in rows:\n    seen = row\nprint(seen|)\n`)?.primaryText).toBe(
      'seen = row',
    )
  })

  it('keeps a comprehension target out of the enclosing scope', () => {
    expect(defAt(`doubled = [r * 2 for r in rows]\nprint(r|)\n`)).toBeNull()
    // …but it resolves inside the comprehension itself.
    expect(defAt(`doubled = [r| * 2 for r in rows]\n`)).toMatchObject({
      reason: 'binding',
      primaryText: 'r',
    })
  })

  it('hides a class body from inside a method', () => {
    expect(
      defAt(`class C:\n    scheme = "tcp"\n    def m(self):\n        return scheme|\n`),
    ).toBeNull()
  })

  it('follows global to the module scope', () => {
    const def = defAt(`g = 1\ndef f():\n    global g\n    g| = 2\n`)
    expect(def).toMatchObject({ primaryText: 'g = 1', line: 1 })
  })

  it('follows nonlocal to the nearest enclosing function', () => {
    const def = defAt(
      `def outer():\n    q = 1\n    def inner():\n        nonlocal q\n        q| = 2\n`,
    )
    expect(def).toMatchObject({ primaryText: 'q = 1', line: 2 })
  })
})

describe('binding statements', () => {
  it('resolves a for target and dims its header', () => {
    expect(defAt(`for row in rows:\n    print(row|)\n`)).toMatchObject({
      reason: 'binding',
      primaryText: 'row',
      secondaryText: 'for row in rows:',
    })
  })

  it('resolves a with alias', () => {
    expect(defAt(`with open(f) as handle:\n    handle|.read()\n`)).toMatchObject({
      reason: 'binding',
      primaryText: 'handle',
    })
  })

  it('resolves an except alias', () => {
    expect(defAt(`try:\n    pass\nexcept ValueError as error:\n    print(error|)\n`)).toMatchObject(
      {
        reason: 'binding',
        primaryText: 'error',
      },
    )
  })
})

describe('imports', () => {
  it('resolves each import form to its statement', () => {
    expect(defAt(`import db\ndb|.run()\n`)).toMatchObject({
      reason: 'import',
      primaryText: 'import db',
    })
    expect(defAt(`import pkg.mod as m\nm|.run()\n`)?.primaryText).toBe('import pkg.mod as m')
    expect(defAt(`from pkg.mod import x\nx|()\n`)?.primaryText).toBe('from pkg.mod import x')
    expect(defAt(`from pkg.mod import x as y\ny|()\n`)?.primaryText).toBe(
      'from pkg.mod import x as y',
    )
  })

  it('binds the top package of a dotted import, not the leaf', () => {
    expect(defAt(`import pkg.mod\npkg|.mod.run()\n`)?.primaryText).toBe('import pkg.mod')
    expect(defAt(`import pkg.mod\nmod|()\n`)).toBeNull()
  })

  it('binds nothing from a wildcard import', () => {
    expect(defAt(`from m import *\nanything|()\n`)).toBeNull()
  })
})

describe('attributes', () => {
  it('resolves self.x to where __init__ set it, and dims the class header', () => {
    const def = defAt(
      `class C:\n    def __init__(self):\n        self.host = 1\n    def m(self):\n        return self.host|\n`,
    )
    expect(def).toMatchObject({
      reason: 'property',
      primaryText: 'self.host = 1',
      secondaryText: 'class C:',
    })
  })

  it('resolves a class-body attribute through self', () => {
    expect(
      defAt(`class C:\n    scheme = "tcp"\n    def m(self):\n        return self.scheme|\n`),
    ).toMatchObject({ reason: 'property', primaryText: 'scheme = "tcp"' })
  })

  it('resolves a method through self as a function', () => {
    expect(
      defAt(
        `class C:\n    def helper(self):\n        pass\n    def m(self):\n        return self.helper|()\n`,
      ),
    ).toMatchObject({ reason: 'function', primaryText: 'def helper(self):' })
  })

  it('resolves C.x from outside the class', () => {
    expect(defAt(`class C:\n    scheme = "tcp"\n\nprint(C.scheme|)\n`)).toMatchObject({
      reason: 'property',
      primaryText: 'scheme = "tcp"',
    })
  })

  it('falls back to where the object came from when the attribute is unknowable', () => {
    // No types, so `request.args` cannot be resolved — but `request` can, and that is the useful
    // half for a reader following untrusted data. The same fallback the TypeScript side makes.
    expect(defAt(`def view(request):\n    return request.args|\n`)).toMatchObject({
      reason: 'parameter',
      primaryText: 'request',
    })
  })

  it('follows a base class declared in the same file', () => {
    expect(
      defAt(
        `class Base:\n    scheme = "tcp"\n\nclass C(Base):\n    def m(self):\n        return self.scheme|\n`,
      ),
    ).toMatchObject({ reason: 'property', primaryText: 'scheme = "tcp"' })
  })

  it('follows an inherited method, and prefers the subclass where both declare one', () => {
    expect(
      defAt(
        `class Base:\n    def helper(self):\n        pass\n\nclass C(Base):\n    def m(self):\n        return self.helper|()\n`,
      ),
    ).toMatchObject({ reason: 'function', primaryText: 'def helper(self):' })

    // An override wins: the walk takes the class itself before any base.
    const overridden = defAt(
      `class Base:\n    def helper(self):\n        pass\n\nclass C(Base):\n    def helper(self):\n        return 1\n    def m(self):\n        return self.helper|()\n`,
    )
    expect(overridden!.line).toBe(6)
  })

  it('walks bases left to right', () => {
    expect(
      defAt(
        `class A:\n    tag = "a"\n\nclass B:\n    tag = "b"\n\nclass C(A, B):\n    def m(self):\n        return self.tag|\n`,
      )!.line,
    ).toBe(2)
  })

  it('survives a cycle in the hierarchy', () => {
    // Illegal Python, but entirely writable — and a buffer is edited into this state on the way to
    // something valid.
    expect(
      defAt(`class A(B):\n    pass\n\nclass B(A):\n    def m(self):\n        return self.nope|\n`),
    ).toMatchObject({ reason: 'parameter', primaryText: 'self' })
  })

  it('follows a base class imported from another tab', () => {
    // The declaration is in `base.py`, which has no range on this screen — so the highlight lands
    // on the import that brought the base class in, and `definedIn` says where it really lives.
    expect(
      defAt(
        `from base import Base\n\nclass C(Base):\n    def m(self):\n        return self.scheme|\n`,
        { 'base.py': 'class Base:\n    scheme = "tcp"\n' },
      ),
    ).toMatchObject({
      reason: 'property',
      label: 'property `scheme`',
      primaryText: 'from base import Base',
      definedIn: 'base.py',
    })
  })

  it('says nothing when the base class is in no open tab', () => {
    expect(
      defAt(
        `from django.db import models\n\nclass C(models):\n    def m(self):\n        return self.objects|\n`,
      ),
    ).toMatchObject({ reason: 'parameter', primaryText: 'self' })
  })

  it('says nothing about an attribute of a value it cannot name', () => {
    expect(defAt(`build().result|\n`)).toBeNull()
  })
})

describe('nothing to resolve', () => {
  it('leaves builtins alone, the way noLib leaves globals alone in TypeScript', () => {
    expect(defAt(`print|("hi")\n`)).toBeNull()
    expect(defAt(`x = len|([1])\n`)).toBeNull()
  })

  it('returns null off any identifier', () => {
    expect(defAt(`x = 1|\n`)).toBeNull()
  })
})

describe('across tabs', () => {
  it('names the tab a `from … import` really declares in', () => {
    const def = defAt(
      `from db import run
run|()
`,
      { 'db.py': 'def run():\n    pass\n' },
    )
    // The span stays on this file's import — the only thing the editor can highlight — and
    // `definedIn` says where the declaration actually lives.
    expect(def).toMatchObject({
      reason: 'import',
      primaryText: 'from db import run',
      definedIn: 'db.py',
    })
  })

  it('follows an alias to the real name in the other tab', () => {
    expect(
      defAt(
        `from db import run as go
go|()
`,
        { 'db.py': 'def run():\n    pass\n' },
      )?.definedIn,
    ).toBe('db.py')
    // The alias has to match the *imported* name, not the local one.
    expect(
      defAt(
        `from db import run as go
go|()
`,
        { 'db.py': 'def go():\n    pass\n' },
      )?.definedIn,
    ).toBeUndefined()
  })

  it('finds a package through its __init__', () => {
    expect(
      defAt(
        `from pkg import helper
helper|()
`,
        {
          'pkg/__init__.py': 'def helper():\n    pass\n',
        },
      )?.definedIn,
    ).toBe('pkg/__init__.py')
  })

  it('finds a dotted module', () => {
    expect(
      defAt(
        `from pkg.mod import x
x|()
`,
        { 'pkg/mod.py': 'def x():\n    pass\n' },
      )?.definedIn,
    ).toBe('pkg/mod.py')
  })

  it('resolves a relative import against the importing file’s own directory', () => {
    expect(
      defAt(
        `from .db import run
run|()
`,
        { 'app/db.py': 'def run():\n    pass\n' },
        'app/main.py',
      )?.definedIn,
    ).toBe('app/db.py')
    // Two dots means the parent package.
    expect(
      defAt(
        `from ..db import run
run|()
`,
        { 'db.py': 'def run():\n    pass\n' },
        'app/main.py',
      )?.definedIn,
    ).toBe('db.py')
  })

  it('treats `from . import s` as the submodule when the package declares no such name', () => {
    expect(
      defAt(
        `from . import db
db|.run()
`,
        { 'app/db.py': 'def run():\n    pass\n' },
        'app/main.py',
      )?.definedIn,
    ).toBe('app/db.py')
  })

  it('names the tab a plain `import` points at', () => {
    expect(
      defAt(
        `import db
db|.run()
`,
        { 'db.py': 'def run():\n    pass\n' },
      ),
    ).toMatchObject({
      reason: 'import',
      primaryText: 'import db',
      definedIn: 'db.py',
    })
  })

  it('says nothing about an import of something no tab holds', () => {
    const def = defAt(`from flask import request
request|.args
`)
    expect(def).toMatchObject({ reason: 'import', primaryText: 'from flask import request' })
    expect(def!.definedIn).toBeUndefined()
  })

  it('does not reach across languages', () => {
    // `db.ts` is not a Python module, and there is no build system here to say it could be.
    expect(
      defAt(
        `from db import run
run|()
`,
        { 'db.ts': 'export function run() {}' },
      )?.definedIn,
    ).toBeUndefined()
  })
})
