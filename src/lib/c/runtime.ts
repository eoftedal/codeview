/**
 * The C and C++ grammar — one grammar, both languages.
 *
 * `@vscode/tree-sitter-wasm` ships no `tree-sitter-c.wasm`, and none is needed: tree-sitter-cpp is
 * built as a superset of the C grammar, so a plain `.c` file parses through it with no ERROR nodes.
 * Loading one grammar for both is not a shortcut around a missing asset — it is also what lets a
 * `.h` shared between a `.c` and a `.cpp` sit in one program, which is how headers are actually
 * used. The cost is that C++-only syntax is accepted in a `.c` file; a viewer is not a compiler,
 * and refusing to draw a tree for it would help nobody.
 *
 * The loading itself lives in lib/treeSitterRuntime.ts, shared with every other tree-sitter
 * language, which carries the reasons it has to look the way it does.
 */
import type { Parser } from '@vscode/tree-sitter-wasm'
import grammarUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm?url'
import { loadGrammar } from '../treeSitterRuntime'

let started: Promise<Parser> | null = null

export function loadCParser(): Promise<Parser> {
  return (started ??= loadGrammar('C/C++', grammarUrl))
}
