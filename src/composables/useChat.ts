import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { Language } from '../lib/analyzer'
import {
  buildSystemPrompt,
  modelById,
  type Availability,
  type ChatSession,
  type ModelChoice,
  type ModelEngine,
} from '../lib/chat'
import { providerFor, usableModels } from '../lib/providers'
import { hasGpuAdapter } from '../lib/providers/webgpu'

const MODEL_KEY = 'codeview:chat-model'
const THINKING_KEY = 'codeview:chat-thinking'

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** An answer that failed rather than one the model gave — rendered as a warning, not as speech. */
  failed?: boolean
}

/** `checking` covers the availability probe; after that it is whatever the provider reported. */
export type ChatStatus = 'checking' | Availability

export interface Chat {
  /** The models this browser can actually run, built-in first. Empty means none can. */
  models: Ref<ModelChoice[]>
  /** The chosen model's id, remembered between visits. */
  model: Ref<string>
  choice: Ref<ModelChoice | null>
  /** Let a reasoning model think first. Only meaningful where `choice.thinking` is set. */
  thinking: Ref<boolean>
  status: Ref<ChatStatus>
  /** Weight download progress, 0–1, while `status` is `downloading`. */
  progress: Ref<number>
  messages: Ref<ChatMessage[]>
  /** The answer being streamed right now; empty when nothing is in flight. */
  pending: Ref<string>
  busy: Ref<boolean>
  /** The buffer has changed since this conversation's system prompt was built. */
  stale: Ref<boolean>
  /** Settle what can run here. Idempotent, and deliberately not run on load. */
  probe: () => void
  ask: (question: string) => Promise<void>
  stop: () => void
  newChat: () => void
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * A conversation with a model running on this machine — the browser's own, or weights fetched once
 * and cached and then run on the GPU.
 *
 * The session is created lazily, on the first question, and carries the code in its system prompt
 * — so a chat started after an edit sees the edit. It is *not* rebuilt underneath an ongoing
 * conversation, which would mean throwing the conversation away; instead `stale` says the code has
 * moved on and the pane offers a new chat.
 */
export function useChat(
  text: Ref<string>,
  language: Ref<Language>,
  fileName: Ref<string | null>,
): Chat {
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
  const status = ref<ChatStatus>(models.value.length === 0 ? 'unavailable' : 'checking')
  const progress = ref(0)
  const messages = ref<ChatMessage[]>([])
  const pending = ref('')
  const busy = ref(false)
  const sessionCode = ref<string | null>(null)

  // Two lifetimes: the engine holds the loaded model and survives "New chat"; the session is only
  // a system prompt and its turns. Tearing the engine down per conversation would mean reloading
  // weights onto the GPU every time, which is exactly what a new chat should not cost.
  let engine: ModelEngine | null = null
  let session: ChatSession | null = null
  let controller: AbortController | null = null
  let nextId = 0
  let probed = false

  /** Asking what can run here is the pane's first cost, so it waits for the pane to be opened
   *  rather than running on load for everyone who never uses it.
   *
   *  A GPU adapter is a fact about the browser rather than about any one model — Chrome exposes
   *  `navigator.gpu` on machines that then hand back nothing — so it is settled once, and every
   *  downloadable model is dropped when there is no GPU to run it on. Which is what leaves the
   *  pane with nothing to offer, and the plain message, on a browser that can do neither. */
  function probe(): void {
    if (probed) return
    probed = true
    void (async () => {
      if (!(await hasGpuAdapter())) {
        models.value = models.value.filter((choice) => choice.provider === 'builtin')
        if (models.value.length === 0) {
          status.value = 'unavailable'
          return
        }
        // Selecting a different model re-enters this through the watcher below.
        if (!models.value.some((choice) => choice.id === model.value)) {
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

  const stale = computed(
    () =>
      messages.value.length > 0 && sessionCode.value !== null && sessionCode.value !== text.value,
  )

  async function ensureEngine(selected: ModelChoice): Promise<ModelEngine> {
    if (engine) return engine
    try {
      engine = await providerFor(selected.provider).load({
        model: selected.model,
        thinking: selected.thinking,
        dtype: selected.dtype,
        onProgress: (loaded) => {
          progress.value = loaded
          if (loaded < 1) status.value = 'downloading'
        },
      })
    } catch (caught) {
      // A model that will not load is worth saying plainly, but the pane keeps its picker so
      // another one can be tried.
      status.value = 'unavailable'
      throw caught
    }
    return engine
  }

  async function ensureSession(): Promise<ChatSession> {
    if (session) return session

    const selected = choice.value
    if (!selected) throw new Error('No language model is selected.')

    const loaded = await ensureEngine(selected)
    // Read after the load, not before: a first download can take minutes, and the buffer the
    // reader asks about is the one on screen when they ask.
    const code = text.value
    session = await loaded.chat(
      buildSystemPrompt({
        code,
        language: language.value,
        fileName: fileName.value,
        maxCodeChars: selected.maxCodeChars,
      }),
    )
    sessionCode.value = code
    status.value = 'available'
    return session
  }

  async function ask(question: string): Promise<void> {
    const trimmed = question.trim()
    if (!trimmed || busy.value) return

    busy.value = true
    pending.value = ''
    messages.value = [...messages.value, { id: nextId++, role: 'user', text: trimmed }]

    let answer = ''
    try {
      const active = await ensureSession()
      controller = new AbortController()
      // Read by hand rather than `for await`: every provider hands back a plain ReadableStream
      // of deltas.
      const reader = active
        .promptStreaming(trimmed, {
          signal: controller.signal,
          thinking: thinking.value && choice.value?.thinking === true,
        })
        .getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        answer += value
        pending.value = answer
      }
      messages.value = [
        ...messages.value,
        { id: nextId++, role: 'assistant', text: answer.trim() || '(the model returned nothing)' },
      ]
    } catch (caught) {
      const aborted = caught instanceof DOMException && caught.name === 'AbortError'
      if (aborted && answer.trim()) {
        messages.value = [
          ...messages.value,
          { id: nextId++, role: 'assistant', text: `${answer.trim()}\n\n[stopped]` },
        ]
      } else if (!aborted) {
        messages.value = [
          ...messages.value,
          { id: nextId++, role: 'assistant', text: messageOf(caught), failed: true },
        ]
      }
    } finally {
      pending.value = ''
      busy.value = false
      controller = null
    }
  }

  function stop(): void {
    controller?.abort()
  }

  /** Drop the conversation, keeping the loaded model: the next question rebuilds the system
   *  prompt around whatever the buffer says by then, without paying for the model again. */
  function newChat(): void {
    stop()
    session?.destroy()
    session = null
    sessionCode.value = null
    messages.value = []
    pending.value = ''
  }

  // A different model is a different engine and a different conversation: weights, context budget
  // and system prompt all change, and carrying the turns across would be a lie about who said them.
  watch(model, (id) => {
    localStorage.setItem(MODEL_KEY, id)
    newChat()
    engine?.destroy()
    engine = null
    progress.value = 0
    probed = false
    status.value = 'checking'
    probe()
  })

  onScopeDispose(() => {
    controller?.abort()
    session?.destroy()
    engine?.destroy()
  })

  return {
    models,
    model,
    choice,
    thinking,
    status,
    progress,
    messages,
    pending,
    busy,
    stale,
    probe,
    ask,
    stop,
    newChat,
  }
}
