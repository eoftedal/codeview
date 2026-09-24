/**
 * Which open tab a Java name lives in.
 *
 * Two routes, and the second is the one that matters in practice. An `import com.example.Db;` names
 * a path, so `com/example/Db.java` is tried — and so is a bare `Db.java`, since a reader pasting two
 * files into tabs rarely recreates the package directories. But most two-file Java examples have no
 * import at all: a type in the **same package** needs none. So an unresolved type name also looks
 * for a tab declaring a top-level type of that name, which is that rule approximated as "any open
 * tab". Nothing is searched beyond the open tabs, so `String` and `java.util.List` resolve to
 * nothing and read as external.
 */
import type { Node } from '@vscode/tree-sitter-wasm'

/** The tab names an imported type could be, most specific first. */
export function importCandidates(dotted: string): string[] {
  const parts = dotted.split('.').filter(Boolean)
  if (parts.length === 0) return []
  const last = parts[parts.length - 1]!
  return [`${parts.join('/')}.java`, `${last}.java`]
}

/** The dotted name an `import_declaration` names. */
export function importedPath(statement: Node): string | null {
  const scoped = statement.namedChildren.find(
    (child) => child?.type === 'scoped_identifier' || child?.type === 'identifier',
  )
  return scoped ? scoped.text : null
}

/** The simple name an import brings in — the last segment. */
export function importedName(statement: Node): string | null {
  const path = importedPath(statement)
  if (!path) return null
  const parts = path.split('.').filter(Boolean)
  return parts[parts.length - 1] ?? null
}

/** The tab an import points at, among the open ones. */
export function moduleFor(statement: Node, open: readonly string[]): string | null {
  const path = importedPath(statement)
  if (!path) return null
  const names = new Set(open)
  return importCandidates(path).find((candidate) => names.has(candidate)) ?? null
}
