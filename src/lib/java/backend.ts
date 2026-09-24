/**
 * The Java backend.
 *
 * Asynchronous where the TypeScript one is not: the grammar is a wasm fetch, so `tree()` answers
 * null until `ready()` resolves and `useAnalysis` re-enters. Once loaded, parsing is synchronous
 * and fast enough to run on every keystroke like the TypeScript path.
 *
 * `trace` is deliberately absent rather than null-returning. The backward trace rides the
 * TypeScript language service's reference index, and there is no equivalent here; a pane needs to
 * tell "this language has no trace" apart from "nothing resolved at this offset" so it can say so.
 */
import type { Parser, Tree } from '@vscode/tree-sitter-wasm'
import type { AstTree, BuildOptions } from '../astTree'
import type { AnalysisBackend, BackendFile } from '../backend'
import type { DefinitionResult } from '../definitions'
import type { FlowTrace } from '../flow'
import { buildTreeSitterTree } from '../treeSitterTree'
import { resolveJavaDefinition, type JavaFile } from './definitions'
import { traceJavaOrigins } from './flow'
import { loadJavaParser } from './runtime'

interface Entry {
  text: string
  /** Parsed on demand and cached until the text changes. A tree is wasm-allocated, so a superseded
   *  one is deleted rather than dropped — otherwise a typing session leaks one per keystroke. */
  tree: Tree | null
}

export function createJavaBackend(): AnalysisBackend {
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

  /**
   * Every open Java tab, parsed — which is what lets a definition and a trace cross an import.
   * Null before the grammar has loaded.
   */
  function current(): { active: JavaFile; open: JavaFile[] } | null {
    const parsed = treeFor(active)
    const entry = files.get(active)
    if (!parsed || !entry) return null

    const open: JavaFile[] = []
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
      return program && resolveJavaDefinition(program.active, program.open, offset)
    },

    trace(offset: number): FlowTrace | null {
      const program = current()
      return program && traceJavaOrigins(program.active, program.open, offset)
    },

    async ready(): Promise<void> {
      parser ??= await loadJavaParser()
    },
  }
}
