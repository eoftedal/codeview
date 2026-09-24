/**
 * The Java grammar. The loading itself lives in lib/treeSitterRuntime.ts, which is shared with
 * every other tree-sitter language and carries the reasons it has to look the way it does.
 */
import type { Parser } from '@vscode/tree-sitter-wasm'
import grammarUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm?url'
import { loadGrammar } from '../treeSitterRuntime'

let started: Promise<Parser> | null = null

export function loadJavaParser(): Promise<Parser> {
  return (started ??= loadGrammar('Java', grammarUrl))
}
