/**
 * Loads the Python grammar for the unit suites.
 *
 * `createRequire`, not `import`: `@vscode/tree-sitter-wasm`'s runtime is a UMD bundle whose
 * `getCurrentScriptUrl()` runs at module-evaluation time and throws unless `__filename` or
 * `document` exists — only a real CJS load gives it the first. And `Language.load` is handed the
 * wasm *bytes* rather than a path, which keeps URL resolution (the browser's problem, see
 * lib/python/runtime.ts) out of the test path entirely.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

let started: Promise<InstanceType<Parser>> | null = null

type Parser = (typeof import('@vscode/tree-sitter-wasm'))['Parser']

export function pythonParser(): Promise<InstanceType<Parser>> {
  return (started ??= start())
}

async function start(): Promise<InstanceType<Parser>> {
  const { Parser, Language } = require('@vscode/tree-sitter-wasm')
  await Parser.init()
  const wasm = readFileSync(
    require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm'),
  )
  const parser = new Parser()
  parser.setLanguage(await Language.load(new Uint8Array(wasm)))
  return parser
}
