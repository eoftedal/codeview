/**
 * The Python grammar. The loading itself lives in lib/treeSitterRuntime.ts, which is shared with
 * every other tree-sitter language and carries the reasons it has to look the way it does.
 */
import type { Parser } from '@vscode/tree-sitter-wasm'
import grammarUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url'
import { loadGrammar } from '../treeSitterRuntime'

let started: Promise<Parser> | null = null

/** The parser, loaded once. Repeat calls share the first attempt — including a failed one, since a
 *  missing asset does not become present by asking again. */
export function loadPythonParser(): Promise<Parser> {
  return (started ??= loadGrammar('Python', grammarUrl))
}
