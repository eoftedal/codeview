/**
 * The TypeScript and JavaScript backend: today's `ts.LanguageService` analyzer behind the shared
 * contract. It adds no behaviour of its own — every answer still comes from lib/analyzer.ts,
 * lib/astTree.ts, lib/definitions.ts and lib/flow.ts, unchanged and still unit-tested through
 * their own entry points rather than through this adapter.
 */
import { createAnalyzer, type Language } from './analyzer'
import { buildTree, type AstTree, type BuildOptions } from './astTree'
import type { AnalysisBackend, BackendFile } from './backend'
import { resolveDefinition, type DefinitionResult } from './definitions'
import { traceOrigins, type FlowTrace } from './flow'

/** The languages this backend answers for. Every one of them is in the same `ts.Program`, which is
 *  what lets a definition and a trace cross from one tab into another. */
export const TS_LANGUAGES: readonly Language[] = ['ts', 'tsx', 'js', 'jsx']

export function createTsBackend(languageOf: (name: string) => Language): AnalysisBackend {
  const analyzer = createAnalyzer()

  return {
    update: (files: readonly BackendFile[], activeName: string): boolean =>
      analyzer.update(
        files.map((file) => ({ ...file, language: languageOf(file.name) })),
        activeName,
      ),
    tree: (options: BuildOptions): AstTree => buildTree(analyzer.sourceFile(), options),
    resolve: (offset: number): DefinitionResult | null =>
      resolveDefinition(analyzer.service(), analyzer.sourceFile(), analyzer.fileName(), offset),
    trace: (offset: number): FlowTrace | null =>
      traceOrigins(analyzer.service(), analyzer.sourceFile(), analyzer.fileName(), offset),
  }
}
