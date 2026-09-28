import { computed, onScopeDispose, ref, shallowRef, type Ref } from 'vue'
import {
  DEFAULT_ROLE,
  buildAddedCodeMessage,
  buildCodeMessage,
  buildSystemPrompt,
  describeClip,
  describeClipOf,
  planCode,
  promptFiles,
  usesTools,
  type ChatSession,
  type CodeContext,
} from '../lib/chat'
import { buildIndexMessage, fileTools } from '../lib/tools'
import { describeScope, mentionedFiles } from '../lib/mentions'
import type { CodeFile } from '../lib/files'
import { decodeShare, parseParams } from '../lib/share'
import { isAbort, messageOf, streamAnswer, withTruncatedNote } from '../lib/stream'
import type { ModelHost } from './useModel'

/** Only written when the reader has actually rewritten the brief: an absent key means the default,
 *  so a later edit to `DEFAULT_ROLE` reaches everyone who never touched theirs. */
const ROLE_KEY = 'codeview:chat-role'

/** The least a follow-up may spend on a file it is adding, whatever the opening turn left. Below
 *  this the file arrives as a stub that teaches a model nothing, and a reader who tagged it is
 *  better told it did not fit. */
const MIN_ADDED_CHARS = 1_000

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
   *  all of it. Set when the session is built, since that is when the budget is spent — and
   *  rewritten when a later question adds a file to it. */
  clipped: Ref<string | null>
  /** Whether a session exists yet, which is what decides whether a question's `@` tags *scope* the
   *  conversation or *add* to it. Not `messages.length`: a first question whose model would not
   *  load leaves a row in the transcript and no session behind it. */
  opened: Ref<boolean>
  /** The files this conversation carries, by name — or null while it carries every open tab, which
   *  is also what a model that reads its own files is left with. For the pane's line about what a
   *  tag in the box is about to do. */
  scopeFiles: Ref<readonly string[] | null>
  /**
   * Ask a question. The files it names with `@` are what the conversation is opened over — see
   * `tagged` below for why only the first question's tags can decide that.
   */
  ask: (question: string) => Promise<void>
  /**
   * Start a fresh conversation and ask one question of it — what the trace pane's **Analyze this
   * trace** does.
   *
   * There is no scope argument, because the question carries its own: `traceQuestion` writes the
   * trace's files in as `@` tags, and they are read here exactly as a reader's typed ones are.
   * What this adds over `ask` is the fresh conversation, which a scope needs — the code a
   * conversation carries is fixed when it opens.
   */
  askAbout: (question: string) => Promise<void>
  stop: () => void
  newChat: () => void
  /** Rewrite the brief. Blank means the shipped one. Remembered, and starts a new chat, since a
   *  conversation carries the prompt it began with. */
  setRole: (text: string) => void
}

/**
 * What a session was shown, file by file — the snapshot `stale` is measured against.
 *
 * A map rather than one joined string, and the reason is the follow-up path below: a conversation
 * can *gain* a file mid-way, and folding a new one into a joined signature would silently forgive
 * every edit made to the others in the meantime. Being order-insensitive is a second, smaller win:
 * switching tabs reorders the prompt without changing a character of it, and never cost a
 * conversation under the old rule either.
 */
