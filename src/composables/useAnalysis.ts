import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { createAnalyzer, type Language } from '../lib/analyzer'
import { buildTree, type AstTree } from '../lib/astTree'
import { resolveDefinition, type DefinitionResult } from '../lib/definitions'
import { traceOrigins, type FlowTrace } from '../lib/flow'

const DEBOUNCE_MS = 150

export interface Analysis {
  tree: Ref<AstTree | null>
  /** Bumps on every completed parse — watch it to re-derive anything keyed on node ids. */
  revision: Ref<number>
  resolve: (offset: number) => DefinitionResult | null
  /** Backward provenance for the value at `offset`. Costs many reference queries — run it on an
   *  explicit request, never on every cursor move. */
  trace: (offset: number) => FlowTrace | null
}

/**
 * Keeps a parsed view of the buffer, debounced so typing stays smooth. The tree is held in a
 * `shallowRef`: it is replaced wholesale on each parse and must never be deeply proxied.
 */
export function useAnalysis(
  text: Ref<string>,
  language: Ref<Language>,
  showTokens: Ref<boolean>,
): Analysis {
  const analyzer = createAnalyzer()
  const tree = shallowRef<AstTree | null>(null)
  const revision = ref(0)
  let timer: ReturnType<typeof setTimeout> | undefined

  const parse = () => {
    analyzer.update(text.value, language.value)
    tree.value = buildTree(analyzer.sourceFile(), { showTokens: showTokens.value })
    revision.value++
  }

  watch(
    [text, language],
    () => {
      clearTimeout(timer)
      timer = setTimeout(parse, DEBOUNCE_MS)
    },
    { immediate: false },
  )

  // A toggle is a direct request, so it redraws at once rather than waiting out the debounce.
  watch(showTokens, parse)

  parse()
  onScopeDispose(() => clearTimeout(timer))

  return {
    tree,
    revision,
    resolve: (offset) =>
      resolveDefinition(analyzer.service(), analyzer.sourceFile(), analyzer.fileName(), offset),
    trace: (offset) =>
      traceOrigins(analyzer.service(), analyzer.sourceFile(), analyzer.fileName(), offset),
  }
}
