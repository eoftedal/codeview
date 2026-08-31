import { ref, watch } from 'vue'
import type { Language } from '../lib/analyzer'
import { SAMPLE } from '../lib/sample'
import { buildFragment, decodeShare, encodeShare, isFlagSet, parseParams } from '../lib/share'

const STORAGE_KEY = 'codeview:buffer'
const MAX_FILE_BYTES = 2 * 1024 * 1024

const EXTENSIONS: Record<string, Language> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
}

const LANGUAGES: readonly Language[] = ['ts', 'tsx', 'js', 'jsx']

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value)
}

export function languageForFile(name: string): Language | null {
  return EXTENSIONS[name.split('.').pop()?.toLowerCase() ?? ''] ?? null
}

interface Stored {
  text: string
  language: Language
}

function readStored(): Stored | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Stored>
    if (typeof parsed.text !== 'string' || !parsed.language) return null
    return { text: parsed.text, language: parsed.language }
  } catch {
    return null
  }
}

/**
 * The buffer and where it came from. Priority on load: share link, then the last local session,
 * then the sample.
 */
export function useBuffer() {
  const stored = readStored()
  const params = parseParams(location.search, location.hash)

  const named = params.get('filename')?.trim() || null
  const requested = params.get('lang')

  const text = ref(stored?.text ?? SAMPLE)
  const fileName = ref<string | null>(named)
  const notice = ref<string | null>(null)

  // An explicit ?lang wins; failing that a filename's extension speaks for itself.
  const language = ref<Language>(
    (requested && isLanguage(requested) ? requested : null) ??
      (named ? languageForFile(named) : null) ??
      stored?.language ??
      'ts',
  )

  /** Chrome the embedding page would rather not show. */
  const hideHeader = isFlagSet(params, 'hideHeader')

  const shared = params.get('src')
  if (shared) {
    void decodeShare(shared).then((decoded) => {
      if (decoded !== null) text.value = decoded
    })
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  watch([text, language], () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ text: text.value, language: language.value } satisfies Stored),
        )
      } catch {
        // Private browsing or a full quota — the buffer simply won't survive a reload.
      }
    }, 400)
  })

  async function openFile(file: File): Promise<void> {
    if (file.size > MAX_FILE_BYTES) {
      notice.value = `${file.name} is larger than 2 MB — open a smaller file.`
      return
    }
    const detected = languageForFile(file.name)
    if (!detected) {
      notice.value = `${file.name} isn't a TypeScript or JavaScript file.`
      return
    }
    text.value = await file.text()
    language.value = detected
    fileName.value = file.name
    notice.value = null
  }

  /** Build a share link and put it on the clipboard. Only ever on an explicit request — writing
   *  the hash on every keystroke would flood browser history. */
  async function copyShareLink(): Promise<boolean> {
    // The filename rides along: a link that dropped it would arrive without the one bit of
    // context saying which file the reader is looking at.
    const fragment = buildFragment({
      src: await encodeShare(text.value),
      lang: language.value,
      filename: fileName.value,
    })
    const url = `${location.origin}${location.pathname}${fragment}`
    history.replaceState(null, '', fragment)
    try {
      await navigator.clipboard.writeText(url)
      notice.value = 'Share link copied to the clipboard.'
      return true
    } catch {
      notice.value = 'Share link is in the address bar — copy it from there.'
      return false
    }
  }

  function reset(): void {
    text.value = SAMPLE
    language.value = 'ts'
    fileName.value = named
    notice.value = null
    history.replaceState(null, '', location.pathname)
  }

  return { text, language, fileName, hideHeader, notice, openFile, copyShareLink, reset }
}
