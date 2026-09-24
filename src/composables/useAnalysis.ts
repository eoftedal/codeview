import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import type { Language } from '../lib/analyzer'
import type { AstTree } from '../lib/astTree'
import type { AnalysisBackend, BackendFile } from '../lib/backend'
import type { DefinitionResult } from '../lib/definitions'
import type { CodeFile } from '../lib/files'
import type { FlowTrace } from '../lib/flow'
import { createJavaBackend } from '../lib/java/backend'
import { createPythonBackend } from '../lib/python/backend'
import { createTsBackend } from '../lib/tsBackend'

const DEBOUNCE_MS = 150

/** How far a backend is from being able to answer. Only a backend with an asynchronous grammar is
 *  ever anything but `ready`. */
export type AnalysisStatus = 'ready' | 'loading' | 'failed'

export interface Analysis {
  tree: Ref<AstTree | null>
  /** Bumps on every completed parse — watch it to re-derive anything keyed on node ids. */
  revision: Ref<number>
  /**
   * Bumps only when a file's *text* changed. Switching tabs reparses without moving a character,
   * and a trace's spans are still good — they are offsets into files, not into the active one.
   */
  contentRevision: Ref<number>
  /** `loading` while a language's grammar is still being fetched; `failed` when it could not be. */
  status: Ref<AnalysisStatus>
  /** Why the backend failed, worded for the pane. Null unless `status` is `failed`. */
  failure: Ref<string | null>
  /** False on a buffer whose language has no backward trace, so a pane can say so rather than
   *  looking broken. Distinct from `trace()` returning null, which means nothing resolved here. */
  traceSupported: Ref<boolean>
  resolve: (offset: number) => DefinitionResult | null
  /** Backward provenance for the value at `offset`. Costs many reference queries — run it on an
   *  explicit request, never on every cursor move. */
  trace: (offset: number) => FlowTrace | null
}

/** Which backend answers for a language. The TypeScript family shares one `ts.Program`. */
type Family = 'ts' | 'py' | 'java'

function familyOf(language: Language): Family {
  if (language === 'py') return 'py'
  if (language === 'java') return 'java'
  return 'ts'
}

/**
 * Keeps a parsed view of the open files, debounced so typing stays smooth.
 *
 * Every file of a language is handed to that language's backend — which is what lets a definition
 * and a trace cross an import — but the tree is only ever built for the one on screen, by the
 * backend that owns it. Files of different languages go to different backends and never meet: see
 * lib/backend.ts on why cross-language resolution does not exist.
 *
 * The tree is held in a `shallowRef`: it is replaced wholesale on each parse and must never be
 * deeply proxied.
 */
export function useAnalysis(
  files: Ref<CodeFile[]>,
  activeName: Ref<string>,
  showTokens: Ref<boolean>,
): Analysis {
  const tree = shallowRef<AstTree | null>(null)
  const revision = ref(0)
  const contentRevision = ref(0)
  const status = ref<AnalysisStatus>('ready')
  const failure = ref<string | null>(null)
  const activeFamily = ref<Family>('ts')
  let timer: ReturnType<typeof setTimeout> | undefined

  const languages = new Map<string, Language>()
  const backends = new Map<Family, AnalysisBackend>()

  /** Built on first sight of a file in the family, so a language nobody opened costs nothing. */
  function backendFor(family: Family): AnalysisBackend {
    const existing = backends.get(family)
    if (existing) return existing
    const created =
      family === 'py'
        ? createPythonBackend()
        : family === 'java'
          ? createJavaBackend()
          : createTsBackend((name) => languages.get(name) ?? 'ts')
    backends.set(family, created)
    return created
  }

  /**
   * A parse that has been superseded must not publish: `tree` is what the selection is re-derived
   * from, so a grammar resolving after the reader has moved on would hand the pane a tree for a tab
   * that is no longer there.
   */
  let parseSeq = 0
  /** Whether a *text* change is still waiting to be reported. Held across an asynchronous load,
   *  since by the time the grammar arrives the backend no longer considers anything changed. */
  let pendingChange = false

  function updateAll(): boolean {
    languages.clear()
    const grouped = new Map<Family, BackendFile[]>()
    for (const file of files.value) {
      languages.set(file.name, file.language)
      const family = familyOf(file.language)
      const group = grouped.get(family)
      if (group) group.push({ name: file.name, text: file.text })
      else grouped.set(family, [{ name: file.name, text: file.text }])
    }

    let changed = false
    for (const [family, group] of grouped) {
      // Every backend holding files is updated, not just the active one: a tab off screen is still
      // part of its language's program, which is what a cross-file definition walks along.
      if (backendFor(family).update(group, activeName.value)) changed = true
    }

    const active = files.value.find((file) => file.name === activeName.value) ?? files.value[0]
    activeFamily.value = active ? familyOf(active.language) : 'ts'
    return changed
  }

  const parse = (): void => {
    const seq = ++parseSeq
    pendingChange = updateAll() || pendingChange
    const backend = backendFor(activeFamily.value)

    const built = backend.tree({ showTokens: showTokens.value })
    if (built) {
      tree.value = built
      status.value = 'ready'
      failure.value = null
      revision.value++
      if (pendingChange) contentRevision.value++
      pendingChange = false
      return
    }

    // Only a backend with an asynchronous grammar can answer with no tree, and only until it loads.
    status.value = 'loading'
    failure.value = null
    tree.value = null
    void backend.ready?.().then(
      () => {
        if (seq === parseSeq) parse()
      },
      (error: unknown) => {
        if (seq !== parseSeq) return
        status.value = 'failed'
        failure.value = error instanceof Error ? error.message : String(error)
      },
    )
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
    status,
    failure,
    traceSupported: computed(() => backendFor(activeFamily.value).trace !== undefined),
    resolve: (offset) => backendFor(activeFamily.value).resolve(offset),
    trace: (offset) => backendFor(activeFamily.value).trace?.(offset) ?? null,
  }
}
