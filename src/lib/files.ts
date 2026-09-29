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
  py: 'py',
  pyi: 'py',
  java: 'java',
  // `.h` goes to C, as Monaco's own contribution does. A C++ header spelled `.h` is the one
  // case that guesses wrong, and the C++ grammar parses both — so the cost is a badge, not a tree.
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'cs',
  csx: 'cs',
}

/** What a language calls itself when we are the ones writing the name. */
const CANONICAL: Record<Language, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  py: 'py',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cs: 'cs',
}

export interface CodeFile {
  /** Stable for the life of the tab; the Monaco model and the editor's undo history hang off it. */
  id: string
  name: string
  text: string
  language: Language
}

export const LANGUAGES: readonly Language[] = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'java',
  'c',
  'cpp',
  'cs',
]

/**
 * A file the reader picked or dropped, under the name it will take on the strip. For a folder that
 * name is a **path** — `src/db.ts` — and it has to be: a project holds two `index.ts` as a matter
 * of course, and since a tab name is a module path the path is both what keeps them apart and what
 * makes `./db` between them resolve. A lone picked file keeps its bare name, as it always did.
 */
export interface NamedFile {
  name: string
  file: File
}

/**
 * Directories a folder open does not walk into. Not a tidiness rule: a `node_modules` is tens of
 * thousands of files that would be read before anything appeared on screen, and none of them is
 * what the reader picked a folder to review. Build output goes the same way — it is the code they
 * already have in source, generated. Anything dotted is covered by `isIgnoredDir` instead, which
 * is what handles `.git`.
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  'venv',
])

/**
 * How many tabs a folder may leave open. Every one of them is a Monaco model, a file in its
 * language's program, a call-site scan for every trace and a section of a chat's system prompt, so
 * a folder is clipped rather than opened whole — and the clip is stated, the same way the code
 * listing sent to a model names what did not fit.
 */
export const MAX_OPEN_FILES = 50

/** Whether a directory is one a folder open steps over. The reader's own pick is exempt — dragging
 *  a folder called `dist` is asking for `dist` — which is why only segments below the root are
 *  asked about. */
export function isIgnoredDir(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRS.has(name)
}

/** The same question asked of a whole path. The first segment is the picked folder itself and the
 *  last is the file, so neither is examined: a dotfile with an extension we read is still a file. */
export function isIgnoredPath(path: string): boolean {
  return path
    .split('/')
    .slice(1, -1)
    .some((part) => isIgnoredDir(part))
}

/** Shallowest first, then alphabetically. It decides which files a clipped folder keeps, never the
 *  order the tabs appear in — see `fitToStrip`. */
function byPath(a: string, b: string): number {
  const depth = a.split('/').length - b.split('/').length
  return depth !== 0 ? depth : a.localeCompare(b)
}

/**
 * Drop the folder each path starts in. That segment is the folder the reader picked, so it says
 * nothing they do not already know, and it makes every tab longer for nothing — while the segments
 * below it are what a tab name is _for_ (`lib/db.ts` resolves). Relative imports survive because
 * every path in a folder shifts by exactly one segment, so what they say about each other is
 * unchanged.
 *
 * It is done **per entry** rather than only for a root they all share, because "the root folder name
 * should not be in the name" holds just as much for a drop of two folders, or of a folder beside a
 * loose file, as it does for the ordinary one-folder open. A name with no folder in it — the loose
 * file itself — is already what it should be and is left alone.
 *
 * **Unless two of them would then answer to one name**, which is the one thing worse than a long
 * one: `openFiles` refreshes a tab whose name matches, so `a/src/db.ts` and `b/src/db.ts` both
 * becoming `src/db.ts` would have the second silently overwrite the first. Where that happens the
 * roots are the only thing telling them apart, so nothing is stripped at all and every name keeps
 * its own.
 */
function stripRoots<T extends { name: string }>(picked: readonly T[]): T[] {
  const stripped = picked.map((entry) => {
    const cut = entry.name.indexOf('/')
    return cut < 0 ? entry : { ...entry, name: entry.name.slice(cut + 1) }
  })
  const names = new Set(stripped.map((entry) => entry.name))
  return names.size === stripped.length ? stripped : [...picked]
}

/**
 * What a pick or a drop actually offers up, **in the order it offered it**: nothing from a directory
 * we do not walk, and each path's own leading folder gone. The order is left alone on purpose — it
 * is the order the tabs will appear in, and files picked by hand arrive in the order the reader sees
 * them in. Which files are *readable* is not decided here either: the caller reports the ones it
 * refuses, and needs each one's own reason.
 */
export function arrangeForOpen<T extends { name: string }>(picked: readonly T[]): T[] {
  const kept = picked.filter((entry) => !isIgnoredPath(entry.name))
  return stripRoots(kept)
}

/**
 * Which of them a strip with `room` places left will actually take. A folder brings more files than
 * the cap allows far more often than not, so *which* ones it drops matters: shallowest first, since
 * a project's entry points are near its root and the deepest fifty of a source tree are a poor
 * accident to be handed. The answer is a set rather than a list precisely so that the caller can
 * still open them in arrival order — the cap is decided on depth, the strip is not ordered by it.
 */
export function fitToStrip<T extends { name: string }>(picked: readonly T[], room: number): Set<T> {
  if (room >= picked.length) return new Set(picked)
  const shallowest = [...picked].sort((a, b) => byPath(a.name, b.name))
  return new Set(shallowest.slice(0, Math.max(0, room)))
}

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

/**
 * A name no open tab has yet: `db.ts` becomes `db-2.ts`, then `db-3.ts`. Only a hand-written link
 * can produce a clash — the app refuses a duplicate rename — but two tabs answering to one module
 * path would make an import ambiguous, so the collision is resolved rather than tolerated.
 */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((existing) => existing.toLowerCase()))
  if (!names.has(name.toLowerCase())) return name

  const { dot } = extensionOf(name)
  const stem = dot > 0 ? name.slice(0, dot) : name
  const suffix = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${suffix}`
    if (!names.has(candidate.toLowerCase())) return candidate
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
