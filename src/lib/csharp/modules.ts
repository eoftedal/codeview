/**
 * Which open tab a C# name lives in.
 *
 * Shorter than its Java counterpart, and the reason is worth stating: **C# has no per-type import**.
 * `using Shop.Data;` brings in a whole namespace, so nothing in a file says which tab a type came
 * from — where Java's `import com.example.Db;` names `Db` exactly. The only `using` that names one
 * type is an alias.
 *
 * So the rule that does the work is the same one Java falls back on for a same-package type: a
 * name that resolves nowhere locally is looked for as a top-level declaration in any open tab.
 * That is C#'s namespace rule approximated as "any open tab", and it is why the feature is usable
 * on two pasted files at all. Nothing beyond the open tabs is searched, so `string`, `Task` and
 * anything from `System.*` resolve to nothing and read as external.
 */
import type { Node } from '@vscode/tree-sitter-wasm'

/** The right-hand side of a `using X = Some.Qualified.Name;` alias, or null for a plain using. */
export function aliasTarget(directive: Node): string | null {
  if (!directive.text.includes('=')) return null
  const named = directive.namedChildren.filter((child): child is Node => child !== null)
  const last = named[named.length - 1]
  return last ? last.text : null
}

/** The simple name an alias points at — the last dotted segment. */
export function aliasedName(directive: Node): string | null {
  const target = aliasTarget(directive)
  if (!target) return null
  const parts = target.split('.').filter(Boolean)
  return parts[parts.length - 1] ?? null
}

/** The tab names an aliased type could be, most specific first. A C# project keeps `Db` in `Db.cs`
 *  far more often than not, and a namespace usually mirrors the directory. */
export function aliasCandidates(dotted: string): string[] {
  const parts = dotted.split('.').filter(Boolean)
  if (parts.length === 0) return []
  const last = parts[parts.length - 1]!
  return [`${parts.join('/')}.cs`, `${last}.cs`]
}

/** The tab an alias points at, among the open ones. */
export function moduleFor(directive: Node, open: readonly string[]): string | null {
  const target = aliasTarget(directive)
  if (!target) return null
  const names = new Set(open)
  return aliasCandidates(target).find((candidate) => names.has(candidate)) ?? null
}
