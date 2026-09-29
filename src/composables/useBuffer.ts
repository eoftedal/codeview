import { computed, ref, watch } from 'vue'
import type { Language } from '../lib/analyzer'
import {
  arrangeForOpen,
  createId,
  fitToStrip,
  isLanguage,
  languageForFile,
  neighbourId,
  sampleName,
  uniqueName,
  untitledName,
  withLanguage,
  MAX_OPEN_FILES,
  type CodeFile,
  type NamedFile,
} from '../lib/files'
import { sampleFor } from '../lib/sample'
import {
  buildFragment,
  decodeShare,
  encodeShare,
  isFlagSet,
  parseFiles,
  parseParams,
  serializeFiles,
} from '../lib/share'

const STORAGE_KEY = 'codeview:files'
/** What a session before the tab strip left behind: a single buffer. */
const LEGACY_KEY = 'codeview:buffer'
const MAX_FILE_BYTES = 2 * 1024 * 1024

interface Stored {
  files: CodeFile[]
  activeId: string
}

function isFile(value: unknown): value is CodeFile {
  const file = value as Partial<CodeFile> | null
  return (
    !!file &&
    typeof file.id === 'string' &&
    typeof file.name === 'string' &&
    typeof file.text === 'string' &&
    typeof file.language === 'string' &&
    isLanguage(file.language)
  )
}

function readStored(): Stored | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Stored>
      const files = Array.isArray(parsed.files) ? parsed.files.filter(isFile) : []
      if (files.length === 0) return null
      const activeId = files.some((file) => file.id === parsed.activeId)
        ? (parsed.activeId as string)
        : files[0]!.id
      return { files, activeId }
    }

    const legacy = localStorage.getItem(LEGACY_KEY)
    if (!legacy) return null
    const parsed = JSON.parse(legacy) as { text?: unknown; language?: unknown }
    if (typeof parsed.text !== 'string' || typeof parsed.language !== 'string') return null
    if (!isLanguage(parsed.language)) return null
    const file: CodeFile = {
      id: createId(),
      name: sampleName(parsed.language),
      text: parsed.text,
      language: parsed.language,
    }
    return { files: [file], activeId: file.id }
  } catch {
    return null
  }
}

/** How an open treats the tabs already showing. */
export interface OpenOptions {
  /** Close them all and let this open be the whole strip. What a folder does, and only a folder. */
  replace?: boolean
}

interface OpenOutcome {
  /** How many files the pick or the drop actually handed over. Zero is a folder whose walk found
   *  nothing worth opening in it, and has to be said: a drop that does nothing and says nothing
   *  reads as a drop target that is broken. */
  arrived: number
  /** A message per refused file, in the order they were refused. */
  rejected: string[]
  unreadable: number
  oversize: number
  overflow: number
  /** How many tabs the open closed, which only a folder ever does. */
  closed: number
}

/**
 * What to say about an open. A pick of two files names each one it refused and why, which is the
 * only useful report at that size; a folder of four hundred gets counts instead, because four
 * hundred reasons is not a notice. The cap's own line is separate and always given in full — it is
 * the one outcome the reader has to act on, and the only one that leaves a file they asked for
 * unopened.
 */
function openNotice({
  arrived,
  rejected,
  unreadable,
  oversize,
  overflow,
  closed,
}: OpenOutcome): string | null {
  if (arrived === 0) return 'Nothing opened — no files this viewer can parse in there.'
  const lines: string[] = []
  // Said rather than left to be noticed: the tabs that were there are gone, and one of them may
  // have been an unnamed buffer the reader had been typing in.
  if (closed > 0) {
    lines.push(
      closed === 1
        ? 'Closed the tab that was open — a folder open starts fresh.'
        : `Closed the ${closed} tabs that were open — a folder open starts fresh.`,
    )
  }
  if (rejected.length > 0) {
    if (rejected.length <= 3) lines.push(`Not opened — ${rejected.join('; ')}.`)
    else {
      const reasons: string[] = []
      if (unreadable) reasons.push(`${unreadable} not a language this viewer reads`)
      if (oversize) reasons.push(`${oversize} larger than 2 MB`)
      lines.push(`Skipped ${rejected.length} files — ${reasons.join(', ')}.`)
    }
  }
  if (overflow > 0) {
    lines.push(
      `${MAX_OPEN_FILES} files is all this viewer keeps open, so ${overflow} more ` +
        `${overflow === 1 ? 'was' : 'were'} left out — open a subfolder for the rest.`,
    )
  }
  return lines.length ? lines.join(' ') : null
}

