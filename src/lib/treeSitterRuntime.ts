/**
 * Loading a tree-sitter grammar in the browser.
 *
 * Three facts about `@vscode/tree-sitter-wasm` decide the shape of this file, and all three were
 * checked against the shipped artifact rather than assumed:
 *
 * 1. `wasm/tree-sitter.js` is a **UMD bundle**, not an ES module, and its `getCurrentScriptUrl()`
 *    runs at module-evaluation time (`var _scriptName = getCurrentScriptUrl()`, line 2086). It
 *    throws unless `__filename` or `document` exists — so this can only load on the **main thread**.
 *    A module worker is worse still: the bundle detects a worker with `typeof importScripts`, which
 *    a module worker does not have, so it falls through to its shell branch and never installs
 *    `readAsync`. Parsing is microseconds per keystroke, so there is nothing to gain by moving it.
 * 2. Evaluated as an ES module it takes the UMD's last branch and assigns `globalThis.Parser` — the
 *    whole namespace, so the class is `globalThis.Parser.Parser`. There is no export to import.
 * 3. On the main thread `document.currentScript` is null for a module, so `_scriptName` is
 *    undefined and emscripten's `scriptDirectory` stays empty. Harmless *because* `locateFile` is
 *    supplied below: `findWasmBinary` then takes the `Module["locateFile"]` branch rather than
 *    resolving against a script URL it does not have.
 *
 * The URLs are `?url` imports so Vite emits them as hashed assets and resolves them against the
 * emitting chunk — which is what makes `base: './'` work on GitHub Pages. Importing the glue
 * normally would instead have Rollup treat it as CJS, hoist its `require('fs')`/`require('url')`
 * onto Vite's node stubbing, and inline 169 kB into the main chunk.
 *
 * A grammar's own URL is passed in rather than imported here: Vite needs a static specifier per
 * asset, so each language module imports its own and hands it over.
 */
import type { Language as TSLanguage, Parser as TSParser } from '@vscode/tree-sitter-wasm'
import runtimeUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter.js?url'
import coreWasmUrl from '@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm?url'

interface Namespace {
  Parser: typeof TSParser
  Language: typeof TSLanguage
}

/** The runtime is shared by every grammar, so it is started once however many languages load. */
let runtime: Promise<Namespace> | null = null

/**
 * Names which asset failed. A 404 on a lazily-fetched wasm otherwise shows up only as a pane that
 * never fills, which is the least diagnosable failure this file can produce.
 */
async function fetching<T>(what: string, url: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(`could not load the ${what} (${url}): ${(error as Error).message}`)
  }
}

async function startRuntime(): Promise<Namespace> {
  await fetching('tree-sitter runtime', runtimeUrl, () => import(/* @vite-ignore */ runtimeUrl))
  const namespace = (globalThis as unknown as { Parser?: Namespace }).Parser
  if (!namespace?.Parser)
    throw new Error(`the tree-sitter runtime (${runtimeUrl}) defined no parser`)

  await fetching('tree-sitter runtime wasm', coreWasmUrl, () =>
    namespace.Parser.init({ locateFile: () => coreWasmUrl }),
  )
  return namespace
}

/** A parser for one grammar, given the URL of its `.wasm`. */
export async function loadGrammar(name: string, grammarUrl: string): Promise<TSParser> {
  const namespace = await (runtime ??= startRuntime())
  const language = await fetching(`${name} grammar`, grammarUrl, () =>
    namespace.Language.load(grammarUrl),
  )
  const parser = new namespace.Parser()
  parser.setLanguage(language)
  return parser
}
