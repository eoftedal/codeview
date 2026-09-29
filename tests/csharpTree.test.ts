import { beforeAll, describe, expect, it } from 'vitest'
import { findNodeAtOffset, type AstTree } from '../src/lib/astTree'
import { buildTreeSitterTree } from '../src/lib/treeSitterTree'
import { csharpParser } from './support/csharp'

let parse: (text: string, showTokens?: boolean) => AstTree

beforeAll(async () => {
  const parser = await csharpParser()
  parse = (text, showTokens = false) =>
    buildTreeSitterTree(parser.parse(text)!.rootNode, { showTokens })
})

const SOURCE = `class A {\n  string greeting = "hi";\n  string Greet(string name) { return name + greeting; }\n}\n`

describe('buildTreeSitterTree over C#', () => {
  it('roots the tree at the compilation unit', () => {
    const tree = parse(SOURCE)
    expect(tree.nodes[tree.root]!.kind).toBe('compilation_unit')
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
    expect(tree.nodes.filter((n) => n.kind === 'identifier').map((n) => n.label)).toContain(
      'greeting',
    )
    expect(tree.nodes.find((n) => n.kind === 'method_declaration')!.label).toBeUndefined()
  })

  it('omits punctuation by default and includes it with showTokens', () => {
    const structural = parse(SOURCE)
    const tokens = parse(SOURCE, true)
    expect(structural.nodes.some((n) => n.kind === '{')).toBe(false)
    expect(tokens.nodes.some((n) => n.kind === '{')).toBe(true)
    expect(tokens.nodes.some((n) => n.kind === 'class')).toBe(true)
    expect(tokens.nodes.length).toBeGreaterThan(structural.nodes.length)
  })

  it('parses modern C# with no error nodes', () => {
    // Every one of these is syntax a stale grammar would choke on, and the grammar's version is
    // the one thing the package does not declare — so it is pinned here instead.
    const tree = parse(
      `namespace Shop.Api;\n\npublic record ProductId(string Value);\n\n[ApiController]\npublic class Svc(IRepo repo) : Base {\n  public string Name => _n;\n  public string Q { get; init; }\n  [HttpGet("{id}")]\n  public async Task<IActionResult> Get([FromRoute] string id) {\n    var s = $"x {id} y";\n    return o switch { "a" => 1, _ => 2 };\n  }\n}\n`,
    )
    expect(tree.nodes.some((n) => n.kind === 'ERROR')).toBe(false)
    for (const kind of [
      'file_scoped_namespace_declaration',
      'record_declaration',
      'attribute_list',
      'arrow_expression_clause',
      'interpolated_string_expression',
      'switch_expression',
    ]) {
      expect(
        tree.nodes.some((n) => n.kind === kind),
        kind,
      ).toBe(true)
    }
  })
})

describe('offsets', () => {
  it('counts UTF-16 code units, not bytes', () => {
    const text = `class A { string s = "café 🎉"; int answer = 42; }\n`
    const tree = parse(text)
    const literal = tree.nodes.find((n) => n.kind === 'integer_literal')!
    expect(text.slice(literal.start, literal.end)).toBe('42')
  })

  it('finds the innermost node at an offset, looking left at a word end', () => {
    const text = `class A { int total = 1; }\n`
    const tree = parse(text)
    const atEnd = findNodeAtOffset(tree, text.indexOf('total') + 'total'.length)
    expect(tree.nodes[atEnd!]!.kind).toBe('identifier')
    expect(tree.nodes[atEnd!]!.label).toBe('total')
  })
})

describe('error recovery', () => {
  it('shows an ERROR node for a buffer mid-edit', () => {
    const tree = parse(`class A { void M( { } }\n`)
    expect(tree.nodes.some((n) => n.kind === 'ERROR')).toBe(true)
  })

  it('announces a MISSING node rather than showing it as an ordinary one', () => {
    const tree = parse(`class A { void M() { return 1 } }\n`, true)
    expect(tree.nodes.some((n) => n.kind.startsWith('MISSING'))).toBe(true)
  })
})
