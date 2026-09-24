import { beforeAll, describe, expect, it } from 'vitest'
import { findNodeAtOffset, pathToRoot, type AstTree } from '../src/lib/astTree'
import { buildTreeSitterTree } from '../src/lib/treeSitterTree'
import { javaParser } from './support/java'

let parse: (text: string, showTokens?: boolean) => AstTree

beforeAll(async () => {
  const parser = await javaParser()
  parse = (text, showTokens = false) =>
    buildTreeSitterTree(parser.parse(text)!.rootNode, { showTokens })
})

const SOURCE = `class A {\n  String greeting = "hi";\n  String greet(String name) { return name + greeting; }\n}\n`

describe('buildTreeSitterTree', () => {
  it('roots the tree at the compilation unit', () => {
    const tree = parse(SOURCE)
    expect(tree.nodes[tree.root]!.kind).toBe('program')
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
    const identifiers = tree.nodes.filter((n) => n.kind === 'identifier')
    expect(identifiers.map((n) => n.label)).toContain('greeting')
    expect(tree.nodes.find((n) => n.kind === 'method_declaration')!.label).toBeUndefined()
  })

  it('omits punctuation by default and includes it with showTokens', () => {
    const structural = parse(SOURCE)
    const tokens = parse(SOURCE, true)
    // An anonymous tree-sitter node's type *is* its own text, so the brace is called '{'.
    expect(structural.nodes.some((n) => n.kind === '{')).toBe(false)
    expect(tokens.nodes.some((n) => n.kind === '{')).toBe(true)
    expect(tokens.nodes.some((n) => n.kind === 'class')).toBe(true)
    expect(tokens.nodes.length).toBeGreaterThan(structural.nodes.length)
  })

  it('reports comments as nodes of their own, unlike TypeScript trivia', () => {
    const tree = parse(`// a note\nclass A {}\n`)
    // Java spells it `line_comment`, not `comment` — the node names are each grammar's own.
    expect(tree.nodes.some((n) => n.kind === 'line_comment')).toBe(true)
  })
})

describe('offsets', () => {
  /**
   * The load-bearing one. Every `Span` in the app is a UTF-16 offset — that is what Monaco's
   * `getPositionAt` and `String.slice` both take — so a byte offset would put every highlight in
   * the wrong place, but only in files holding non-ASCII. A suite of ASCII fixtures would never
   * notice, which is why this is pinned with an accent and a non-BMP emoji.
   */
  it('indexes in UTF-16 code units, not bytes', () => {
    const text = 'class A { String x = "héllo 🎈"; String value = x; }\n'
    const tree = parse(text)
    const target = tree.nodes.find((n) => n.label === 'value')!
    expect(target.start).toBe(text.indexOf('value'))
    expect(text.slice(target.start, target.end)).toBe('value')
  })

  it('finds the innermost node at an offset, looking left of the caret', () => {
    const tree = parse(SOURCE)
    const inside = findNodeAtOffset(tree, SOURCE.indexOf('greeting') + 3)
    expect(tree.nodes[inside!]!.label).toBe('greeting')
    // A caret sits between characters, so one past the end of a word still belongs to that word.
    const past = findNodeAtOffset(tree, SOURCE.indexOf('greeting') + 'greeting'.length)
    expect(tree.nodes[past!]!.label).toBe('greeting')
  })

  it('walks the path back to the module', () => {
    const tree = parse(SOURCE)
    const id = findNodeAtOffset(tree, SOURCE.indexOf('name +') + 1)!
    expect(pathToRoot(tree, id).map((n) => tree.nodes[n]!.kind)).toContain('method_declaration')
  })
})

describe('a file mid-edit', () => {
  it('shows an ERROR node rather than no tree at all', () => {
    const tree = parse(`class A { int = ; }\n`)
    expect(tree.nodes.some((n) => n.kind === 'ERROR')).toBe(true)
  })

  it('announces a node the parser inserted to recover', () => {
    // Recovery inserts the `)` this signature needed. It is an *anonymous* node, so like every
    // other piece of punctuation it only appears with tokens on.
    const structural = parse(`class A { void f( { } }\n`)
    const tokens = parse(`class A { void f( { } }\n`, true)
    expect(structural.nodes.some((n) => n.kind.startsWith('MISSING '))).toBe(false)

    const missing = tokens.nodes.filter((n) => n.kind.startsWith('MISSING '))
    expect(missing.length).toBeGreaterThan(0)
    // Zero-width, so `findNodeAtOffset` can never select one — they are there to be seen, not
    // clicked.
    expect(missing.every((n) => n.start === n.end)).toBe(true)
  })
})
