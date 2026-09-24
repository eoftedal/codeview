/**
 * The same flat `AstTree` lib/astTree.ts builds from a `ts.SourceFile`, built from a tree-sitter
 * parse instead. Language-agnostic: every grammar in the package produces the same node shape, so
 * a second language reuses this file whole.
 *
 * Three things are simpler here than on the TypeScript side, and one is harder:
 *
 * - There is no `kindName()` equivalent and none is needed. That function exists only because
 *   `ts.SyntaxKind`'s reverse lookup aliases range markers onto real kinds (`VariableStatement`
 *   comes back as `FirstStatement`). Tree-sitter node types are already unaliased strings.
 * - `showTokens` maps straight onto `isNamed`. Anonymous tree-sitter nodes are always leaves, so
 *   the named tree *is* the structural tree — there are no synthetic `SyntaxList` nodes to skip.
 * - Comments are ordinary named nodes rather than trivia attached to what follows them, so they
 *   get rows of their own. A difference from the TypeScript pane, not a defect.
 * - Offsets are the harder one: `startIndex` must be UTF-16 code units for a `Span` to mean the
 *   same thing to Monaco and to `String.slice`. It is — checked against a buffer holding an accent
 *   and a non-BMP emoji, and pinned by a test, because the failure would otherwise be silent and
 *   only in files nobody writes fixtures for.
 */
import type { Node } from '@vscode/tree-sitter-wasm'
import type { AstNode, AstTree, BuildOptions } from './astTree'

const LABEL_LIMIT = 40

/**
 * What a node is called in the pane. A missing node is announced rather than quietly shown as an
 * ordinary one: the parser inserted it to recover, and that is worth seeing.
 */
function kindOf(node: Node): string {
  return node.isMissing ? `MISSING ${node.type}` : node.type
}

/**
 * Text worth showing next to the kind. Leaves carry their own; branches don't — the guard also
 * keeps `node.text` on the root from copying the whole buffer.
 */
function labelFor(node: Node): string | undefined {
  if (node.childCount > 0) return undefined
  const text = node.text
  if (!text) return undefined
  return text.length > LABEL_LIMIT ? text.slice(0, LABEL_LIMIT) + '…' : text
}

export function buildTreeSitterTree(root: Node, options: BuildOptions = {}): AstTree {
  const nodes: AstNode[] = []

  const visit = (node: Node, parent: number, depth: number): number => {
    const id = nodes.length
    const entry: AstNode = {
      id,
      kind: kindOf(node),
      start: node.startIndex,
      end: node.endIndex,
      label: labelFor(node),
      parent,
      children: [],
      depth,
    }
    nodes.push(entry)

    // With tokens on, punctuation and keywords come through as anonymous nodes whose `type` is
    // their own text — `(`, `:`, `def`. That is what every tree-sitter viewer shows, and it keeps
    // the pane's filter usable on punctuation.
    for (const child of options.showTokens ? node.children : node.namedChildren) {
      if (child) entry.children.push(visit(child, id, depth + 1))
    }
    return id
  }

  const root_ = visit(root, -1, 0)
  return { nodes, root: root_ }
}
