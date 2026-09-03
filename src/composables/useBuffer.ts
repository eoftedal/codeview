import { computed, ref, watch } from 'vue'
import type { Language } from '../lib/analyzer'
import {
  createId,
  isLanguage,
  languageForFile,
  neighbourId,
  sampleName,
  untitledName,
  withLanguage,
  type CodeFile,
} from '../lib/files'
import { SAMPLE } from '../lib/sample'
import { buildFragment, decodeShare, encodeShare, isFlagSet, parseParams } from '../lib/share'

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
  /** Chrome the embedding page would rather not show. */
  const hideHeader = isFlagSet(params, 'hideHeader')

  const stored = readStored()
  const storedActive = stored?.files.find((file) => file.id === stored.activeId) ?? null

  const notice = ref<string | null>(null)

  // A link naming a file describes that file and nothing else: restoring the reader's own tabs
  // around it would be noise. Without any of these, the last session comes back whole.
  const fromParams = shared !== null || named !== null || params.has('lang')

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
            text: storedActive?.text ?? SAMPLE,
            language: linkLanguage,
          },
        ]

  const files = ref<CodeFile[]>(initial)
  const activeId = ref<string>(
    !fromParams && stored ? stored.activeId : (initial[0] as CodeFile).id,
  )

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

  if (shared) {
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
    file.name = name
    // The new extension picks the language, the same way an opened file's does.
    const detected = languageForFile(name)
    if (detected) file.language = detected
  }

  /** Open dropped or picked files as tabs. Re-opening a name already on the strip refreshes that
   *  tab instead of stacking a second one beside it. */
  async function openFiles(incoming: Iterable<File>): Promise<void> {
    const rejected: string[] = []
    let opened: string | null = null

    for (const file of incoming) {
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name} is larger than 2 MB`)
        continue
      }
      const detected = languageForFile(file.name)
      if (!detected) {
        rejected.push(`${file.name} isn't a TypeScript or JavaScript file`)
        continue
      }
      const content = await file.text()
      const existing = files.value.find((open) => open.name === file.name)
      if (existing) {
        existing.text = content
        existing.language = detected
        opened = existing.id
      } else {
        const added: CodeFile = {
          id: createId(),
          name: file.name,
          text: content,
          language: detected,
        }
        files.value = [...files.value, added]
        opened = added.id
      }
    }

    if (opened) activeId.value = opened
    notice.value = rejected.length ? `Not opened — ${rejected.join('; ')}.` : null
  }

  /** Build a share link and put it on the clipboard. Only ever on an explicit request — writing
   *  the hash on every keystroke would flood browser history. */
  async function copyShareLink(): Promise<boolean> {
    // One file to a link, the one on screen: the fragment carries source, and every other tab
    // would multiply the length of a URL that already has to fit in an address bar. The filename
    // rides along, since it is the one bit of context saying which file the reader is looking at.
    const fragment = buildFragment({
      src: await encodeShare(text.value),
      lang: language.value,
      filename: fileName.value,
    })
    const url = `${location.origin}${location.pathname}${fragment}`
    history.replaceState(null, '', fragment)
    try {
      await navigator.clipboard.writeText(url)
      notice.value =
        files.value.length > 1
          ? 'Share link copied — it carries the file you were looking at.'
          : 'Share link copied to the clipboard.'
      return true
    } catch {
      notice.value = 'Share link is in the address bar — copy it from there.'
      return false
    }
  }

  function reset(): void {
    const language = (named ? languageForFile(named) : null) ?? 'ts'
    const file: CodeFile = {
      id: createId(),
      name: named ?? sampleName(language),
      text: SAMPLE,
      language,
    }
    files.value = [file]
    activeId.value = file.id
    notice.value = null
    history.replaceState(null, '', location.pathname)
  }

  return {
    files,
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
