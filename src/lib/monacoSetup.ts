import * as monaco from 'monaco-editor'
import type { Language } from './analyzer'

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
 * Monaco 0.56 spawns its own workers with `new Worker(new URL(…), { type: 'module' })`, which Vite
 * bundles on its own — so there is deliberately no `MonacoEnvironment.getWorker` here. Defining one
 * would take priority over that wiring and we'd have to hand-resolve every worker path again.
 *
 * Monaco's worker only powers editor niceties (hover types, completion, red squiggles). The AST and
 * the definition highlighting come from our own analyzer — see lib/analyzer.ts.
 */
export function setupMonaco(): void {
  if (configured) return
  configured = true

  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
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
