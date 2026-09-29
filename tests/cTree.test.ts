import { beforeAll, describe, expect, it } from 'vitest'
import { findNodeAtOffset, type AstTree } from '../src/lib/astTree'
import { buildTreeSitterTree } from '../src/lib/treeSitterTree'
import { cParser } from './support/c'

let parse: (text: string, showTokens?: boolean) => AstTree

beforeAll(async () => {
  const parser = await cParser()
  parse = (text, showTokens = false) =>
    buildTreeSitterTree(parser.parse(text)!.rootNode, { showTokens })
})

const SOURCE = `#include <stdio.h>\nstruct Buf { char data[8]; };\nint add(int a, int b) { return a + b; }\n`

describe('buildTreeSitterTree over C', () => {
  it('roots the tree at the translation unit', () => {
    const tree = parse(SOURCE)
    expect(tree.nodes[tree.root]!.kind).toBe('translation_unit')
    expect(tree.nodes[tree.root]!.parent).toBe(-1)
    expect(tree.nodes[tree.root]!.depth).toBe(0)
  })

  it('assigns ids in pre-order with consistent parent links', () => {
    const tree = parse(SOURCE)
    for (const node of tree.nodes) {
      expect(node.id).toBe(tree.nodes.indexOf(node))
      for (const child of node.children) {
        expect(tree.nodes[child]!.parent).toBe(node.id)
        expect(tree.nodes[child]!.depth).toBe(node.depth + 1)
        expect(child).toBeGreaterThan(node.id)
      }
    }
  })

  it('labels leaves with their text and leaves branches unlabelled', () => {
    const tree = parse(SOURCE)
    expect(tree.nodes.filter((n) => n.kind === 'identifier').map((n) => n.label)).toContain('add')
    expect(tree.nodes.find((n) => n.kind === 'function_definition')!.label).toBeUndefined()
  })

  it('omits punctuation by default and includes it with showTokens', () => {
    const structural = parse(SOURCE)
    const tokens = parse(SOURCE, true)
    expect(structural.nodes.some((n) => n.kind === '{')).toBe(false)
    expect(tokens.nodes.some((n) => n.kind === '{')).toBe(true)
    expect(tokens.nodes.length).toBeGreaterThan(structural.nodes.length)
  })

  it('keeps the preprocessor in the tree, unexpanded', () => {
    // tree-sitter parses directives structurally and expands nothing. Both facts matter: the
    // `#define` is a row a reader can click, and the name it would produce exists nowhere.
    const tree = parse(`#define MAX 16\nint n = MAX;\n`)
    expect(tree.nodes.some((n) => n.kind === 'preproc_def')).toBe(true)
  })

  it('keeps both arms of a conditional, since nothing here evaluates one', () => {
    const tree = parse(`#ifdef A\nint x = 1;\n#else\nint x = 2;\n#endif\n`)
    const declarations = tree.nodes.filter((n) => n.kind === 'declaration')
    expect(declarations.length).toBe(2)
  })
})

describe('C++ in the same grammar', () => {
  it('parses a class with no error nodes', () => {
    const tree = parse(
      `namespace app {\nclass W : public B {\n public:\n  W(int v) : v_(v) {}\n  int Get() { return v_; }\n private:\n  int v_;\n};\n}\n`,
    )
    expect(tree.nodes.some((n) => n.kind === 'ERROR')).toBe(false)
    expect(tree.nodes.some((n) => n.kind === 'class_specifier')).toBe(true)
    expect(tree.nodes.some((n) => n.kind === 'namespace_definition')).toBe(true)
  })

  it('parses plain C through the C++ grammar with no error nodes', () => {
    // The whole reason one grammar serves both: tree-sitter-cpp is built as a superset of C's.
    const tree = parse(`#include <string.h>\nvoid f(char *d, const char *s) { strcpy(d, s); }\n`)
    expect(tree.nodes.some((n) => n.kind === 'ERROR')).toBe(false)
  })
})

describe('offsets', () => {
  it('counts UTF-16 code units, not bytes', () => {
    // A byte offset would put every highlight in the wrong place, but only in a file holding
    // non-ASCII — which a suite of ASCII fixtures would never notice.
    const text = `const char *s = "café 🎉";\nint answer = 42;\n`
    const tree = parse(text)
    const literal = tree.nodes.find((n) => n.kind === 'number_literal')!
    expect(text.slice(literal.start, literal.end)).toBe('42')
  })

  it('finds the innermost node at an offset, looking left at a word end', () => {
    const text = `int total = 1;\n`
    const tree = parse(text)
    const atEnd = findNodeAtOffset(tree, text.indexOf('total') + 'total'.length)
    expect(tree.nodes[atEnd!]!.kind).toBe('identifier')
    expect(tree.nodes[atEnd!]!.label).toBe('total')
  })
})

describe('error recovery', () => {
  it('shows an ERROR node for a buffer mid-edit', () => {
    const tree = parse(`int f( {\n`)
    expect(tree.nodes.some((n) => n.kind === 'ERROR')).toBe(true)
  })

  it('announces a MISSING node rather than showing it as an ordinary one', () => {
    // A missing node is zero-width and anonymous, so it only appears with tokens on.
    const tree = parse(`int f(void) { return 1 }\n`, true)
    expect(tree.nodes.some((n) => n.kind.startsWith('MISSING'))).toBe(true)
  })
})
