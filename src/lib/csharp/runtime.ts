/**
 * The C# grammar. The loading itself lives in lib/treeSitterRuntime.ts, which is shared with every
 * other tree-sitter language and carries the reasons it has to look the way it does.
 *
 * This is the largest grammar in the package at ~5 MB, which is why it matters that it is fetched
 * lazily: a reader who never opens a `.cs` file never pays for it, and the main bundle is unchanged.
 */
import type { Parser } from '@vscode/tree-sitter-wasm'
import grammarUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm?url'
import { loadGrammar } from '../treeSitterRuntime'

let started: Promise<Parser> | null = null

export function loadCSharpParser(): Promise<Parser> {
  return (started ??= loadGrammar('C#', grammarUrl))
}
