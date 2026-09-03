import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { createAnalyzer } from '../lib/analyzer'
import { buildTree, type AstTree } from '../lib/astTree'
import { resolveDefinition, type DefinitionResult } from '../lib/definitions'
import type { CodeFile } from '../lib/files'
import { traceOrigins, type FlowTrace } from '../lib/flow'

const DEBOUNCE_MS = 150

export interface Analysis {
  tree: Ref<AstTree | null>
  /** Bumps on every completed parse — watch it to re-derive anything keyed on node ids. */
  revision: Ref<number>
  /**
   * Bumps only when a file's *text* changed. Switching tabs reparses without moving a character,
   * and a trace's spans are still good — they are offsets into files, not into the active one.
   */
  contentRevision: Ref<number>
  resolve: (offset: number) => DefinitionResult | null
  /** Backward provenance for the value at `offset`. Costs many reference queries — run it on an
   *  explicit request, never on every cursor move. */
  trace: (offset: number) => FlowTrace | null
}

/**
 * Keeps a parsed view of the open files, debounced so typing stays smooth. Every file is in the
 * program — that is what lets a definition and a trace cross an import — but the tree is only ever
 * built for the one on screen. The tree is held in a `shallowRef`: it is replaced wholesale on
 * each parse and must never be deeply proxied.
 */
export function useAnalysis(
  files: Ref<CodeFile[]>,
  activeName: Ref<string>,
  showTokens: Ref<boolean>,
): Analysis {
  const analyzer = createAnalyzer()
  const tree = shallowRef<AstTree | null>(null)
  const revision = ref(0)
  const contentRevision = ref(0)
  let timer: ReturnType<typeof setTimeout> | undefined

  const parse = () => {
    const changed = analyzer.update(
      files.value.map((file) => ({
        name: file.name,
        text: file.text,
        language: file.language,
      })),
      activeName.value,
    )
    tree.value = buildTree(analyzer.sourceFile(), { showTokens: showTokens.value })
    revision.value++
    if (changed) contentRevision.value++
  }

  watch(
    [files, activeName],
    () => {
      clearTimeout(timer)
      timer = setTimeout(parse, DEBOUNCE_MS)
    },
    { immediate: false, deep: true },
  )

  // A toggle is a direct request, so it redraws at once rather than waiting out the debounce.
  watch(showTokens, parse)

  parse()
  onScopeDispose(() => clearTimeout(timer))

  return {
    tree,
    revision,
    contentRevision,
    resolve: (offset) =>
      resolveDefinition(analyzer.service(), analyzer.sourceFile(), analyzer.fileName(), offset),
    trace: (offset) =>
      traceOrigins(analyzer.service(), analyzer.sourceFile(), analyzer.fileName(), offset),
  }
}
