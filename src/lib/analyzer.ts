import ts from 'typescript'

export type Language = 'ts' | 'tsx' | 'js' | 'jsx'

const SCRIPT_KIND: Record<Language, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
}

/** One open file, as the analyzer sees it. */
export interface AnalyzerFile {
  /** The tab's name — also the path the other files import it by. */
  name: string
  text: string
  language: Language
}

export interface Analyzer {
  /**
   * Replace the open set, and say which file is being looked at. Returns true when anything but
   * that pointer changed, so a caller can tell a real edit from a tab switch — spans from an
   * earlier trace survive the second and not the first.
   */
  update(files: readonly AnalyzerFile[], activeName?: string): boolean
  /** Path of the file being looked at. */
  fileName(): string
  sourceFile(): ts.SourceFile
  service(): ts.LanguageService
}

/**
 * The path a tab's name takes inside the program. Relative imports resolve against these, which is
 * what lets a definition — and a taint trace — cross from one tab into another.
 */
export function pathFor(name: string): string {
  return `/${name.replace(/^\.?\//, '')}`
}

/** The tab name behind an analyzer path. */
export function fileLabel(path: string): string {
  return path.replace(/^\//, '')
}

interface Entry {
  text: string
  language: Language
  version: number
}

/**
 * A `ts.LanguageService` over the open files.
 *
 * `noLib` is deliberate: no lib.d.ts is bundled, so nothing resolves into the standard library.
 * `noResolve` is deliberately *not* set — imports between open tabs do resolve, which is what a
 * cross-file trace walks along. An import of anything that is not open (`express`, `node:fs`)
 * still resolves to nothing, and that is what makes a terminal honest: unresolvable means the
 * value came from somewhere this session cannot see.
 */
export function createAnalyzer(): Analyzer {
  const files = new Map<string, Entry>()
  let active = ''

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (name) => String(files.get(name)?.version ?? 0),
    getScriptSnapshot: (name) => {
      const entry = files.get(name)
      return entry ? ts.ScriptSnapshot.fromString(entry.text) : undefined
    },
    // From the tab's language, not from the path: a file someone renamed to `notes` is still
    // whatever the language buttons say it is.
    getScriptKind: (name) => SCRIPT_KIND[files.get(name)?.language ?? 'ts'],
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => ({
      allowJs: true,
      checkJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noLib: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      allowNonTsExtensions: true,
    }),
    getDefaultLibFileName: () => 'lib.d.ts',
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name)?.text,
    directoryExists: (directory) => {
      if (directory === '/' || directory === '') return true
      const prefix = directory.endsWith('/') ? directory : `${directory}/`
      return [...files.keys()].some((path) => path.startsWith(prefix))
    },
  }

  const service = ts.createLanguageService(host, ts.createDocumentRegistry())

  return {
    update(next, activeName) {
      let changed = false
      const seen = new Set<string>()

      for (const file of next) {
        const path = pathFor(file.name)
        seen.add(path)
        const entry = files.get(path)
        if (!entry) {
          files.set(path, { text: file.text, language: file.language, version: 1 })
          changed = true
        } else if (entry.text !== file.text || entry.language !== file.language) {
          entry.text = file.text
          entry.language = file.language
          entry.version++
          changed = true
        }
      }

      for (const path of [...files.keys()]) {
        if (seen.has(path)) continue
        files.delete(path)
        changed = true
      }

      const wanted =
        activeName !== undefined ? pathFor(activeName) : (seen.values().next().value ?? '')
      active = files.has(wanted) ? wanted : (files.keys().next().value ?? '')
      return changed
    },
    fileName: () => active,
    sourceFile() {
      const sf = service.getProgram()?.getSourceFile(active)
      if (!sf) throw new Error(`no source file for ${active}`)
      return sf
    },
    service: () => service,
  }
}

/** Innermost `ts.Node` covering `offset`, mirroring `findNodeAtOffset` over the flat tree. */
export function findTsNodeAtOffset(sf: ts.SourceFile, offset: number): ts.Node {
  let found: ts.Node = sf
  const walk = (node: ts.Node) => {
    if (offset >= node.getStart(sf) && offset < node.getEnd()) {
      found = node
      ts.forEachChild(node, walk)
    }
  }
  ts.forEachChild(sf, walk)
  return found
}
