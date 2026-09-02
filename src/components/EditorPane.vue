<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { monaco, monacoLanguageId, setupMonaco } from '../lib/monacoSetup'
import type { Language } from '../lib/analyzer'
import type { DefinitionResult, Span } from '../lib/definitions'
import type { FlowSpan } from '../lib/flow'

const props = defineProps<{
  modelValue: string
  language: Language
  /** Shown above the editor when set — from the `filename` parameter, or an opened file. */
  fileName: string | null
  /** Range of the selected AST node. */
  selection: Span | null
  definition: DefinitionResult | null
  /** Range of the AST row under the pointer. */
  hover: Span | null
  /** Every step of the active trace. */
  flow: FlowSpan[]
  /** Bumped by the parent when something should scroll into view. */
  revealToken: number
  /** What `revealToken` should scroll to; falls back to the selection when null. */
  revealSpan: Span | null
}>()

const emit = defineEmits<{
  'update:modelValue': [string]
  cursor: [number]
  /** Alt+T or the context menu: trace the value at this offset back to its sources. */
  trace: [number]
  openFile: [File]
}>()

setupMonaco()

const host = ref<HTMLElement>()
const dropActive = ref(false)
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()
let model: monaco.editor.ITextModel | undefined
let selectionDecorations: monaco.editor.IEditorDecorationsCollection | undefined
let definitionDecorations: monaco.editor.IEditorDecorationsCollection | undefined
let hoverDecorations: monaco.editor.IEditorDecorationsCollection | undefined
let flowDecorations: monaco.editor.IEditorDecorationsCollection | undefined

const EXTENSION: Record<Language, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx' }

/**
 * Monaco's TypeScript worker keys off the model URI's extension, not just the language id — an
 * extensionless URI makes it flag valid TypeScript (parameter properties, JSX) as errors.
 */
function createModelFor(language: Language, value: string): monaco.editor.ITextModel {
  return monaco.editor.createModel(
    value,
    monacoLanguageId(language),
    monaco.Uri.parse(`inmemory://codeview/main.${EXTENSION[language]}`),
  )
}

/** Set while we move the cursor ourselves, so an echo isn't mistaken for a user action. */
let suppressCursorEvents = false

function withoutCursorEvents(action: () => void): void {
  suppressCursorEvents = true
  try {
    action()
  } finally {
    queueMicrotask(() => {
      suppressCursorEvents = false
    })
  }
}

function toRange(span: Span): monaco.Range {
  const target = model!
  return monaco.Range.fromPositions(
    target.getPositionAt(span.start),
    target.getPositionAt(span.end),
  )
}

function decoration(
  span: Span,
  className: string,
  ruler?: string,
): monaco.editor.IModelDeltaDecoration {
  return {
    range: toRange(span),
    options: {
      // inlineClassName, not className: it wraps the text itself, so a tint and an underline land
      // on the code rather than on a block behind it.
      inlineClassName: className,
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      ...(ruler
        ? {
            overviewRuler: {
              color: ruler,
              position: monaco.editor.OverviewRulerLane.Right,
            },
          }
        : {}),
    },
  }
}

function applySelection(): void {
  if (!model || !selectionDecorations) return
  selectionDecorations.set(props.selection ? [decoration(props.selection, 'cv-selected')] : [])
}

function applyDefinition(): void {
  if (!model || !definitionDecorations) return
  const definition = props.definition
  if (!definition) {
    definitionDecorations.set([])
    return
  }
  const decorations = [decoration(definition.primary, 'cv-def', '#e0af68')]
  // Painted first so the primary range wins where the two overlap.
  if (definition.secondary) decorations.unshift(decoration(definition.secondary, 'cv-def-weak'))
  definitionDecorations.set(decorations)
}

function applyHover(): void {
  if (!model || !hoverDecorations) return
  hoverDecorations.set(props.hover ? [decoration(props.hover, 'cv-hover')] : [])
}

function applyFlow(): void {
  if (!model || !flowDecorations) return
  flowDecorations.set(
    props.flow.map((step) =>
      step.external
        ? decoration(step.span, 'cv-flow-external', '#f7768e')
        : decoration(step.span, 'cv-flow', '#9ece6a'),
    ),
  )
}

