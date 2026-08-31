import ts from 'typescript'

export type Language = 'ts' | 'tsx' | 'js' | 'jsx'

const FILE_NAMES: Record<Language, string> = {
  ts: 'main.ts',
  tsx: 'main.tsx',
  js: 'main.js',
  jsx: 'main.jsx',
}

export interface Analyzer {
  /** Replace the buffer contents. Cheap — the service reuses its caches for unchanged text. */
  update(text: string, language: Language): void
  fileName(): string
  sourceFile(): ts.SourceFile
  service(): ts.LanguageService
}

/**
 * A `ts.LanguageService` over one in-memory file.
 *
 * `noLib` is deliberate: no lib.d.ts is bundled, so nothing resolves into the standard library.
 * That costs nothing here — a definition outside the buffer has no range to highlight anyway —
 * and it keeps both the bundle and each re-parse small.
 */
export function createAnalyzer(): Analyzer {
  let text = ''
  let language: Language = 'ts'
  let version = 0

  const currentFile = () => FILE_NAMES[language]

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [currentFile()],
    getScriptVersion: () => String(version),
    getScriptSnapshot: (name) =>
      name === currentFile() ? ts.ScriptSnapshot.fromString(text) : undefined,
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => ({
      allowJs: true,
      checkJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noLib: true,
      noResolve: true,
      allowNonTsExtensions: true,
    }),
    getDefaultLibFileName: () => 'lib.d.ts',
    fileExists: (name) => name === currentFile(),
    readFile: (name) => (name === currentFile() ? text : undefined),
  }

  const service = ts.createLanguageService(host, ts.createDocumentRegistry())

  return {
    update(nextText, nextLanguage) {
      if (nextText === text && nextLanguage === language) return
      text = nextText
      language = nextLanguage
      version++
    },
    fileName: currentFile,
    sourceFile() {
      const sf = service.getProgram()?.getSourceFile(currentFile())
      if (!sf) throw new Error(`no source file for ${currentFile()}`)
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
