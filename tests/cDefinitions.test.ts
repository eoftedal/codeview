import { beforeAll, describe, expect, it } from 'vitest'
import { resolveCDefinition } from '../src/lib/c/definitions'
import { cParser } from './support/c'

interface Resolved {
  reason: string
  label: string
  line: number
  primaryText: string
  secondaryText: string | null
  definedIn?: string
}

type OtherFiles = Record<string, string>

let defAt: (source: string, others?: OtherFiles, activeName?: string) => Resolved | null

beforeAll(async () => {
  const parser = await cParser()
  /** Resolve at the offset marked by `|`. Fixtures must not use `||`, which would move it. */
  defAt = (source, others = {}, activeName = 'main.c') => {
    const offset = source.indexOf('|')
    expect(offset, 'fixture must contain a | cursor marker').toBeGreaterThan(-1)
    const text = source.replace('|', '')
    const active = { name: activeName, root: parser.parse(text)!.rootNode, text }
    const open = [
      active,
      ...Object.entries(others).map(([name, body]) => ({
        name,
        root: parser.parse(body)!.rootNode,
        text: body,
      })),
    ]
    const result = resolveCDefinition(active, open, offset)
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

describe('locals, parameters and functions', () => {
  it('resolves a local to its declaration', () => {
    expect(defAt(`void f(void) { int n = 1; use(n|); }`)).toMatchObject({
      reason: 'variable',
      primaryText: 'int n = 1;',
    })
  })

  it('resolves a parameter through the declarator chain', () => {
    // `char *src` nests the name inside a pointer declarator, so nothing can ask for a `name`
    // field — the binder walks down instead.
    expect(defAt(`void f(const char *src) { use(src|); }`)).toMatchObject({
      reason: 'parameter',
      primaryText: 'const char *src',
    })
  })

  it('resolves a name inside an array-of-pointer declarator', () => {
    expect(defAt(`int main(int argc, char *argv[]) { use(argv|); }`)).toMatchObject({
      reason: 'parameter',
      primaryText: 'char *argv[]',
    })
  })

  it('clips a function signature at its body', () => {
    expect(defAt(`int add(int a, int b) { return a + b; }\nint n = add|(1, 2);`)).toMatchObject({
      reason: 'function',
      primaryText: 'int add(int a, int b)',
    })
  })

  it('prefers the definition over the prototype when both are open', () => {
    expect(
      defAt(`int add(int a, int b);\nint add(int a, int b) { return a + b; }\nint n = add|(1,2);`),
    ).toMatchObject({ primaryText: 'int add(int a, int b)', line: 2 })
  })

  it('separates overloads by arity', () => {
    expect(
      defAt(`int f(int a) { return a; }\nint f(int a, int b) { return a; }\nint n = f|(1, 2);`),
    ).toMatchObject({ line: 2 })
  })
})

describe('scopes', () => {
  it('treats a block as a scope, so an inner declaration does not leak', () => {
    const inner = defAt(`void f(void) { int x = 1; { int x = 2; use(x|); } }`)
    expect(inner).toMatchObject({ line: 1 })
    expect(inner!.primaryText).toBe('int x = 2;')
  })

  it('shadows a file-scope name with a parameter', () => {
    expect(defAt(`int total = 0;\nvoid f(int total) { use(total|); }`)).toMatchObject({
      reason: 'parameter',
      primaryText: 'int total',
    })
  })

  it('binds a for-range target in C++', () => {
    expect(defAt(`void f(void) { for (auto &c : s) { use(c|); } }`)).toMatchObject({
      reason: 'binding',
    })
  })
})

describe('structs, fields and enums', () => {
  it('resolves a field through a receiver whose type is written down', () => {
    expect(
      defAt(`struct Buf { int len; };\nvoid f(void) { struct Buf b; use(b.len|); }`),
    ).toMatchObject({ reason: 'property', primaryText: 'int len;', secondaryText: 'struct Buf' })
  })

  it('resolves a field through a pointer, which is the same node type', () => {
    // `field_expression` covers `.` and `->` alike, which is why there is one case for both.
    expect(
      defAt(`struct Buf { int len; };\nvoid f(struct Buf *b) { use(b->len|); }`),
    ).toMatchObject({ reason: 'property', primaryText: 'int len;' })
  })

  it('resolves a field through a typedef', () => {
    expect(
      defAt(`typedef struct Point { int x; } Point;\nvoid f(void) { Point p; use(p.x|); }`),
    ).toMatchObject({ reason: 'property', primaryText: 'int x;' })
  })

  it('puts an enum constant in the enclosing scope and dims the enum header', () => {
    // An unscoped enum's constants are written bare, which is the whole point of one in C.
    expect(defAt(`enum Color { RED, GREEN };\nint c = RED|;`)).toMatchObject({
      reason: 'property',
      primaryText: 'RED',
      secondaryText: 'enum Color',
    })
  })

  it('falls back to the receiver when its type is not written down', () => {
    // `unknown()` returns something we cannot name, so the honest answer is where the receiver
    // came from rather than a guess at which struct declares `len`.
    expect(
      defAt(`struct Buf { int len; };\nvoid f(void) { int v = unknown(); use(v.len|); }`),
    ).toMatchObject({ reason: 'variable', primaryText: 'int v = unknown();' })
  })
})

describe('C++ classes and base classes', () => {
  it('reads a field by bare name inside a method', () => {
    expect(defAt(`class W { int v_; int Get() { return v_|; } };`)).toMatchObject({
      reason: 'property',
      primaryText: 'int v_;',
    })
  })

  it('resolves a method on a receiver declared with auto', () => {
    // `auto` writes the type on the initializer, and `auto` is how most modern C++ spells a local.
    expect(
      defAt(
        `class W { public: int Get() { return 1; } };\nvoid f(void) { auto w = W(); w.Get|(); }`,
      ),
    ).toMatchObject({ reason: 'function', primaryText: 'int Get()' })
  })

  it('walks into a base class for an inherited member', () => {
    expect(
      defAt(`class B { protected: int v_; };\nclass D : public B { int Get() { return v_|; } };`),
    ).toMatchObject({ reason: 'property', primaryText: 'int v_;' })
  })
})

describe('the preprocessor', () => {
  it('resolves an object-like macro to its #define', () => {
    expect(defAt(`#define MAX 16\nint n = MAX|;`)).toMatchObject({
      reason: 'variable',
      primaryText: '#define MAX 16',
    })
  })

  it('resolves a function-like macro', () => {
    expect(defAt(`#define TWICE(x) ((x) * 2)\nint n = TWICE|(3);`)).toMatchObject({
      reason: 'function',
    })
  })

  it('does not resolve a name a macro would produce, because nothing expands one', () => {
    // Stated rather than guessed at: the name exists nowhere in the tree.
    expect(defAt(`#define DECLARE int hidden\nDECLARE;\nint n = hidden|;`)).toBeNull()
  })

  it('binds a name under an #ifdef, since nothing here evaluates the condition', () => {
    expect(defAt(`#ifdef A\nint x = 1;\n#endif\nint n = x|;`)).toMatchObject({
      reason: 'variable',
    })
  })
})

describe('across tabs', () => {
  it('follows a quoted #include to the header that declares a function', () => {
    expect(
      defAt(`#include "util.h"\nvoid f(void) { helper|(1); }`, {
        'util.h': `int helper(int n);\n`,
      }),
    ).toMatchObject({ reason: 'function', definedIn: 'util.h', primaryText: '#include "util.h"' })
  })

  it('follows an include to a struct declared in the header', () => {
    expect(
      defAt(`#include "util.h"\nvoid f(void) { struct Buf b; use(b.len|); }`, {
        'util.h': `struct Buf { int len; };\n`,
      }),
    ).toMatchObject({ reason: 'property', definedIn: 'util.h' })
  })

  it('resolves a name defined in another tab with no include, which is the linker rule', () => {
    // C has no namespaces: a non-static file-scope name is one name in one global space.
    expect(
      defAt(`void f(void) { helper|(1); }`, { 'util.c': `int helper(int n) { return n; }\n` }),
    ).toMatchObject({ reason: 'function', definedIn: 'util.c' })
  })

  it('never resolves a system header', () => {
    expect(defAt(`#include <stdio.h>\nvoid f(void) { printf|("x"); }`)).toBeNull()
  })
})

describe('nothing outside the open tabs resolves', () => {
  it('leaves a libc function unresolved', () => {
    expect(defAt(`void f(char *d, char *s) { strcpy|(d, s); }`)).toBeNull()
  })

  it('leaves an undeclared name unresolved', () => {
    expect(defAt(`void f(void) { use(nowhere|); }`)).toBeNull()
  })
})

describe('the caret rule', () => {
  it('resolves with the caret one past the end of a name', () => {
    // A caret sits between characters, so one parked at the end of a word is outside it.
    expect(defAt(`void f(void) { int total = 1; use(total|); }`)).toMatchObject({
      reason: 'variable',
    })
  })

  it('resolves with the caret inside a name', () => {
    expect(defAt(`void f(void) { int total = 1; use(to|tal); }`)).toMatchObject({
      reason: 'variable',
    })
  })
})