/**
 * The open files, and where they came from. Priority on load: a link, which describes exactly one
 * file, then the last local session with all of its tabs, then the sample.
 *
 * Only the active file is ever analysed — the tab strip switches buffers, it does not make the
 * view multi-file. `text`, `language` and `fileName` are writable views onto whichever tab is
 * showing, so everything downstream still sees one buffer.
 */
export function useBuffer() {
  const params = parseParams(location.search, location.hash)

  const named = params.get('filename')?.trim() || null
  const requested = params.get('lang')
  // `?? null`, because a missing key comes back as `undefined` — and `undefined !== null` would
  // make every plain visit look like a link and quietly drop the restored tabs.
  const shared = params.get('src') ?? null
  /** A whole strip in one payload; `src` is the one-file form of the same thing. */
  const bundled = params.get('files') ?? null
  const wantedActive = params.get('active')?.trim() || null
  /** Chrome the embedding page would rather not show. */
  const hideHeader = isFlagSet(params, 'hideHeader')

  const stored = readStored()
  const storedActive = stored?.files.find((file) => file.id === stored.activeId) ?? null

  const notice = ref<string | null>(null)

  // A link naming a file describes that file and nothing else: restoring the reader's own tabs
  // around it would be noise. Without any of these, the last session comes back whole.
  const fromParams = shared !== null || bundled !== null || named !== null || params.has('lang')

  // An explicit ?lang wins; failing that a filename's extension speaks for itself.
  const linkLanguage: Language =
    (requested && isLanguage(requested) ? requested : null) ??
    (named ? languageForFile(named) : null) ??
    storedActive?.language ??
    'ts'

  const initial: CodeFile[] =
    !fromParams && stored
      ? stored.files
      : [
          {
            id: createId(),
            name: named ?? sampleName(linkLanguage),
            text: storedActive?.text ?? sampleFor(linkLanguage),
            language: linkLanguage,
          },
        ]

  const files = ref<CodeFile[]>(initial)
  const activeId = ref<string>(
    !fromParams && stored ? stored.activeId : (initial[0] as CodeFile).id,
  )

  /**
   * Which tab was showing, most recent first. The quick-open palette lists the files in this order,
   * which is the whole of why it is kept: with the tab you are in at the head and the one before it
   * next, Cmd+P then Enter is a toggle between two files, exactly as it is in an editor.
   *
   * Not persisted, and not cleaned up either. A reload has no history worth restoring — `activeId`
   * alone says where to begin — and an id left behind by a closed tab simply finds no file when the
   * order is read back, which is cheaper than watching for closes.
   */
  const recent = ref<string[]>([activeId.value])
  watch(activeId, (id) => {
    recent.value = [id, ...recent.value.filter((seen) => seen !== id)]
  })

  /** The open files, most recently shown first. A tab never shown since it arrived — every tab of a
   *  restored session bar one — has no place in `recent`, and follows in strip order. */
  const recentFiles = computed<CodeFile[]>(() => {
    const byId = new Map(files.value.map((file) => [file.id, file]))
    const ordered = recent.value
      .map((id) => byId.get(id))
      .filter((file): file is CodeFile => !!file)
    const seen = new Set(ordered.map((file) => file.id))
    return [...ordered, ...files.value.filter((file) => !seen.has(file.id))]
  })

  /** Never null: closing the last tab is refused, so there is always a buffer to show. */
  const active = computed(
    () => files.value.find((file) => file.id === activeId.value) ?? (files.value[0] as CodeFile),
  )

  const text = computed({
    get: () => active.value.text,
    set: (value: string) => {
      active.value.text = value
    },
  })

  // Switching language by hand renames the tab with it — a tab reading `.ts` over a buffer parsed
  // as JSX would be lying about what it is.
  const language = computed({
    get: () => active.value.language,
    set: (value: Language) => {
      const file = active.value
      if (file.language === value) return
      file.language = value
      file.name = withLanguage(file.name, value)
    },
  })

  const fileName = computed(() => active.value.name)
  /** The tab actually showing, which is `activeId` unless that has gone stale. */
  const activeFileId = computed(() => active.value.id)
  const fileIds = computed(() => files.value.map((file) => file.id))

  if (bundled) {
    // The payload carries the names, so the tabs it opens are the ones the sender had.
    void decodeShare(bundled).then((decoded) => {
      if (decoded === null) return
      const parsed = parseFiles(decoded)
      if (parsed.length === 0) return

      const opened: CodeFile[] = []
      for (const file of parsed) {
        // An entry with no header is a payload written as plain source: name it the way a link
        // with a bare `src` would be named.
        const name = uniqueName(
          file.name || named || sampleName(linkLanguage),
          opened.map((open) => open.name),
        )
        opened.push({
          id: createId(),
          name,
          text: file.text,
          language: languageForFile(name) ?? linkLanguage,
        })
      }
      files.value = opened
      activeId.value = (opened.find((file) => file.name === wantedActive) ?? opened[0]!).id
    })
  } else if (shared) {
    void decodeShare(shared).then((decoded) => {
      if (decoded !== null) text.value = decoded
    })
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  watch(
    [files, activeId],
    () => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ files: files.value, activeId: activeId.value } satisfies Stored),
          )
        } catch {
          // Private browsing or a full quota — the tabs simply won't survive a reload.
        }
      }, 400)
    },
    { deep: true },
  )

  function selectFile(id: string): void {
    if (files.value.some((file) => file.id === id)) activeId.value = id
  }

  /** A blank tab, in the language of the one it was opened from. */
  function newFile(): void {
    const file: CodeFile = {
      id: createId(),
      name: untitledName(
        files.value.map((open) => open.name),
        language.value,
      ),
      text: '',
      language: language.value,
    }
    files.value = [...files.value, file]
    activeId.value = file.id
    notice.value = null
  }

  /** Closing the last tab is refused rather than emptying the editor: there is no such thing here
   *  as no file open, and silently dropping the buffer would be the one unrecoverable action. */
  function closeFile(id: string): void {
    if (files.value.length < 2) return
    const next = neighbourId(files.value, id)
    files.value = files.value.filter((file) => file.id !== id)
    if (activeId.value === id && next) activeId.value = next
  }

  function renameFile(id: string, raw: string): void {
    const name = raw.trim()
    const file = files.value.find((open) => open.id === id)
    if (!file || !name || name === file.name) return
    // Names are how the files find each other: `./db` resolves by name, so two tabs answering to
    // one would make an import ambiguous. Refuse rather than silently shadow.
    if (files.value.some((open) => open.id !== id && open.name === name)) {
      notice.value = `There is already a tab called ${name}.`
      return
    }
    notice.value = null
    file.name = name
    // The new extension picks the language, the same way an opened file's does.
    const detected = languageForFile(name)
    if (detected) file.language = detected
  }

  /**
   * Open dropped or picked files as tabs — a handful of files, or a whole folder. Re-opening a name
   * already on the strip refreshes that tab instead of stacking a second one beside it.
   *
   * A folder arrives as paths (`src/db.ts`), which is what keeps two `index.ts` apart and what makes
   * an import between them resolve, and it arrives in bulk — so `MAX_OPEN_FILES` applies, and what
   * it left out is said rather than quietly dropped. The last file opened is still the one left
   * active, as it is for a pick of two.
   *
   * **A folder open is a new strip, not an addition to one** (`replace`), and that is the caller's
   * fact to state rather than this one's to infer: a folder is a project, so what was open belongs
   * to a different one, and fifty places shared between the two would clip the folder for the sake
   * of tabs the reader is done with. It is honoured only where something actually opens — a folder
   * holding nothing readable must not empty the editor, which is the one unrecoverable outcome here
   * and the reason there is no such thing as no file open.
   */
  async function openFiles(
    incoming: Iterable<NamedFile>,
    options: OpenOptions = {},
  ): Promise<void> {
    const picked = [...incoming]
    /** One message per refused file, which is the right report for a pick of three and unreadable
     *  for a folder of four hundred — hence the counts beside it. */
    const rejected: string[] = []
    let unreadable = 0
    let oversize = 0

    // Whether a file can be opened at all is knowable without reading it, and is settled before the
    // cap is: one this viewer cannot parse must not take a place from one it can.
    const openable: { name: string; file: File; language: Language }[] = []
    for (const { name, file } of arrangeForOpen(picked)) {
      const language = languageForFile(name)
      if (!language) {
        unreadable++
        rejected.push(`${name} isn't a file this viewer can parse`)
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        oversize++
        rejected.push(`${name} is larger than 2 MB`)
        continue
      }
      openable.push({ name, file, language })
    }

    // What the open is adding to. Replacing, that is nothing at all: every place is free and no name
    // can be a refresh of one, which is what keeps a folder from being clipped by tabs that are
    // about to close anyway.
    const kept: CodeFile[] = options.replace ? [] : files.value
    // A name already on the strip is refreshed in place and costs no room; the rest compete for what
    // is left of the cap, shallowest first. Deciding that here rather than in the loop is what lets
    // the tabs still appear in the order they arrived, which is the order a reader picked them in.
    const known = new Set(kept.map((open) => open.name))
    const fresh = openable.filter((entry) => !known.has(entry.name))
    const taken = fitToStrip(fresh, MAX_OPEN_FILES - kept.length)
    const overflow = fresh.length - taken.size

    let opened: string | null = null
    const added: CodeFile[] = []
    for (const entry of openable) {
      const existing =
        kept.find((open) => open.name === entry.name) ??
        added.find((open) => open.name === entry.name)
      if (!existing && !taken.has(entry)) continue
      const text = await entry.file.text()
      if (existing) {
        existing.text = text
        existing.language = entry.language
        opened = existing.id
      } else {
        const file: CodeFile = {
          id: createId(),
          name: entry.name,
          text,
          language: entry.language,
        }
        added.push(file)
        opened = file.id
      }
    }

    // One assignment rather than one per file: each would be a reparse and a write to localStorage.
    // The guard is what makes `replace` safe: with nothing opened there is nothing to replace the
    // strip with, so it stays and the notice says why.
    const closed = added.length > 0 && options.replace ? files.value.length : 0
    if (added.length) files.value = options.replace ? added : [...files.value, ...added]
    if (opened) activeId.value = opened
    notice.value = openNotice({
      arrived: picked.length,
      rejected,
      unreadable,
      oversize,
      overflow,
      closed,
    })
  }

  /**
   * Build a share link and put it on the clipboard. Only ever on an explicit request — writing
   * the hash on every keystroke would flood browser history.
   *
   * `systemPrompt` is the chat's and `agents` the agents pane's team, both passed in rather than
   * reached for: this composable owns the files and knows nothing about the model. Each is null
   * when the reader never rewrote it, which is why an ordinary link carries neither key at all.
   */
  async function copyShareLink(
    options: { systemPrompt?: string | null; agents?: string | null } = {},
  ): Promise<boolean> {
    const systemprompt = options.systemPrompt ? await encodeShare(options.systemPrompt) : undefined
    const agents = options.agents ? await encodeShare(options.agents) : undefined
    // Every tab goes into the link, deflated as one payload: a set of files that import each other
    // is only worth reading together, and one stream over all of them is far shorter than a
    // payload apiece. A lone file keeps the older, plainer `src` form — same link as ever, and
    // shorter for the common case.
    const single = files.value.length === 1
    // Last in the fragment: it is the longest thing in it, and a link stays readable up front.
    const fragment = single
      ? buildFragment({
          src: await encodeShare(text.value),
          lang: language.value,
          filename: fileName.value,
          systemprompt,
          agents,
        })
      : buildFragment({
          files: await encodeShare(serializeFiles(files.value)),
          active: fileName.value,
          systemprompt,
          agents,
        })
    const url = `${location.origin}${location.pathname}${fragment}`
    // Copying is the whole of what this does — it must never touch the reader's own address bar,
    // which is a live view of *their* buffer, not the one they're handing someone else.
    try {
      await navigator.clipboard.writeText(url)
      notice.value = single
        ? 'Share link copied to the clipboard.'
        : `Share link copied — all ${files.value.length} files.`
      return true
    } catch {
      // No address bar to point at any more, so the fallback carries the link itself.
      notice.value = `Clipboard blocked — copy this link: ${url}`
      return false
    }
  }

  function reset(): void {
    const language = (named ? languageForFile(named) : null) ?? 'ts'
    const file: CodeFile = {
      id: createId(),
      name: named ?? sampleName(language),
      text: sampleFor(language),
      language,
    }
    files.value = [file]
    activeId.value = file.id
    notice.value = null
    history.replaceState(null, '', location.pathname)
  }

  return {
    files,
    recentFiles,
    activeFileId,
    fileIds,
    text,
    language,
    fileName,
    hideHeader,
    notice,
    selectFile,
    newFile,
    closeFile,
    renameFile,
    openFiles,
    copyShareLink,
    reset,
  }
}
