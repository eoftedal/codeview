import { beforeAll, describe, expect, it } from 'vitest'
import { resolveJavaDefinition } from '../src/lib/java/definitions'
import { javaParser } from './support/java'

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
  const parser = await javaParser()
  /** Resolve at the offset marked by `|`. Fixtures must not use `||`, which would move it. */
  defAt = (source, others = {}) => {
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
    const result = resolveJavaDefinition(active, open, offset)
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
    expect(defAt(`class A { void m() { String s = "x"; use(s|); } }`)).toMatchObject({
      reason: 'variable',
      primaryText: 'String s = "x";',
    })
  })

  it('resolves a field read by bare name, and dims the type header', () => {
    // Unlike Python, a method reads a field without any `this.` — the lookup walks *through* the
    // type scope rather than skipping it.
    expect(
      defAt(`class A { private String host = "h"; String get() { return hos|t; } }`),
    ).toMatchObject({
      reason: 'property',
      primaryText: 'private String host = "h";',
      secondaryText: 'class A',
    })
  })

  it('resolves the same field through this', () => {
    expect(defAt(`class A { String host; void m() { use(this.hos|t); } }`)).toMatchObject({
      reason: 'property',
      primaryText: 'String host;',
    })
  })

  it('resolves a parameter', () => {
    expect(defAt(`class A { void m(String p) { use(p|); } }`)).toMatchObject({
      reason: 'parameter',
      primaryText: 'String p',
    })
  })

  it('prefers the parameter that shadows a field', () => {
    const def = defAt(`class A { String v = "f"; void m(String v) { use(v|); } }`)
    expect(def).toMatchObject({ reason: 'parameter', primaryText: 'String v' })
  })
})

describe('block scoping', () => {
  it('keeps a name declared in a block out of the enclosing one', () => {
    // The opposite of Python, where an `if` body is not a scope.
    expect(defAt(`class A { void m() { if (c) { int t = 1; } use(t|); } }`)).toBeNull()
  })

  it('resolves it inside that block', () => {
    expect(defAt(`class A { void m() { if (c) { int t = 1; use(t|); } } }`)).toMatchObject({
      reason: 'variable',
      primaryText: 'int t = 1;',
    })
  })
})

describe('binding statements', () => {
  it('resolves a for-each target and dims its header', () => {
    expect(defAt(`class A { void m() { for (String r : rows) { use(r|); } } }`)).toMatchObject({
      reason: 'binding',
      secondaryText: 'for (String r : rows)',
    })
  })

  it('resolves a catch parameter', () => {
    expect(
      defAt(`class A { void m() { try { } catch (Exception e) { log(e|); } } }`),
    ).toMatchObject({ reason: 'binding', primaryText: 'Exception e' })
  })

  it('resolves a try-with-resources binding', () => {
    expect(defAt(`class A { void m() { try (var r = open()) { use(r|); } } }`)).toMatchObject({
      reason: 'binding',
      primaryText: 'var r = open()',
    })
  })
})

describe('methods', () => {
  it('clips a signature at the body', () => {
    expect(
      defAt(`class A { String get(int i) { return ""; } void m() { ge|t(1); } }`),
    ).toMatchObject({ reason: 'function', primaryText: 'String get(int i)' })
  })

  it('separates overloads by arity', () => {
    // The only answer a binder without types has, and it is usually enough: overloads differ in
    // arity far more often than they differ only in parameter type.
    const source = `class A { String g() { return ""; } String g(int i) { return ""; } void m() { `
    expect(defAt(`${source}g|(1); } }`)?.primaryText).toBe('String g(int i)')
    expect(defAt(`${source}g|(); } }`)?.primaryText).toBe('String g()')
  })

  it('falls back to the first declaration when arity cannot separate them', () => {
    // Stated in the README rather than guessed at silently.
    expect(
      defAt(`class A { void g(String s) { } void g(int i) { } void m() { g|(1); } }`)?.primaryText,
    ).toBe('void g(String s)')
  })

  it('clips a class at its header', () => {
    expect(defAt(`class A extends B { } class C { A| a; }`)).toMatchObject({
      reason: 'class',
      primaryText: 'class A extends B',
    })
  })
})

describe('across tabs', () => {
  it('names the tab an import points at', () => {
    expect(
      defAt(`import com.x.Db;\nclass A { void m() { Db d = new D|b(); } }`, {
        'com/x/Db.java': 'class Db { }',
      }),
    ).toMatchObject({
      reason: 'import',
      primaryText: 'import com.x.Db;',
      definedIn: 'com/x/Db.java',
    })
  })

  it('finds an imported type under its bare name too', () => {
    // A reader pasting two files into tabs rarely recreates the package directories.
    expect(
      defAt(`import com.x.Db;\nclass A { void m() { Db d = new D|b(); } }`, {
        'Db.java': 'class Db { }',
      })?.definedIn,
    ).toBe('Db.java')
  })

  it('follows a receiver’s written-down type into another tab', () => {
    // Java says what `b` is on the line, which is why this resolves where Python's could not. The
    // declaration has no range here, so the highlight lands on the receiver's own declaration.
    expect(
      defAt(`class A { void m() { B b = new B(); b.ru|n(); } }`, {
        'B.java': 'class B { void run() {} }',
      }),
    ).toMatchObject({
      reason: 'function',
      label: 'function `run`',
      primaryText: 'B b = new B();',
      definedIn: 'B.java',
    })
  })

  it('follows a supertype in another tab, anchored on the extends clause', () => {
    expect(
      defAt(`class A extends Base { String m() { return sche|me; } }`, {
        'Base.java': 'class Base { String scheme = "tcp"; }',
      }),
    ).toMatchObject({
      reason: 'property',
      label: 'property `scheme`',
      primaryText: 'Base',
      definedIn: 'Base.java',
    })
  })

  it('resolves a same-package type with no import at all', () => {
    expect(defAt(`class A { void m() { Db| d; } }`, { 'Db.java': 'class Db { }' })?.definedIn).toBe(
      'Db.java',
    )
  })

  it('does not reach across languages', () => {
    expect(defAt(`class A { void m() { Db| d; } }`, { 'db.py': 'class Db: pass' })).toBeNull()
  })
})

describe('nothing to resolve', () => {
  it('leaves the standard library alone, the way noLib leaves globals alone', () => {
    expect(defAt(`class A { void m() { Strin|g s = ""; } }`)).toBeNull()
    expect(defAt(`class A { void m() { System|.out.println(""); } }`)).toBeNull()
  })

  it('says nothing about a member of a receiver it cannot type', () => {
    expect(defAt(`class A { void m() { build().resu|lt(); } }`)).toBeNull()
  })
})
