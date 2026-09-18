import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { modelById, type ModelChoice, type ModelEngine, type ModelStatus } from '../lib/chat'
import { providerFor, usableModels } from '../lib/providers'
import { hasGpuAdapter } from '../lib/providers/webgpu'

const MODEL_KEY = 'codeview:chat-model'
const THINKING_KEY = 'codeview:chat-thinking'

/**
 * The loaded model, and the picker that chooses it — one of each for the whole app.
 *
 * This is the half of a conversation that is expensive and long-lived: a download, then weights
 * onto the GPU and shaders compiled. It belongs to the *model*, not to any pane holding a
 * conversation with it, which is why it lives out here where both the chat and the agents can
 * share it. Two composables each loading their own engine would mean the same multi-gigabyte
 * weights sitting on the GPU twice.
 */
export interface ModelHost {
  /** The models this browser can actually run, built-in first. Empty means none can. */
  models: Ref<ModelChoice[]>
  /** The chosen model's id, remembered between visits. */
  model: Ref<string>
  choice: Ref<ModelChoice | null>
  /** Let a reasoning model think first. Only meaningful where `choice.thinking` is set. */
  thinking: Ref<boolean>
  status: Ref<ModelStatus>
  /** Weight download progress, 0–1, while `status` is `downloading`. */
  progress: Ref<number>
  /** Settle what can run here. Idempotent, and deliberately not run on load. */
  probe: () => void
  /** The loaded engine, loading it the first time. */
  engine: () => Promise<ModelEngine>
  /** Say a session was built on it: the status line stops guessing at a download. */
  markAvailable: () => void
  /** Called when the chosen model changes, before the old engine is destroyed, so whoever built a
   *  session on it can drop that session first. */
  onChange: (fn: () => void) => void
  /** Whether this model has a thinking mode *and* the reader asked for it — what rides a
   *  question. */
  thinkingNow: () => boolean
}

export function useModel(): ModelHost {
  const models = ref<ModelChoice[]>(usableModels())

  const remembered = localStorage.getItem(MODEL_KEY)
  // Built-in first in the catalogue, so the default is the one with nothing to download.
  const model = ref(
    (remembered && models.value.some((choice) => choice.id === remembered) ? remembered : null) ??
      models.value[0]?.id ??
      'builtin',
  )

  const choice = computed(() => modelById(model.value))

  // Off by default: thinking is slower and most questions here do not need it. The setting is
  // remembered, and applies from the next question — it is a per-request flag, not a session one,
  // so turning it on mid-conversation costs nothing.
  const thinking = ref(localStorage.getItem(THINKING_KEY) === 'on')
  watch(thinking, (on) => localStorage.setItem(THINKING_KEY, on ? 'on' : 'off'))

  const status = ref<ModelStatus>(models.value.length === 0 ? 'unavailable' : 'checking')
  const progress = ref(0)

  let loaded: ModelEngine | null = null
  let probed = false
  const listeners: (() => void)[] = []

  /** Asking what can run here is a pane's first cost, so it waits for a pane to be opened rather
   *  than running on load for everyone who never uses one.
   *
   *  A GPU adapter is a fact about the browser rather than about any one model — Chrome exposes
   *  `navigator.gpu` on machines that then hand back nothing — so it is settled once, and every
   *  downloadable model is dropped when there is no GPU to run it on. Which is what leaves a pane
   *  with nothing to offer, and the plain message, on a browser that can do neither. */
  function probe(): void {
    if (probed) return
    probed = true
    void (async () => {
      if (!(await hasGpuAdapter())) {
        models.value = models.value.filter((entry) => entry.provider === 'builtin')
        if (models.value.length === 0) {
          status.value = 'unavailable'
          return
        }
        // Selecting a different model re-enters this through the watcher below.
        if (!models.value.some((entry) => entry.id === model.value)) {
          model.value = models.value[0]!.id
          return
        }
      }
      const selected = choice.value
      if (!selected) {
        status.value = 'unavailable'
        return
      }
      try {
        status.value = await providerFor(selected.provider).availability()
      } catch {
        status.value = 'unavailable'
      }
    })()
  }

  async function engine(): Promise<ModelEngine> {
    if (loaded) return loaded
    const selected = choice.value
    if (!selected) throw new Error('No language model is selected.')
    try {
      loaded = await providerFor(selected.provider).load({
        model: selected.model,
        thinking: selected.thinking,
        dtype: selected.dtype,
        onProgress: (fraction) => {
          progress.value = fraction
          if (fraction < 1) status.value = 'downloading'
        },
      })
    } catch (caught) {
      // A model that will not load is worth saying plainly, but the pane keeps its picker so
      // another one can be tried.
      status.value = 'unavailable'
      throw caught
    }
    return loaded
  }

  function markAvailable(): void {
    status.value = 'available'
  }

  function onChange(fn: () => void): void {
    listeners.push(fn)
  }

  function thinkingNow(): boolean {
    return thinking.value && choice.value?.thinking === true
  }

  // A different model is a different engine and a different conversation: weights, context budget
  // and system prompt all change, and carrying the turns across would be a lie about who said them.
  // Consumers are told first, so their sessions are gone before the engine under them is.
  watch(model, (id) => {
    localStorage.setItem(MODEL_KEY, id)
    for (const listener of listeners) listener()
    loaded?.destroy()
    loaded = null
    progress.value = 0
    probed = false
    status.value = 'checking'
    probe()
  })

  onScopeDispose(() => {
    loaded?.destroy()
    loaded = null
  })

  return {
    models,
    model,
    choice,
    thinking,
    status,
    progress,
    probe,
    engine,
    markAvailable,
    onChange,
    thinkingNow,
  }
}
