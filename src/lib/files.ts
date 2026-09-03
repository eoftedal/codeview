/**
 * The open files. One buffer is still what gets analysed — the tab strip only decides which one —
 * so everything here is about naming and identity, never about resolving between files.
 */
import type { Language } from './analyzer'

/** Extensions we accept, and the language each one means. */
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

/** What a language calls itself when we are the ones writing the name. */
const CANONICAL: Record<Language, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx' }

export interface CodeFile {
  /** Stable for the life of the tab; the Monaco model and the editor's undo history hang off it. */
  id: string
  name: string
  text: string
  language: Language
}

export const LANGUAGES: readonly Language[] = ['ts', 'tsx', 'js', 'jsx']

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value)
}

/** A leading dot is a dotfile, not an extension: `.eslintrc` has no extension at all. */
function extensionOf(name: string): { dot: number; ext: string } {
  const dot = name.lastIndexOf('.')
  return { dot, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' }
}

export function languageForFile(name: string): Language | null {
  return EXTENSIONS[extensionOf(name).ext] ?? null
}

/**
 * The name a file takes when its language is switched by hand. An extension we recognise is
 * rewritten, so the tab never claims `.ts` about a buffer being parsed as JSX; anything else is
 * left alone, since we would only be guessing at what it meant.
 */
export function withLanguage(name: string, language: Language): string {
  const { dot, ext } = extensionOf(name)
  if (!(ext in EXTENSIONS) || EXTENSIONS[ext] === language) return name
  return `${name.slice(0, dot)}.${CANONICAL[language]}`
}

/** The name the seed buffer arrives under — a real filename, because every tab needs one. */
export function sampleName(language: Language): string {
  return `example.${CANONICAL[language]}`
}

/** `untitled-1.ts`, `untitled-2.ts`, … — the first number no open tab has taken. */
export function untitledName(taken: Iterable<string>, language: Language): string {
  const names = new Set([...taken].map((name) => name.toLowerCase()))
  for (let n = 1; ; n++) {
    const candidate = `untitled-${n}.${CANONICAL[language]}`
    if (!names.has(candidate)) return candidate
  }
}

/** Which tab takes over when `id` is closed: the one to its right, failing that the one to its
 *  left. Null only when `id` was the last file open, which the caller never allows. */
export function neighbourId(files: readonly CodeFile[], id: string): string | null {
  const index = files.findIndex((file) => file.id === id)
  if (index < 0) return null
  return files[index + 1]?.id ?? files[index - 1]?.id ?? null
}

let seq = 0

/** Unique within a session, and across a reload that restored ids from a previous one. */
export function createId(): string {
  seq += 1
  return `f${Date.now().toString(36)}-${seq}`
}
