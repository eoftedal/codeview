/**
 * Loads the Java grammar for the unit suites. Same reasoning as tests/support/python.ts: a real CJS
 * load is the only thing that gives the UMD runtime its `__filename`, and handing `Language.load`
 * the wasm bytes keeps URL resolution out of the test path.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

type Parser = (typeof import('@vscode/tree-sitter-wasm'))['Parser']

let started: Promise<InstanceType<Parser>> | null = null

export function javaParser(): Promise<InstanceType<Parser>> {
  return (started ??= start())
}

async function start(): Promise<InstanceType<Parser>> {
  const { Parser, Language } = require('@vscode/tree-sitter-wasm')
  await Parser.init()
  const wasm = readFileSync(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm'))
  const parser = new Parser()
  parser.setLanguage(await Language.load(new Uint8Array(wasm)))
  return parser
}
