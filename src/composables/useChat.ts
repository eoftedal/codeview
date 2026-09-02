import { computed, onScopeDispose, ref, type Ref } from 'vue'
import type { Language } from '../lib/analyzer'
import {
  buildSystemPrompt,
  languageModel,
  type Availability,
  type LanguageModelCreateOptions,
  type LanguageModelSession,
} from '../lib/chat'

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** An answer that failed rather than one the model gave — rendered as a warning, not as speech. */
  failed?: boolean
}

/** `checking` covers the availability probe; after that it is whatever the browser reported. */
export type ChatStatus = 'checking' | Availability

export interface Chat {
  status: Ref<ChatStatus>
  /** Model download progress, 0–1, while `status` is `downloading`. */
  progress: Ref<number>
  messages: Ref<ChatMessage[]>
  /** The answer being streamed right now; empty when nothing is in flight. */
  pending: Ref<string>
  busy: Ref<boolean>
  /** The buffer has changed since this conversation's system prompt was built. */
  stale: Ref<boolean>
  /** Ask the browser whether a model exists. Idempotent, and deliberately not run on load. */
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
 * A conversation with the browser's on-device model about the current buffer.
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
  const api = languageModel()

  const status = ref<ChatStatus>(api ? 'checking' : 'unavailable')
  const progress = ref(0)
  const messages = ref<ChatMessage[]>([])
  const pending = ref('')
  const busy = ref(false)
  const sessionCode = ref<string | null>(null)

  let session: LanguageModelSession | null = null
  let controller: AbortController | null = null
  let nextId = 0
  let probed = false

  /** Asking the browser about the model is the pane's first cost, so it waits for the pane to be
   *  opened rather than running on load for everyone who never uses it. */
  function probe(): void {
    if (probed || !api) return
    probed = true
    void api
      .availability()
      .then((available) => (status.value = available))
      .catch(() => (status.value = 'unavailable'))
  }

  const stale = computed(
    () =>
      messages.value.length > 0 && sessionCode.value !== null && sessionCode.value !== text.value,
  )

  /** A model that refuses to load is the case the pane states plainly, so a failed `create` puts
   *  the whole tab back to the "no language model" message rather than to an error string. */
  async function create(options: LanguageModelCreateOptions): Promise<LanguageModelSession> {
    try {
      return await api!.create(options)
    } catch (caught) {
      status.value = 'unavailable'
      throw caught
    }
  }

  async function ensureSession(): Promise<LanguageModelSession> {
    if (session) return session
    if (!api) throw new Error('No language model in this browser.')

    const code = text.value
    const created = await create({
      initialPrompts: [
        {
          role: 'system',
          content: buildSystemPrompt({ code, language: language.value, fileName: fileName.value }),
        },
      ],
      // A first run may have to fetch the model, which is large enough that silence looks broken.
      // The monitor is handed over on every create, so only real progress marks it downloading.
      monitor: (monitor) => {
        monitor.addEventListener('downloadprogress', (event) => {
          const { loaded } = event as ProgressEvent
          progress.value = loaded
          if (loaded < 1) status.value = 'downloading'
        })
      },
    })
    session = created
    sessionCode.value = code
    status.value = 'available'
    return created
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
      // Read by hand rather than `for await`: the stream is a plain ReadableStream of deltas.
      const reader = active.promptStreaming(trimmed, { signal: controller.signal }).getReader()
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

  /** Drop the conversation *and* the session, so the next question rebuilds the system prompt
   *  around whatever the buffer says by then. */
  function newChat(): void {
    stop()
    session?.destroy()
    session = null
    sessionCode.value = null
    messages.value = []
    pending.value = ''
  }

  onScopeDispose(() => {
    controller?.abort()
    session?.destroy()
  })

  return { status, progress, messages, pending, busy, stale, probe, ask, stop, newChat }
}
