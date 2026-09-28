import { computed, onScopeDispose, ref, type Ref } from 'vue'
import {
  DEFAULT_ROLE,
  buildCodeMessage,
  buildSystemPrompt,
  describeClip,
  promptFiles,
  usesTools,
  type ChatSession,
  type CodeContext,
} from '../lib/chat'
import { buildIndexMessage, fileTools } from '../lib/tools'
import { describeTraceScope } from '../lib/traceText'
import type { CodeFile } from '../lib/files'
import { decodeShare, parseParams } from '../lib/share'
import { isAbort, messageOf, streamAnswer, withTruncatedNote } from '../lib/stream'
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
  /** What of the code this conversation's model was *not* shown, in a line — or null when it saw
   *  all of it. Set when the session is built, since that is when the budget is spent. */
  clipped: Ref<string | null>
  ask: (question: string) => Promise<void>
  /**
   * Start a fresh conversation over *some* of the open files and ask one question of it — what
   * the trace pane's **Analyze this trace** does.
   *
   * A scope is a property of the session rather than of the question, so this drops whatever
   * conversation was in progress: the code a conversation carries is fixed when it opens. An
   * empty scope means every open file, which is what a model that reads the files itself gets —
   * there is nothing to save it by choosing for it.
   */
  askAbout: (question: string, scope: readonly string[]) => Promise<void>
  stop: () => void
  newChat: () => void
  /** Rewrite the brief. Blank means the shipped one. Remembered, and starts a new chat, since a
   *  conversation carries the prompt it began with. */
  setRole: (text: string) => void
}

/** What a session was built from, in tab order — switching tabs reorders the prompt but changes
 *  nothing about the code in it, and should not cost a conversation. */
function signatureOf(files: readonly { name: string; text: string }[]): string {
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
  const clipped = ref<string | null>(null)

  /**
   * The files this conversation was opened over, by name, when it is not simply every open tab —
   * which today means a trace analysis, scoped to the files the trace cites. Null is the ordinary
   * chat, and what `newChat` restores.
   *
   * Names rather than ids: a trace cites files by name, which is also what a tab is called.
   */
  let scope: string[] | null = null

  function inScope(name: string): boolean {
    return scope === null || scope.includes(name)
  }

  /** The open files this conversation is about, in tab order — what staleness is measured over,
   *  so editing a file the model was never shown does not cost the conversation. */
  function filesInScope(): CodeFile[] {
    return scope === null ? files.value : files.value.filter((file) => inScope(file.name))
  }

  // The session is only a system prompt and its turns; the engine that runs it belongs to
  // `useModel` and outlives every conversation held with it.
  let session: ChatSession | null = null
  let controller: AbortController | null = null
  let nextId = 0

  const stale = computed(
    () =>
      messages.value.length > 0 &&
      sessionFiles.value !== null &&
      sessionFiles.value !== signatureOf(filesInScope()),
  )

  async function ensureSession(): Promise<ChatSession> {
    if (session) return session

    const loaded = await model.engine()
    // Read after the load, not before: a first download can take minutes, and the code the reader
    // asks about is what is open when they ask. The brief is the system prompt; the code is seeded
    // as an opening turn behind it, so instructions and data stay separable.
    //
    // A scoped conversation takes the files in the order the scope named them — a trace's own
    // order, root first — since the budget is spent in that order. Where nothing it named is open
    // any more, the scope is dropped rather than leaving a model with no code at all.
    const all = promptFiles(files.value, activeId.value)
    const picked = scope ? scope.flatMap((name) => all.filter((file) => file.name === name)) : all
    if (picked.length === 0) scope = null
    const context: CodeContext = {
      files: picked.length > 0 ? picked : all,
      maxCodeChars: model.choice.value?.maxCodeChars ?? 12_000,
      // Said to the model as well as to the reader: a listing claiming to be the whole editor is
      // one the model cannot reason about the edges of.
      partial: scope !== null && scope.length < files.value.length,
    }
    // A model that can call a tool is given the files to *read* rather than the files: an index in
    // the opening turn, and the toolbox that opens any of them. Everything else is the same
    // conversation — same brief, same snapshot, same staleness rule — which is why the choice is
    // made here, at the one place the opening turn is built, rather than inside a provider.
    const tooled = usesTools(model.choice.value)
    session = await loaded.chat(
      buildSystemPrompt(role.value),
      tooled ? buildIndexMessage(context.files) : buildCodeMessage(context),
      tooled ? fileTools(context.files, context.maxCodeChars) : undefined,
    )
    sessionFiles.value = signatureOf(filesInScope())
    // Nothing is clipped on the tool path: the budget is spent per read instead of once over
    // everything, so no file is out of reach and there is no clip to warn about.
    //
    // A scope *is* worth saying, clip or no clip, and it goes on the same line for the same
    // reason: it is what of the code this conversation cannot see. The reader chose it a tab away,
    // and by the time an answer arrives the trace that explains it may be long gone.
    const narrowed = scope && scope.length < files.value.length ? describeTraceScope(scope) : null
    clipped.value =
      [narrowed, tooled ? null : describeClip(context)].filter(Boolean).join('; ') || null
    model.markAvailable()
    return session
  }

  async function ask(question: string): Promise<void> {
    const trimmed = question.trim()
    if (!trimmed || busy.value) return

    busy.value = true
    pending.value = ''
    messages.value = [...messages.value, { id: nextId++, role: 'user', text: trimmed }]

    try {
      const active = await ensureSession()
      controller = new AbortController()
      const answer = await streamAnswer(
        active,
        trimmed,
        { signal: controller.signal, thinking: model.thinkingNow() },
        (text) => {
          pending.value = text
        },
      )
      messages.value = [
        ...messages.value,
        {
          id: nextId++,
          role: 'assistant',
          // Cut off at the provider's ceiling, the answer says so: it is otherwise a reply that
          // simply stops mid-sentence, which reads as the model's doing.
          text: withTruncatedNote(answer) || '(the model returned nothing)',
        },
      ]
    } catch (caught) {
      const aborted = isAbort(caught)
      // What streamed before the stop is in `pending`, not in a return value that never came.
      const partial = pending.value.trim()
      if (aborted && partial) {
        messages.value = [
          ...messages.value,
          { id: nextId++, role: 'assistant', text: `${partial}\n\n[stopped]` },
        ]
      } else if (!aborted) {
        messages.value = [
          ...messages.value,
          // What streamed before the failure is kept, as it is on a stop: a server that dropped
          // the connection mid-answer said something first, and that something is also what the
          // session's history holds — a follow-up would otherwise be about text the reader can
          // no longer see.
          ...(partial ? [{ id: nextId++, role: 'assistant' as const, text: partial }] : []),
          { id: nextId++, role: 'assistant', text: messageOf(caught), failed: true },
        ]
      }
    } finally {
      pending.value = ''
      busy.value = false
      controller = null
    }
  }

  async function askAbout(question: string, names: readonly string[]): Promise<void> {
    newChat()
    scope = names.length > 0 ? [...names] : null
    await ask(question)
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
    // A new chat is the whole buffer again: a scope belongs to the conversation that asked for it.
    scope = null
    sessionFiles.value = null
    clipped.value = null
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
    clipped,
    ask,
    askAbout,
    stop,
    newChat,
    setRole,
  }
}
