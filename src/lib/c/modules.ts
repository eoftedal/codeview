/**
 * Which open tab a C name lives in.
 *
 * Two routes, and they are C's own two. An `#include "util.h"` names a file, so the tab called
 * `util.h` — or any tab whose path ends in it — is searched; inclusion is textual, so everything
 * that header declares is genuinely in scope here. An angle-bracket include never resolves, which
 * is the right answer: `<stdio.h>` is not a tab, and `printf` reading as external is exactly what
 * the walk should conclude.
 *
 * The second route is the linker's. C has no namespaces, so a non-`static` function or variable
 * declared at file scope in any translation unit is one name in one global space — which makes
 * "any open tab's file scope" an approximation of what the linker does rather than a guess. It is
 * what lets a `main.c` calling a function defined in `util.c` resolve with no header between them.
 * `static` is what that over-approximates: a file-local name of the same spelling in two tabs will
 * answer with the first found, and the README says so.
 */
import type { Node } from '@vscode/tree-sitter-wasm'

/** The path an `#include` names, or null for a system header we will never hold. */
export function includedPath(directive: Node): string | null {
  const path = directive.childForFieldName('path')
  if (!path) return null
  // `<stdio.h>` is a `system_lib_string` and is deliberately not resolved.
  if (path.type !== 'string_literal') return null
  return path.text.replace(/^"|"$/g, '')
}

/**
 * The tab an include points at. A quoted include is relative to the including file, but tab names
 * are already paths, so the suffix match is what handles `#include "lib/util.h"` and a tab called
 * `src/lib/util.h` alike.
 */
export function moduleFor(directive: Node, open: readonly string[]): string | null {
  const path = includedPath(directive)
  if (!path) return null
  const wanted = path.replace(/^\.\//, '')
  return (
    open.find((name) => name === wanted) ??
    open.find((name) => name.endsWith(`/${wanted}`)) ??
    open.find((name) => wanted.endsWith(`/${name}`)) ??
    null
  )
}

/** Every `#include` in a file, in source order. */
export function includesOf(root: Node): Node[] {
  const found: Node[] = []
  const visit = (node: Node) => {
    if (node.type === 'preproc_include') {
      found.push(node)
      return
    }
    for (const child of node.namedChildren) if (child) visit(child)
  }
  visit(root)
  return found
}
