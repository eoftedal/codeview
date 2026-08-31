import * as monaco from 'monaco-editor'
// Note the specifiers: monaco 0.56's exports map is "./*" -> "./esm/vs/*.js", so the older
// 'monaco-editor/esm/vs/...' form resolves to a doubled, non-existent path.
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'
import type { Language } from './analyzer'

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment
  }
}

const MONACO_LANGUAGE: Record<Language, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
}

export function monacoLanguageId(language: Language): string {
  return MONACO_LANGUAGE[language]
}

let configured = false

/**
 * Monaco 0.56 can spawn its own workers with `new Worker(new URL(…))`, and in dev Vite handles that
 * fine. In a production build it does not: the core editor worker is referenced through a bare
 * `new URL(…, import.meta.url)`, which Vite copies as a static asset instead of bundling, leaving
 * its own relative imports dangling ("Invalid relative url or base scheme isn't hierarchical").
 * So we wire the workers explicitly through `?worker` imports, which Vite bundles properly.
 *
 * getWorker must answer for *every* label: the language-feature path returns whatever this hands
 * back, with no fallback if it is undefined.
 *
 * These workers only power editor niceties (hover types, completion, red squiggles). The AST and
 * the definition highlighting come from our own analyzer — see lib/analyzer.ts.
 */
export function setupMonaco(): void {
  if (configured) return
  configured = true

  self.MonacoEnvironment = {
    getWorker(_workerId, label) {
      return label === 'typescript' || label === 'javascript' ? new tsWorker() : new editorWorker()
    },
  }

  for (const defaults of [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ]) {
    // 2307/2792 are "cannot find module": this is a single-buffer viewer, so an import never
    // resolves and the squiggle would say nothing useful. Our own analyzer points such names at
    // the import statement instead — see lib/definitions.ts.
    defaults.setDiagnosticsOptions({ diagnosticCodesToIgnore: [2307, 2792] })
    defaults.setCompilerOptions({
      target: monaco.typescript.ScriptTarget.ESNext,
      module: monaco.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
      jsx: monaco.typescript.JsxEmit.Preserve,
      allowJs: true,
      allowNonTsExtensions: true,
    })
  }

  monaco.editor.defineTheme('codeview', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0f131b',
      'editor.foreground': '#d7dce5',
      'editorLineNumber.foreground': '#3b4455',
      'editorLineNumber.activeForeground': '#8b95a8',
      'editorGutter.background': '#0f131b',
      'editorIndentGuide.background1': '#1c2230',
      'editor.lineHighlightBackground': '#161b26',
      'editorWidget.background': '#131824',
      'editorWidget.border': '#242b3a',
      'scrollbarSlider.background': '#242b3a80',
    },
  })
}

export { monaco }
