import { ref, watch } from 'vue'
import type { Language } from '../lib/analyzer'
import { SAMPLE } from '../lib/sample'

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

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function pipe(bytes: Uint8Array, transform: TransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** `z.` marks a deflated payload, `r.` a raw one, so old links keep working either way. */
async function encodeShare(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  if (typeof CompressionStream === 'undefined') return `r.${toBase64Url(bytes)}`
  return `z.${toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')))}`
}

async function decodeShare(payload: string): Promise<string | null> {
  try {
    const bytes = fromBase64Url(payload.slice(2))
    if (payload.startsWith('r.')) return new TextDecoder().decode(bytes)
    if (payload.startsWith('z.') && typeof DecompressionStream !== 'undefined') {
      return new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw')))
    }
  } catch {
    // A hand-edited or truncated link just falls back to whatever was stored.
  }
  return null
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
  const text = ref(stored?.text ?? SAMPLE)
  const language = ref<Language>(stored?.language ?? 'ts')
  const fileName = ref('main')
  const notice = ref<string | null>(null)

  const params = new URLSearchParams(location.hash.slice(1))
  const shared = params.get('src')
  if (shared) {
    const sharedLanguage = params.get('lang')
    void decodeShare(shared).then((decoded) => {
      if (decoded === null) return
      text.value = decoded
      if (sharedLanguage && isLanguage(sharedLanguage)) language.value = sharedLanguage
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
    fileName.value = file.name.replace(/\.[^.]+$/, '')
    notice.value = null
  }

  /** Build a share link and put it on the clipboard. Only ever on an explicit request — writing
   *  the hash on every keystroke would flood browser history. */
  async function copyShareLink(): Promise<boolean> {
    const payload = await encodeShare(text.value)
    const url = `${location.origin}${location.pathname}#src=${payload}&lang=${language.value}`
    history.replaceState(null, '', `#src=${payload}&lang=${language.value}`)
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
    fileName.value = 'main'
    notice.value = null
    history.replaceState(null, '', location.pathname)
  }

  return { text, language, fileName, notice, openFile, copyShareLink, reset }
}
