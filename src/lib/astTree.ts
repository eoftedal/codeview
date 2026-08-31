import ts from 'typescript'

/**
 * A flattened, plain-object view of a TypeScript AST.
 *
 * `ts.Node` carries circular `parent` references and lazily-computed positions, so it can neither
 * be made reactive nor cheaply diffed. Every node is copied into this flat list once per parse and
 * addressed by its pre-order index from then on.
 */
export interface AstNode {
  /** Pre-order index. Stable within a single parse, not across parses. */
  id: number
  kind: string
  /** Offset of the first non-trivia character, matching `node.getStart(sf)`. */
  start: number
  end: number
  /** Identifier or literal text, truncated. Absent for structural nodes. */
  label?: string
  /** Parent index, or -1 for the root. */
  parent: number
  children: number[]
  depth: number
}

export interface AstTree {
  nodes: AstNode[]
  root: number
}

export interface BuildOptions {
  /** Include punctuation and keyword tokens, not just structural nodes. */
  showTokens?: boolean
}

const LABEL_LIMIT = 40

/**
 * `ts.SyntaxKind[kind]` is unreliable for display: the enum aliases range markers onto real kinds,
 * and reverse lookup returns whichever name was declared first — so a VariableStatement comes back
 * as "FirstStatement" and an OpenBraceToken as "FirstPunctuation". Skip the markers.
 */
const KIND_NAMES: string[] = (() => {
  const names: string[] = []
  for (const [name, value] of Object.entries(ts.SyntaxKind)) {
    if (typeof value !== 'number') continue
    if (name.startsWith('First') || name.startsWith('Last')) continue
    if (names[value] === undefined) names[value] = name
  }
  return names
})()

export function kindName(kind: ts.SyntaxKind): string {
  return KIND_NAMES[kind] ?? `SyntaxKind(${kind})`
}

/** Text worth showing next to the kind name. Leaves carry their own text; branches don't. */
function labelFor(node: ts.Node, sf: ts.SourceFile): string | undefined {
  if (node.getChildCount(sf) > 0) return undefined
  const text = node.getText(sf)
  if (!text) return undefined
  return text.length > LABEL_LIMIT ? text.slice(0, LABEL_LIMIT) + '\u2026' : text
}

export function buildTree(sf: ts.SourceFile, options: BuildOptions = {}): AstTree {
  const nodes: AstNode[] = []

  const visit = (node: ts.Node, parent: number, depth: number): number => {
    const id = nodes.length
    const entry: AstNode = {
      id,
      kind: kindName(node.kind),
      start: node.getStart(sf),
      end: node.getEnd(),
      label: labelFor(node, sf),
      parent,
      children: [],
      depth,
    }
    nodes.push(entry)

    if (options.showTokens) {
      // getChildren() surfaces punctuation, keywords and the synthetic SyntaxList nodes.
      for (const child of node.getChildren(sf)) {
        entry.children.push(visit(child, id, depth + 1))
      }
    } else {
      ts.forEachChild(node, (child) => {
        entry.children.push(visit(child, id, depth + 1))
      })
    }
    return id
  }

  const root = visit(sf, -1, 0)
  return { nodes, root }
}

function descend(tree: AstTree, from: AstNode, offset: number): AstNode {
  let current = from
  outer: for (;;) {
    for (let i = current.children.length - 1; i >= 0; i--) {
      const child = tree.nodes[current.children[i]]!
      if (offset >= child.start && offset < child.end) {
        current = child
        continue outer
      }
    }
    return current
  }
}

/**
 * The innermost node covering `offset`. Descends from the root, taking the last child that contains
 * the offset — "last" matters because zero-width and adjacent nodes can share a boundary.
 *
 * When nothing narrower than the root contains the caret it is sitting just past a token (end of a
 * word, end of the buffer), so we look one character left, matching `identifierAt`'s caret rule.
 */
export function findNodeAtOffset(tree: AstTree, offset: number): number | null {
  const root = tree.nodes[tree.root]
  if (!root || offset < root.start || offset > root.end) return null

  const found = descend(tree, root, offset)
  // A leaf already is the token under the caret; landing on a branch means the caret sits in
  // trivia or punctuation between its children, so the token it belongs to is the one to the left.
  if (found.children.length === 0 || offset <= found.start) return found.id
  return descend(tree, found, offset - 1).id
}

/** Ancestors of `id`, root first, excluding `id` itself. Used to expand the path to a selection. */
export function pathToRoot(tree: AstTree, id: number): number[] {
  const path: number[] = []
  let node = tree.nodes[id]
  while (node && node.parent >= 0) {
    path.push(node.parent)
    node = tree.nodes[node.parent]!
  }
  return path.reverse()
}
