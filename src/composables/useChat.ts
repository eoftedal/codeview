import { computed, onScopeDispose, ref, type Ref } from 'vue'
import {
  DEFAULT_ROLE,
  buildCodeMessage,
  buildSystemPrompt,
  promptFiles,
  type ChatSession,
} from '../lib/chat'
import type { CodeFile } from '../lib/files'
import { decodeShare, parseParams } from '../lib/share'
import { isAbort, messageOf, streamAnswer } from '../lib/stream'
import type { ModelHost } from './useModel'

/** Only written when the reader has actually rewritten the brief: an absent key means the default,
 *  so a later edit to `DEFAULT_ROLE` reaches everyone who never touched theirs. */
const ROLE_KEY = 'codeview:chat-role'

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** An answer that failed rather than one the model gave — rendered as a warning, not as speech. */
  failed?: boolean
}

export interface Chat {
  /** The system prompt's instructions half, the reader's to rewrite. The code half is generated
   *  from the open files and is appended to whatever this says. Read-only: `setRole` is the way
   *  in, because a change has to reach `localStorage` and drop the session with it. */
  role: Readonly<Ref<string>>
  /** Whether that brief is still the one shipped, for a pane that marks a rewritten one. */
  roleIsDefault: Ref<boolean>
  messages: Ref<ChatMessage[]>
  /** The answer being streamed right now; empty when nothing is in flight. */
  pending: Ref<string>
  busy: Ref<boolean>
  /** The open files have changed since this conversation's system prompt was built. */
  stale: Ref<boolean>
  ask: (question: string) => Promise<void>
  stop: () => void
  newChat: () => void
  /** Rewrite the brief. Blank means the shipped one. Remembered, and starts a new chat, since a
   *  conversation carries the prompt it began with. */
  setRole: (text: string) => void
}

/** What a session was built from, in tab order — switching tabs reorders the prompt but changes
 *  nothing about the code in it, and should not cost a conversation. */
function signatureOf(files: readonly CodeFile[]): string {
  return files.map((file) => `${file.name}\n${file.text}`).join('\u0000')
}

/**
 * A conversation with a model running on this machine — the browser's own, or weights fetched once
 * and cached and then run on the GPU. The model itself is `useModel`'s, and is shared with whatever
 * else holds a conversation.
 *
 * The session is created lazily, on the first question, and carries every open file in its system
 * prompt — so a chat started after an edit sees the edit. It is *not* rebuilt underneath an ongoing
 * conversation, which would mean throwing the conversation away; instead `stale` says the code has
 * moved on and the pane offers a new chat.
 */
export function useChat(model: ModelHost, files: Ref<CodeFile[]>, activeId: Ref<string>): Chat {
  const params = parseParams(location.search, location.hash)

  // The brief a session is built with. A conversation carries the prompt it began with, so
  // rewriting it drops the conversation the way changing model does — but not the engine: the
  // weights are the same ones, and reloading them for a wording change would be absurd.
  const role = ref(localStorage.getItem(ROLE_KEY) || DEFAULT_ROLE)
  const roleIsDefault = computed(() => role.value === DEFAULT_ROLE)

  function setRole(text: string): void {
    const next = text.trim() ? text : DEFAULT_ROLE
    if (next === role.value) return
    role.value = next
    // Only a brief that differs is worth storing: an absent key means the shipped one, so a later
    // edit to `DEFAULT_ROLE` still reaches everyone who never wrote their own.
    if (next === DEFAULT_ROLE) localStorage.removeItem(ROLE_KEY)
    else localStorage.setItem(ROLE_KEY, next)
    newChat()
  }

  /**
   * A brief carried by the link, which wins over the stored one — the same order the buffer
   * follows, where a link describes what it is about and the last session fills in the rest.
   *
   * It is deliberately *not* written to `localStorage`: it belongs to the link, and opening
   * someone else's should not overwrite the brief this reader wrote for themselves. Reloading
   * keeps it anyway, since the fragment is still in the address bar.
   */
  const linked = params.get('systemprompt') ?? null
  if (linked !== null) {
    void decodeShare(linked).then((decoded) => {
      if (!decoded?.trim()) return
      role.value = decoded
      newChat()
    })
  }

  const messages = ref<ChatMessage[]>([])
  const pending = ref('')
  const busy = ref(false)
  const sessionFiles = ref<string | null>(null)

  // The session is only a system prompt and its turns; the engine that runs it belongs to
  // `useModel` and outlives every conversation held with it.
  let session: ChatSession | null = null
  let controller: AbortController | null = null
  let nextId = 0

  const stale = computed(
    () =>
      messages.value.length > 0 &&
      sessionFiles.value !== null &&
      sessionFiles.value !== signatureOf(files.value),
  )

  async function ensureSession(): Promise<ChatSession> {
    if (session) return session

    const loaded = await model.engine()
    // Read after the load, not before: a first download can take minutes, and the code the reader
    // asks about is what is open when they ask. The brief is the system prompt; the code is seeded
    // as an opening turn behind it, so instructions and data stay separable.
    session = await loaded.chat(
      buildSystemPrompt(role.value),
      buildCodeMessage({
        files: promptFiles(files.value, activeId.value),
        maxCodeChars: model.choice.value?.maxCodeChars ?? 12_000,
      }),
    )
    sessionFiles.value = signatureOf(files.value)
    model.markAvailable()
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
      answer = await streamAnswer(
        active,
        trimmed,
        { signal: controller.signal, thinking: model.thinkingNow() },
        (text) => {
          pending.value = text
        },
      )
      messages.value = [
        ...messages.value,
        { id: nextId++, role: 'assistant', text: answer.trim() || '(the model returned nothing)' },
      ]
    } catch (caught) {
      const aborted = isAbort(caught)
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
    sessionFiles.value = null
    messages.value = []
    pending.value = ''
  }

  // A different model is a different conversation — and the engine under this session is about to
  // be torn down, so the session has to go first.
  model.onChange(newChat)

  onScopeDispose(() => {
    controller?.abort()
    session?.destroy()
  })

  return {
    role,
    roleIsDefault,
    messages,
    pending,
    busy,
    stale,
    ask,
    stop,
    newChat,
    setRole,
  }
}
