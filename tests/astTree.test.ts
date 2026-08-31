import { describe, expect, it } from 'vitest'
import { createAnalyzer } from '../src/lib/analyzer'
import { buildTree, findNodeAtOffset, pathToRoot, type AstTree } from '../src/lib/astTree'

function treeFor(text: string, showTokens = false): AstTree {
  const analyzer = createAnalyzer()
  analyzer.update(text, 'ts')
  return buildTree(analyzer.sourceFile(), { showTokens })
}

const SOURCE = `const greeting = "hi"\nfunction greet(name: string) {\n  return name + greeting\n}\n`

describe('buildTree', () => {
  it('roots the tree at the source file', () => {
    const tree = treeFor(SOURCE)
    expect(tree.nodes[tree.root]!.kind).toBe('SourceFile')
    expect(tree.nodes[tree.root]!.parent).toBe(-1)
    expect(tree.nodes[tree.root]!.depth).toBe(0)
  })

  it('assigns ids in pre-order with consistent parent links', () => {
    const tree = treeFor(SOURCE)
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
    const tree = treeFor(SOURCE)
    const identifiers = tree.nodes.filter((n) => n.kind === 'Identifier')
    expect(identifiers.map((n) => n.label)).toContain('greeting')
    expect(tree.nodes.find((n) => n.kind === 'FunctionDeclaration')!.label).toBeUndefined()
  })

  it('omits punctuation by default and includes it with showTokens', () => {
    const structural = treeFor(SOURCE)
    const tokens = treeFor(SOURCE, true)
    expect(structural.nodes.some((n) => n.kind === 'OpenBraceToken')).toBe(false)
    expect(tokens.nodes.some((n) => n.kind === 'OpenBraceToken')).toBe(true)
    expect(tokens.nodes.length).toBeGreaterThan(structural.nodes.length)
  })

  it('skips leading trivia so a node starts at its first real character', () => {
    const tree = treeFor(`// a comment\nconst x = 1\n`)
    const statement = tree.nodes.find((n) => n.kind === 'VariableStatement')!
    expect(statement.start).toBe(13)
  })
})

describe('findNodeAtOffset', () => {
  it('finds the innermost node at an offset', () => {
    const tree = treeFor(SOURCE)
    const id = findNodeAtOffset(tree, SOURCE.indexOf('name: string'))!
    expect(tree.nodes[id]!.kind).toBe('Identifier')
    expect(tree.nodes[id]!.label).toBe('name')
  })

  it('looks left when the caret sits just past a token', () => {
    const tree = treeFor(SOURCE)
    const id = findNodeAtOffset(tree, SOURCE.indexOf('greeting') + 'greeting'.length)!
    expect(tree.nodes[id]!.label).toBe('greeting')
  })

  it('returns the root rather than null for an offset in whitespace', () => {
    const tree = treeFor(SOURCE)
    expect(findNodeAtOffset(tree, SOURCE.length)).not.toBeNull()
  })

  it('returns null outside the buffer', () => {
    const tree = treeFor(SOURCE)
    expect(findNodeAtOffset(tree, SOURCE.length + 10)).toBeNull()
  })
})

describe('pathToRoot', () => {
  it('returns a contiguous ancestor chain, root first', () => {
    const tree = treeFor(SOURCE)
    const id = findNodeAtOffset(tree, SOURCE.indexOf('name + greeting'))!
    const path = pathToRoot(tree, id)

    expect(path[0]).toBe(tree.root)
    for (let i = 1; i < path.length; i++) {
      expect(tree.nodes[path[i]!]!.parent).toBe(path[i - 1])
    }
    expect(tree.nodes[id]!.parent).toBe(path[path.length - 1])
  })

  it('is empty for the root itself', () => {
    const tree = treeFor(SOURCE)
    expect(pathToRoot(tree, tree.root)).toEqual([])
  })
})
