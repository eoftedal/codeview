import { beforeAll, describe, expect, it } from 'vitest'
import { resolveCSharpDefinition } from '../src/lib/csharp/definitions'
import { csharpParser } from './support/csharp'

interface Resolved {
  reason: string
  label: string
  line: number
  primaryText: string
  secondaryText: string | null
  definedIn?: string
}

type OtherFiles = Record<string, string>

let defAt: (source: string, others?: OtherFiles) => Resolved | null

beforeAll(async () => {
  const parser = await csharpParser()
  /** Resolve at the offset marked by `|`. Fixtures must not use `||`, which would move it. */
  defAt = (source, others = {}) => {
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
    const result = resolveCSharpDefinition(active, open, offset)
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

describe('locals, fields and parameters', () => {
  it('resolves a local to its declaration', () => {
    expect(defAt(`class A { void M() { string s = "x"; Use(s|); } }`)).toMatchObject({
      reason: 'variable',
      primaryText: 'string s = "x";',
    })
  })

  it('resolves a field read by bare name, and dims the type header', () => {
    expect(defAt(`class A { string _v; void M() { Use(_v|); } }`)).toMatchObject({
      reason: 'property',
      primaryText: 'string _v;',
      secondaryText: 'class A',
    })
  })

  it('resolves a field read through this', () => {
    expect(defAt(`class A { string _v; void M() { Use(this._v|); } }`)).toMatchObject({
      reason: 'property',
      primaryText: 'string _v;',
    })
  })

  it('resolves a parameter', () => {
    expect(defAt(`class A { void M(string id) { Use(id|); } }`)).toMatchObject({
      reason: 'parameter',
      primaryText: 'string id',
    })
  })

  it('clips a method signature at its body', () => {
    expect(
      defAt(`class A { string M(string a, string b) { return a; } void N() { M|("x","y"); } }`),
    ).toMatchObject({ reason: 'function', primaryText: 'string M(string a, string b)' })
  })

  it('clips a signature past its attributes, not from them', () => {
    // An attribute list sits inside the declaration node, so an unclipped signature would
    // highlight `[HttpGet(...)]` and nothing a reader is looking for.
    const resolved = defAt(
      `class A {\n  [HttpGet("{id}")]\n  public string Get(string id) { return id; }\n  void N() { Get|("x"); }\n}`,
    )
    expect(resolved).toMatchObject({ primaryText: 'public string Get(string id)' })
  })

  it('separates overloads by arity', () => {
    expect(
      defAt(
        `class A { int F(int a) { return a; } int F(int a, int b) { return a; }\n  void N() { F|(1, 2); } }`,
      ),
    ).toMatchObject({ line: 1, primaryText: 'int F(int a, int b)' })
  })
})

describe('scopes', () => {
  it('treats a block as a scope, so an inner declaration does not leak', () => {
    const inner = defAt(`class A { void M() { int x = 1; { int x = 2; Use(x|); } } }`)
    expect(inner!.primaryText).toBe('int x = 2;')
  })

  it('shadows a field with a parameter', () => {
    expect(defAt(`class A { string id; void M(string id) { Use(id|); } }`)).toMatchObject({
      reason: 'parameter',
    })
  })

  it('binds a foreach target', () => {
    expect(defAt(`class A { void M() { foreach (var x in xs) { Use(x|); } } }`)).toMatchObject({
      reason: 'binding',
    })
  })

  it('binds a catch declaration', () => {
    expect(
      defAt(`class A { void M() { try { } catch (IOException ex) { Use(ex|); } } }`),
    ).toMatchObject({ reason: 'binding', primaryText: 'IOException ex' })
  })

  it('binds an is-pattern name for the rest of the block', () => {
    expect(
      defAt(`class A { void M(object o) { if (o is Wrapper w) { Use(w|); } } }`),
    ).toMatchObject({ reason: 'binding' })
  })

  it('binds an out declaration', () => {
    expect(
      defAt(`class A { void M(string s) { int.TryParse(s, out var n); Use(n|); } }`),
    ).toMatchObject({ reason: 'variable' })
  })

  it('keeps a local function local rather than making it a member', () => {
    expect(defAt(`class A { void M() { void Local(int q) { } Local|(1); } }`)).toMatchObject({
      reason: 'function',
    })
  })

  it('binds a lambda parameter', () => {
    expect(defAt(`class A { void M() { items.Where(x => x|.Id); } }`)).toMatchObject({
      reason: 'parameter',
    })
  })
})

describe('properties and records', () => {
  it('resolves an auto-property, which is storage rather than a method', () => {
    expect(
      defAt(
        `class W { public string Value { get; set; } }\nclass A { void M(W w) { Use(w.Value|); } }`,
      ),
    ).toMatchObject({ reason: 'property', primaryText: 'public string Value' })
  })

  it('resolves an expression-bodied property', () => {
    expect(
      defAt(`class W { string _v; public string Name => _v; void M() { Use(Name|); } }`),
    ).toMatchObject({ reason: 'property' })
  })

  it('resolves a positional record component as a property', () => {
    expect(
      defAt(`record ProductId(string Value);\nclass A { void M(ProductId p) { Use(p.Value|); } }`),
    ).toMatchObject({ reason: 'property', primaryText: 'string Value' })
  })

  it('resolves a primary constructor parameter inside the class body', () => {
    expect(defAt(`class Svc(IRepo repo) { void M() { repo|.Load("x"); } }`)).toMatchObject({
      reason: 'parameter',
      primaryText: 'IRepo repo',
    })
  })

  it('resolves an enum member', () => {
    expect(defAt(`enum E { A, B }\nclass C { void M() { Use(E.A|); } }`)).toMatchObject({
      reason: 'property',
    })
  })
})

describe('receivers whose type is written down', () => {
  it('follows a field of a declared type to its method', () => {
    expect(
      defAt(
        `interface IRepo { string Load(string id); }\nclass A { IRepo _r; void M() { _r.Load|("x"); } }`,
      ),
    ).toMatchObject({ reason: 'function', primaryText: 'string Load(string id);' })
  })

  it('follows a var receiver through what it constructs', () => {
    // `var` writes the type on the `new`, and `var` is how most modern C# spells a local.
    expect(
      defAt(
        `class W { public string Get() { return "x"; } }\nclass A { void M() { var w = new W(); w.Get|(); } }`,
      ),
    ).toMatchObject({ reason: 'function', primaryText: 'public string Get()' })
  })

  it('looks through a generic type to its head', () => {
    expect(
      defAt(`class Item { public string Id; }\nclass A { List<Item> xs; void M() { Use(xs|); } }`),
    ).toMatchObject({ reason: 'property' })
  })

  it('falls back to the receiver when its type cannot be named', () => {
    expect(defAt(`class A { void M() { var v = Unknown(); Use(v.Value|); } }`)).toMatchObject({
      reason: 'variable',
      primaryText: 'var v = Unknown();',
    })
  })
})

describe('base types', () => {
  it('walks into a base class for an inherited member', () => {
    expect(
      defAt(`class B { protected string _v; }\nclass D : B { void M() { Use(_v|); } }`),
    ).toMatchObject({ reason: 'property', primaryText: 'protected string _v;' })
  })

  it('walks into a base declared in another tab', () => {
    expect(
      defAt(`class D : B { void M() { Use(_v|); } }`, {
        'B.cs': `class B { protected string _v; }`,
      }),
    ).toMatchObject({ reason: 'property', definedIn: 'B.cs' })
  })
})

describe('across tabs', () => {
  it('resolves a type declared in another tab, since a using names no type', () => {
    // C# imports namespaces, not types, so nothing in the file says which tab `Repo` came from.
    expect(
      defAt(`using Shop.Data;\nclass A { void M() { var r = new Repo|(); } }`, {
        'Repo.cs': `namespace Shop.Data;\nclass Repo { }`,
      }),
    ).toMatchObject({ reason: 'class', definedIn: 'Repo.cs' })
  })

  it('follows a member into the tab that declares the type', () => {
    expect(
      defAt(`class A { void M(Repo r) { r.Load|("x"); } }`, {
        'Repo.cs': `class Repo { public string Load(string id) { return id; } }`,
      }),
    ).toMatchObject({ reason: 'function', definedIn: 'Repo.cs' })
  })

  it('follows a using alias to the tab it names', () => {
    expect(
      defAt(`using Thing = Shop.Data.Item;\nclass A { void M() { var t = new Thing|(); } }`, {
        'Item.cs': `namespace Shop.Data;\nclass Item { }`,
      }),
    ).toMatchObject({ definedIn: 'Item.cs' })
  })
})

describe('nothing outside the open tabs resolves', () => {
  it('leaves a framework type unresolved', () => {
    expect(defAt(`class A { void M() { Console|.WriteLine("x"); } }`)).toBeNull()
  })

  it('leaves an undeclared name unresolved', () => {
    expect(defAt(`class A { void M() { Use(nowhere|); } }`)).toBeNull()
  })
})

describe('the caret rule', () => {
  it('resolves with the caret one past the end of a name', () => {
    expect(defAt(`class A { void M() { int total = 1; Use(total|); } }`)).toMatchObject({
      reason: 'variable',
    })
  })

  it('resolves with the caret inside a name', () => {
    expect(defAt(`class A { void M() { int total = 1; Use(to|tal); } }`)).toMatchObject({
      reason: 'variable',
    })
  })
})
