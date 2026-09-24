/**
 * Which open tab an import names.
 *
 * A tab's name is its module path — the same rule the TypeScript side relies on, where `./db`
 * finds the tab called `db.ts`. Here `import db` finds `db.py`, and `from pkg.mod import x` finds
 * `pkg/mod.py` or `pkg/mod/__init__.py`. Nothing is searched beyond the open tabs: an import of
 * `flask` or `os` resolves to nothing, which is the honest answer and the same terminal condition
 * `noLib` gives the TypeScript analyzer.
 *
 * Pure — names in, a name out, no parsing and no I/O.
 */
import type { Node } from '@vscode/tree-sitter-wasm'

/** The tab names a dotted module path could be, most specific first. */
export function moduleCandidates(dotted: string): string[] {
  const path = dotted.split('.').filter(Boolean).join('/')
  if (!path) return []
  return [`${path}.py`, `${path}/__init__.py`, `${path}.pyi`]
}

/** The directory a file sits in, '' at the top level. */
function directoryOf(name: string): string {
  const slash = name.lastIndexOf('/')
  return slash < 0 ? '' : name.slice(0, slash)
}

/** One directory up, or null when there is nowhere further to go. */
function parentOf(directory: string): string | null {
  if (directory === '') return null
  const slash = directory.lastIndexOf('/')
  return slash < 0 ? '' : directory.slice(0, slash)
}

/**
 * The base a relative import counts from. One dot is this file's own package, two is its parent,
 * and so on; null when the dots walk off the top.
 */
function baseFor(fromFile: string, dots: number): string | null {
  let directory: string | null = directoryOf(fromFile)
  for (let i = 1; i < dots; i++) {
    if (directory === null) return null
    directory = parentOf(directory)
  }
  return directory
}

function join(base: string, path: string): string {
  return base ? `${base}/${path}` : path
}

/**
 * The tab an `import_statement` or `import_from_statement`'s module refers to, or null when no open
 * tab answers to it.
 */
export function moduleFor(
  statement: Node,
  fromFile: string,
  open: readonly string[],
): string | null {
  const names = new Set(open)
  const pick = (candidates: readonly string[]): string | null =>
    candidates.find((candidate) => names.has(candidate)) ?? null

  const relative = statement.namedChildren.find((child) => child?.type === 'relative_import')
  if (relative) {
    const prefix = relative.namedChildren.find((child) => child?.type === 'import_prefix')
    const dots = prefix ? prefix.text.length : 1
    const base = baseFor(fromFile, dots)
    if (base === null) return null
    const tail = relative.namedChildren.find((child) => child?.type === 'dotted_name')
    if (!tail) return pick([join(base, '__init__.py')])
    return pick(moduleCandidates(tail.text).map((candidate) => join(base, candidate)))
  }

  const module = statement.childForFieldName('module_name') ?? statement.childForFieldName('name')
  if (!module) return null
  // `import pkg.mod as m` puts the dotted name under the alias.
  const dotted = module.type === 'aliased_import' ? module.childForFieldName('name') : module
  return dotted ? pick(moduleCandidates(dotted.text)) : null
}

/**
 * For `from . import s` — the name may be a *submodule* rather than something the package's
 * `__init__` declares, so `s` can itself be a tab.
 */
export function submoduleFor(
  statement: Node,
  imported: string,
  fromFile: string,
  open: readonly string[],
): string | null {
  const relative = statement.namedChildren.find((child) => child?.type === 'relative_import')
  if (!relative) return null
  const prefix = relative.namedChildren.find((child) => child?.type === 'import_prefix')
  const base = baseFor(fromFile, prefix ? prefix.text.length : 1)
  if (base === null) return null
  const tail = relative.namedChildren.find((child) => child?.type === 'dotted_name')
  const directory = tail ? join(base, tail.text.split('.').join('/')) : base
  const names = new Set(open)
  return (
    moduleCandidates(imported)
      .map((candidate) => join(directory, candidate))
      .find((candidate) => names.has(candidate)) ?? null
  )
}

/** The name an `import … from` statement actually brought in, for a given local binding. */
export function importedName(statement: Node, local: string): string {
  for (const child of statement.namedChildren) {
    if (child?.type === 'aliased_import' && child.childForFieldName('alias')?.text === local) {
      const name = child.childForFieldName('name')
      return name ? (name.namedChildren.at(-1)?.text ?? name.text) : local
    }
  }
  return local
}
