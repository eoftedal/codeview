/**
 * The C and C++ backend — one backend for both, because they share a grammar (see runtime.ts) and
 * because a `.h` open beside a `.c` has to be in the same program for the include to resolve.
 *
 * Asynchronous where the TypeScript one is not: the grammar is a wasm fetch, so `tree()` answers
 * null until `ready()` resolves and `useAnalysis` re-enters. Once loaded, parsing is synchronous
 * and fast enough to run on every keystroke like the TypeScript path.
 *
 * **`trace` is deliberately absent**, and this is the one shipped language where that is a
 * judgement rather than a limitation of effort. The backward walk follows a value through
 * assignments, returns and arguments; in C the interesting flows go through **pointers**, and
 * `char *p = buf; gets(p);` is precisely the path a reviewer opened the file for. A walk with no
 * aliasing is a stated limit in TypeScript, a corner in Java, and a hole where the feature should
 * be in C. The **preprocessor** compounds it: a value passing through a macro dead-ends at a name
 * with no declaration, since nothing here expands one. Shipping a trace that quietly missed those
 * paths would be the one failure this tool refuses, so the pane says the language has none instead.
 */
import type { Parser, Tree } from '@vscode/tree-sitter-wasm'
import type { AstTree, BuildOptions } from '../astTree'
import type { AnalysisBackend, BackendFile } from '../backend'
import type { DefinitionResult } from '../definitions'
import { buildTreeSitterTree } from '../treeSitterTree'
import { resolveCDefinition, type CFile } from './definitions'
import { loadCParser } from './runtime'

interface Entry {
  text: string
  /** Parsed on demand and cached until the text changes. A tree is wasm-allocated, so a superseded
   *  one is deleted rather than dropped — otherwise a typing session leaks one per keystroke. */
  tree: Tree | null
}

export function createCBackend(): AnalysisBackend {
  const files = new Map<string, Entry>()
  let active = ''
  let parser: Parser | null = null

  function release(entry: Entry): void {
    entry.tree?.delete()
    entry.tree = null
  }

  /** The parse for a file, built on first ask. Null before the grammar has loaded. */
  function treeFor(name: string): Tree | null {
    const entry = files.get(name)
    if (!entry || !parser) return null
    if (!entry.tree) entry.tree = parser.parse(entry.text)
    return entry.tree
  }

  /** Every open C and C++ tab, parsed — which is what lets a definition cross an `#include`. */
  function current(): { active: CFile; open: CFile[] } | null {
    const parsed = treeFor(active)
    const entry = files.get(active)
    if (!parsed || !entry) return null

    const open: CFile[] = []
    for (const name of files.keys()) {
      const tree = treeFor(name)
      const file = files.get(name)
      if (tree && file) open.push({ name, root: tree.rootNode, text: file.text })
    }
    const self = open.find((file) => file.name === active)
    return self ? { active: self, open } : null
  }

  return {
    update(next: readonly BackendFile[], activeName: string): boolean {
      let changed = false
      const seen = new Set<string>()

      for (const file of next) {
        seen.add(file.name)
        const entry = files.get(file.name)
        if (!entry) {
          files.set(file.name, { text: file.text, tree: null })
          changed = true
        } else if (entry.text !== file.text) {
          entry.text = file.text
          release(entry)
          changed = true
        }
      }

      for (const [name, entry] of [...files]) {
        if (seen.has(name)) continue
        release(entry)
        files.delete(name)
        changed = true
      }

      active = files.has(activeName) ? activeName : (files.keys().next().value ?? '')
      return changed
    },

    tree(options: BuildOptions): AstTree | null {
      const parsed = treeFor(active)
      return parsed ? buildTreeSitterTree(parsed.rootNode, options) : null
    },

    resolve(offset: number): DefinitionResult | null {
      const program = current()
      return program && resolveCDefinition(program.active, program.open, offset)
    },

    async ready(): Promise<void> {
      parser ??= await loadCParser()
    },
  }
}