onMounted(() => {
  model = createModelFor(props.language, props.modelValue)

  const instance = monaco.editor.create(host.value!, {
    model,
    theme: 'codeview',
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.65,
    minimap: { enabled: false },
    glyphMargin: true,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'gutter',
    smoothScrolling: true,
    padding: { top: 14, bottom: 14 },
    tabSize: 2,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  })
  editor.value = instance

  // First, so the trace tint sits underneath the selection and definition highlights.
  flowDecorations = instance.createDecorationsCollection()
  selectionDecorations = instance.createDecorationsCollection()
  definitionDecorations = instance.createDecorationsCollection()
  hoverDecorations = instance.createDecorationsCollection()

  instance.onDidChangeModelContent(() => emit('update:modelValue', model!.getValue()))
  instance.onDidChangeCursorPosition((event) => {
    if (suppressCursorEvents) return
    emit('cursor', model!.getOffsetAt(event.position))
  })

  /**
   * A real editor action rather than a click gesture. Monaco already owns both click modifiers —
   * alt adds a cursor and ctrl/cmd goes to a definition, and `multiCursorModifier` only swaps which
   * is which — so an alt-click would fight the peek widget instead of tracing.
   */
  instance.addAction({
    id: 'codeview.trace',
    label: 'Trace value to its sources',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyT],
    run: (target) => {
      const position = target.getPosition()
      if (position) emit('trace', model!.getOffsetAt(position))
    },
  })

  emit('cursor', 0)

  // Test hook: the browser suite uses the editor's own coordinate mapping to click an exact
  // character. Dev-only, so it never reaches a production bundle.
  if (import.meta.env.DEV) {
    ;(
      window as unknown as { __codeviewEditor?: monaco.editor.IStandaloneCodeEditor }
    ).__codeviewEditor = instance
  }
})

onBeforeUnmount(() => {
  editor.value?.dispose()
  model?.dispose()
})

watch(
  () => props.modelValue,
  (next) => {
    // Only fires for changes from outside the editor: a file open, a share link, a reset.
    if (model && model.getValue() !== next) withoutCursorEvents(() => model!.setValue(next))
  },
)

watch(
  () => props.language,
  (next) => {
    const instance = editor.value
    if (!instance || !model) return

    // The extension is part of the URI, so switching language means a new model.
    const previous = model
    const position = instance.getPosition()
    model = createModelFor(next, previous.getValue())
    withoutCursorEvents(() => {
      instance.setModel(model!)
      if (position) instance.setPosition(position)
    })
    previous.dispose()

    // Detaching a model drops its decorations; put the current highlights back.
    applySelection()
    applyDefinition()
    applyHover()
    applyFlow()
  },
)

watch(() => props.selection, applySelection)
watch(() => props.definition, applyDefinition)
watch(() => props.hover, applyHover)
watch(() => props.flow, applyFlow)

watch(
  () => props.revealToken,
  () => {
    const instance = editor.value
    const target = props.revealSpan ?? props.selection
    if (!instance || !model || !target) return
    const range = toRange(target)
    withoutCursorEvents(() => {
      instance.setSelection(range)
      instance.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth)
    })
  },
)

/** Scroll a definition into view on request — it is never auto-revealed, which would yank the
 *  view away from the cursor the moment you move it. */
function revealDefinition(): void {
  const instance = editor.value
  if (!instance || !props.definition) return
  instance.revealRangeInCenterIfOutsideViewport(
    toRange(props.definition.primary),
    monaco.editor.ScrollType.Smooth,
  )
}

function onDrop(event: DragEvent): void {
  dropActive.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) emit('openFile', file)
}

defineExpose({ revealDefinition })
</script>

<template>
  <div
    class="editor-pane"
    :class="{ 'drop-active': dropActive }"
    @dragover.prevent="dropActive = true"
    @dragleave="dropActive = false"
    @drop.prevent="onDrop"
  >
    <div v-if="fileName" class="file-name" :title="fileName">{{ fileName }}</div>
    <div ref="host" class="editor" />
    <div v-if="dropActive" class="drop-hint">Drop a .ts, .tsx, .js or .jsx file</div>
  </div>
</template>

<style scoped>
.editor-pane {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.file-name {
  flex: 0 0 auto;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  color: var(--dim);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.editor {
  flex: 1;
  min-height: 0;
}

.drop-active .editor {
  opacity: 0.35;
}

.drop-hint {
  position: absolute;
  inset: 16px;
  display: grid;
  place-items: center;
  border: 2px dashed var(--accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text);
  font-weight: 500;
  pointer-events: none;
}
</style>
