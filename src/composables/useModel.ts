import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { ModelChoice, ModelEngine, ModelStatus } from '../lib/chat'
import { findModel, providerFor, usableModels } from '../lib/providers'
import { getOpenRouterKey } from '../lib/providers/openrouterKey'
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
 *
 * One picked model, then, and everything runs on it — except an agent the reader has put on a
 * model of its own. Those are the *extras*: loaded here too, so that no other composable ever
 * holds weights, and kept between runs for the same reason the picked one is kept between
 * conversations — reloading gigabytes onto the GPU for the next run would be as absurd as doing it
 * for the next chat. What bounds them is `retain`: the team names the models it uses, and an
 * extra nobody names any more is unloaded. A reader who assigns a second model has chosen to hold
 * two; the host's job is to make sure it is never three by accident.
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
  /** Rebuild `models` after the reader adds or removes a custom OpenRouter model — the GPU/builtin
   *  side of the catalogue is untouched, since nothing about the browser changed. */
  refreshModels: () => void
  /** The loaded engine, loading it the first time. */
  engine: () => Promise<ModelEngine>
  /**
   * The engine for a given model: the picked one when it is the picked model, otherwise an extra,
   * loaded the first time and kept. Throws, naming the model, for one this browser cannot run —
   * a team from a link may name a model this machine has no GPU for, and running the agent on
   * something else instead would quietly hand the reader a different review than they asked for.
   */
  engineFor: (id: string) => Promise<ModelEngine>
  /** The model ids worth keeping loaded beside the picked one. Any extra not among them is
   *  unloaded; none of them is loaded by this — that waits for `engineFor`. */
  retain: (ids: readonly string[]) => void
  /** Say a session was built on it: the status line stops guessing at a download. */
  markAvailable: () => void
  /** Called when the chosen model changes, before the old engine is destroyed, so whoever built a
   *  session on it can drop that session first. */
  onChange: (fn: () => void) => void
  /** Whether a model has a thinking mode *and* the reader asked for it — what rides a question.
   *  The picked model unless another is named. */
  thinkingNow: (id?: string) => boolean
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

  const choice = computed(() => findModel(model.value))

  // Off by default: thinking is slower and most questions here do not need it. The setting is
  // remembered, and applies from the next question — it is a per-request flag, not a session one,
  // so turning it on mid-conversation costs nothing.
  const thinking = ref(localStorage.getItem(THINKING_KEY) === 'on')
  watch(thinking, (on) => localStorage.setItem(THINKING_KEY, on ? 'on' : 'off'))

  const status = ref<ModelStatus>(models.value.length === 0 ? 'unavailable' : 'checking')
  const progress = ref(0)

  let loaded: ModelEngine | null = null
  /** Engines for the models agents were put on, by id. Never holds the picked model: that is
   *  `loaded`, and an id is one or the other. */
  const extras = new Map<string, ModelEngine>()
  /** What `retain` last asked for, so a picked model on its way out can be kept as an extra when
   *  an agent still runs on it rather than unloaded and loaded again. */
  let wanted = new Set<string>()
  let probed = false
  const listeners: (() => void)[] = []
  /** Settled once, the first time `probe` runs — `null` beforehand, when `usableModels()`'s own
   *  optimistic list (every provider that merely *might* work) is still what `models` holds. Kept
   *  so `refreshModels` can reapply the same verdict later without probing the GPU a second time. */
  let gpuAvailable: boolean | null = null

  /** Reapplies whatever `probe` last found — or, before it has run once, `usableModels()`'s own
   *  optimistic list — to a freshly rebuilt catalogue. The one place both `probe` and a change to
   *  the reader's own added models go through, so the two can never compute this differently. */
  function recomputeModels(): void {
    const all = usableModels()
    models.value =
      gpuAvailable === false
        ? all.filter((entry) => entry.provider === 'builtin' || entry.provider === 'openrouter')
        : all
  }

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
      gpuAvailable = await hasGpuAdapter()
      if (!gpuAvailable) {
        // OpenRouter needs no GPU either, so losing the adapter should not hide it alongside the
        // on-device models that do.
        recomputeModels()
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
      // An engine already up — an agent's extra just promoted to the picked model — is available
      // whatever the provider would say about downloading it.
      if (loaded) {
        status.value = 'available'
        return
      }
      try {
        status.value = await providerFor(selected.provider).availability()
      } catch {
        status.value = 'unavailable'
      }
    })()
  }

  /** Weights onto the GPU, with the download — whichever model's — shown on the one status line.
   *
   *  OpenRouter is refused here rather than let through to fail inside a `fetch`: a stop-and-say
   *  loudly about a missing key is the point, not a generic "cannot run in this browser" (this
   *  model *can* run here; the browser is not what is missing) or a raw HTTP error from the
   *  provider itself. Both `engine()` (the chat pane) and `engineFor()` (an agent's own model) go
   *  through this one place, so the complaint reaches either caller the same way. */
  async function load(selected: ModelChoice): Promise<ModelEngine> {
    if (selected.provider === 'openrouter' && getOpenRouterKey() === null) {
      throw new Error(
        `${selected.label} needs an OpenRouter API key — add one in the chat settings.`,
      )
    }
    return providerFor(selected.provider).load({
      model: selected.model,
      thinking: selected.thinking,
      dtype: selected.dtype,
      sampling: selected.sampling,
      thinkingSampling: selected.thinkingSampling,
      contextTokens: selected.contextTokens,
      onProgress: (fraction) => {
        progress.value = fraction
        if (fraction < 1) status.value = 'downloading'
      },
    })
  }

  async function engine(): Promise<ModelEngine> {
    if (loaded) return loaded
    const selected = choice.value
    if (!selected) throw new Error('No language model is selected.')
    try {
      loaded = await load(selected)
    } catch (caught) {
      // A model that will not load is worth saying plainly, but the pane keeps its picker so
      // another one can be tried.
      status.value = 'unavailable'
      throw caught
    }
    return loaded
  }

  async function engineFor(id: string): Promise<ModelEngine> {
    if (id === model.value) return engine()
    const held = extras.get(id)
    if (held) return held
    const selected = models.value.find((entry) => entry.id === id)
    if (!selected) {
      const named = findModel(id)
      throw new Error(
        named ? `${named.label} cannot run in this browser.` : `There is no model called “${id}”.`,
      )
    }
    // An extra's download borrows the status line, and gives it back: the line describes the
    // picked model, which is not what just finished — or failed.
    const before = status.value
    try {
      const extra = await load(selected)
      extras.set(id, extra)
      return extra
    } finally {
      status.value = before
    }
  }

  function retain(ids: readonly string[]): void {
    wanted = new Set(ids)
    for (const [id, extra] of extras) {
      if (wanted.has(id)) continue
      extra.destroy()
      extras.delete(id)
    }
  }

  function markAvailable(): void {
    status.value = 'available'
  }

  function onChange(fn: () => void): void {
    listeners.push(fn)
  }

  function thinkingNow(id: string = model.value): boolean {
    return thinking.value && findModel(id)?.thinking === true
  }

  /** The reader added or removed a model of their own in the settings panel: rebuild the
   *  catalogue `models` offers, respecting whatever `probe` already settled about the GPU. Unlike
   *  `probe`, always safe to call again — there is nothing async to redo. */
  function refreshModels(): void {
    recomputeModels()
  }

  // A different model is a different engine and a different conversation: weights, context budget
  // and system prompt all change, and carrying the turns across would be a lie about who said them.
  // Consumers are told first, so their sessions are gone before the engine under them is.
  //
  // The engines themselves change hands rather than being reloaded where they can: the model
  // picked next may already be loaded as an agent's extra, and the one on its way out may still
  // be an agent's — `wanted` says so — in which case it becomes an extra instead of being freed.
  watch(model, (id, previous) => {
    localStorage.setItem(MODEL_KEY, id)
    for (const listener of listeners) listener()
    if (loaded && wanted.has(previous)) extras.set(previous, loaded)
    else loaded?.destroy()
    loaded = extras.get(id) ?? null
    extras.delete(id)
    progress.value = 0
    probed = false
    status.value = 'checking'
    probe()
  })

  onScopeDispose(() => {
    loaded?.destroy()
    loaded = null
    retain([])
  })

  return {
    models,
    model,
    choice,
    thinking,
    status,
    progress,
    probe,
    refreshModels,
    engine,
    engineFor,
    retain,
    markAvailable,
    onChange,
    thinkingNow,
  }
}