function snapshotOf(files: readonly { name: string; text: string }[]): Map<string, string> {
  return new Map(files.map((file) => [file.name, file.text]))
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
  const shown = shallowRef<Map<string, string> | null>(null)
  const opened = computed(() => shown.value !== null)
  const clipped = ref<string | null>(null)

  /**
   * The files the question that *opened* this conversation named with `@`, or null where it named
   * none. Names rather than ids: a tag names a file the way a tab is labelled.
   *
   * Only the opening question's tags *scope* anything, and that is the architecture rather than a
   * shortcut: a session is built with its code and cannot be handed different code afterwards
   * without throwing the conversation away. A tag written later does the one thing that is possible
   * without doing that — it **adds** — see `withTaggedFiles`.
   */
  let tagged: string[] | null = null

  /**
   * The files this conversation's code was actually built from, or null for every open tab.
   *
   * Not the same list as `tagged`: a model that reads files for itself is given every tab whatever
   * the question tagged, so a tagged question on a tool-calling model narrows nothing and leaves
   * this null. It **grows** where a later question tags a file the conversation lacks — that is the
   * one thing a follow-up tag can do, since the code a session was opened with cannot be replaced.
   */
  const scopeFiles = ref<readonly string[] | null>(null)

  /** What a `read_file` and a listing alike have already spent of this conversation's budget. A
   *  follow-up carrying a file spends on top of the opening turn, not instead of it, so what is
   *  left is what it may spend — otherwise a chat could talk itself past its own window. */
  let spentCode = 0
  /** Every clip this conversation has made, in order, for the one line the pane shows. */
  let clipNotes: string[] = []

  /** The open files this conversation is about, in tab order — what staleness is measured over,
   *  so editing a file the model was never shown does not cost the conversation. */
  function filesInScope(): CodeFile[] {
    const names = scopeFiles.value
    return names === null ? files.value : files.value.filter((file) => names.includes(file.name))
  }

  /** The one line under the picker: what this conversation cannot see, and what of it was cut. */
  function describeContext(): string | null {
    const names = scopeFiles.value
    return [names ? describeScope(names) : null, ...clipNotes].filter(Boolean).join('; ') || null
  }

  // The session is only a system prompt and its turns; the engine that runs it belongs to
  // `useModel` and outlives every conversation held with it.
  let session: ChatSession | null = null
  let controller: AbortController | null = null
  let nextId = 0

  const stale = computed(() => {
    const taken = shown.value
    if (messages.value.length === 0 || taken === null) return false
    const current = filesInScope()
    // A close or a rename changes the count; an edit changes a text. A tab merely switched to
    // changes neither, which is why this is a map rather than an ordered join.
    return (
      current.length !== taken.size || current.some((file) => taken.get(file.name) !== file.text)
    )
  })

  async function ensureSession(): Promise<ChatSession> {
    if (session) return session

    const loaded = await model.engine()
    // Read after the load, not before: a first download can take minutes, and the code the reader
    // asks about is what is open when they ask. The brief is the system prompt; the code is seeded
    // as an opening turn behind it, so instructions and data stay separable.
    //
    // A tagged conversation takes the files in the order the question named them — a trace's own
    // order, root first — since the budget is spent in that order. Where nothing it named is open
    // any more, the tags are dropped rather than leaving a model with no code at all.
    const all = promptFiles(files.value, activeId.value)
    const named = tagged ? tagged.flatMap((name) => all.filter((file) => file.name === name)) : []
    // A model that can call a tool is given the files to *read* rather than the files: an index in
    // the opening turn, and the toolbox that opens any of them. Everything else is the same
    // conversation — same brief, same snapshot, same staleness rule — which is why the choice is
    // made here, at the one place the opening turn is built, rather than inside a provider.
    const tooled = usesTools(model.choice.value)
    // And it is given *every* tab even when the question tagged some, because the tags cost it
    // nothing: it reads what it needs, starting where the index points it. Narrowing what it may
    // open would take away the one thing the tool path has — a path that leaves the tagged files
    // is one it can follow.
    const picked = tooled || named.length === 0 ? all : named
    scopeFiles.value = picked === all ? null : picked.map((file) => file.name)
    const context: CodeContext = {
      files: picked,
      maxCodeChars: model.choice.value?.maxCodeChars ?? 12_000,
      // Said to the model as well as to the reader: a listing claiming to be the whole editor is
      // one the model cannot reason about the edges of.
      partial: picked.length < all.length,
    }
    const code = tooled
      ? buildIndexMessage(
          context.files,
          named.map((file) => file.name),
        )
      : buildCodeMessage(context)
    session = await loaded.chat(
      buildSystemPrompt(role.value),
      code,
      tooled ? fileTools(context.files, context.maxCodeChars) : undefined,
    )
    // An index is not code: on the tool path the budget is the ceiling on one read and nothing has
    // been spent against it yet.
    spentCode = tooled ? 0 : code.length
    shown.value = snapshotOf(filesInScope())
    // Nothing is clipped on the tool path: the budget is spent per read instead of once over
    // everything, so no file is out of reach and there is no clip to warn about. Nor is anything
    // narrowed there, whatever the question tagged — which is why this line follows `shown` and
    // not the tags.
    //
    // A narrowing *is* worth saying, clip or no clip, and it goes on the same line for the same
    // reason: it is what of the code this conversation cannot see. By the time an answer arrives
    // the question that tagged the files may be far up the transcript.
    clipNotes = [!tooled && describeClip(context)].filter((note): note is string => Boolean(note))
    clipped.value = describeContext()
    model.markAvailable()
    return session
  }

  /**
   * The files a *follow-up* question tagged, as a message to go ahead of it — and the one place
   * where what the reader sees and what the model gets are deliberately different text.
   *
   * The transcript keeps the question as it was typed, tags and all, because that is what was
   * asked. The model is handed the same question with the code in front of it, and only the code it
   * does not already have: a file the conversation carries is named rather than sent twice, and a
   * model that reads its own files is told to read them and sent nothing. So `@db.ts @auth.ts` on
   * the second question of a conversation opened over `db.ts` costs one file, not two.
   *
   * The budget is what is *left* of it. A follow-up spends on top of the opening turn rather than
   * instead of it, so a conversation cannot talk its way past its own window one tag at a time.
   */
  function withTaggedFiles(question: string): string {
    const names = mentionedFiles(
      question,
      files.value.map((file) => file.name),
    )
    if (names.length === 0) return question

    const carried = scopeFiles.value
    const reads = usesTools(model.choice.value)
    // Nothing to add on the tool path, and nothing to add to a conversation that already holds
    // every open tab. Both still get a line: the tag is the reader pointing, and a pointer with
    // nothing behind it is worse than one that says where to look.
    const missing = reads || carried === null ? [] : names.filter((name) => !carried.includes(name))
    const all = promptFiles(files.value, activeId.value)
    const budget = model.choice.value?.maxCodeChars ?? 12_000
    const plan = planCode({
      files: missing.flatMap((name) => all.filter((file) => file.name === name)),
      maxCodeChars: Math.max(MIN_ADDED_CHARS, budget - spentCode),
    })
    const extra = buildAddedCodeMessage({
      plan,
      known: reads ? [] : names.filter((name) => !missing.includes(name)),
      readable: reads ? names : [],
    })
    if (extra === null) return question

    spentCode += extra.length
    // What was actually sent is what the conversation now carries — a file the budget could not
    // reach is named to the model and to the reader, and belongs in neither.
    const arrived = plan.shown.map(({ file }) => file.name)
    if (arrived.length > 0 && carried !== null) {
      scopeFiles.value = [...carried, ...arrived]
      shown.value = snapshotOf(filesInScope())
      const note = describeClipOf(plan)
      if (note) clipNotes = [...clipNotes, note]
      clipped.value = describeContext()
    }
    return `${extra}\n\n${question}`
  }

  async function ask(question: string): Promise<void> {
    const trimmed = question.trim()
    if (!trimmed || busy.value) return

    // The tags on the question that opens a conversation are what it is opened over. Read here
    // rather than in the pane so that every way in agrees — the composer, a suggestion button, the
    // trace pane's own question — and read only while there is no session, since the code a
    // conversation carries is fixed once it has one. A later question's tags add to it instead.
    if (!session) {
      const named = mentionedFiles(
        trimmed,
        files.value.map((file) => file.name),
      )
      tagged = named.length > 0 ? named : null
    }
    const continuing = session !== null

    busy.value = true
    pending.value = ''
    messages.value = [...messages.value, { id: nextId++, role: 'user', text: trimmed }]

    try {
      const active = await ensureSession()
      controller = new AbortController()
      const answer = await streamAnswer(
        active,
        continuing ? withTaggedFiles(trimmed) : trimmed,
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

  async function askAbout(question: string): Promise<void> {
    newChat()
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
    // A new chat is the whole buffer again: tags belong to the conversation they opened.
    tagged = null
    scopeFiles.value = null
    shown.value = null
    spentCode = 0
    clipNotes = []
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
    opened,
    scopeFiles,
    ask,
    askAbout,
    stop,
    newChat,
    setRole,
  }
}
