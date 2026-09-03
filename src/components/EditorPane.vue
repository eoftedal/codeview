<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { monaco, monacoLanguageId, setupMonaco } from '../lib/monacoSetup'
import type { Language } from '../lib/analyzer'
import type { DefinitionResult, Span } from '../lib/definitions'
import type { FlowSpan } from '../lib/flow'

const props = defineProps<{
  modelValue: string
  language: Language
  /** Which open file this is. Each one keeps its own model, so undo history, cursor and scroll
   *  survive a trip through another tab. */
  fileId: string
  /** Every open file, so a model can be disposed once its tab is gone. */
  fileIds: readonly string[]
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
  openFiles: [File[]]
}>()

setupMonaco()

const host = ref<HTMLElement>()
const dropActive = ref(false)
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()
/** The model currently attached to the editor — the active file's. */
let model: monaco.editor.ITextModel | undefined

interface Buffer {
  model: monaco.editor.ITextModel
  language: Language
  /** Cursor and scroll, so a tab comes back where it was left. */
  state: monaco.editor.ICodeEditorViewState | null
}

/** One model per open file, keyed by file id. */
const buffers = new Map<string, Buffer>()
let selectionDecorations: monaco.editor.IEditorDecorationsCollection | undefined
let definitionDecorations: monaco.editor.IEditorDecorationsCollection | undefined
let hoverDecorations: monaco.editor.IEditorDecorationsCollection | undefined
let flowDecorations: monaco.editor.IEditorDecorationsCollection | undefined

const EXTENSION: Record<Language, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx' }

/**
 * Monaco's TypeScript worker keys off the model URI's extension, not just the language id — an
 * extensionless URI makes it flag valid TypeScript (parameter properties, JSX) as errors. The id
 * rather than the filename keeps the URI unique and stable across a rename.
 */
function createModelFor(id: string, language: Language, value: string): monaco.editor.ITextModel {
  return monaco.editor.createModel(
    value,
    monacoLanguageId(language),
    monaco.Uri.parse(`inmemory://codeview/${id}.${EXTENSION[language]}`),
  )
}

/** The model for a file, made on first sight. A language switch means a new one, since the
 *  extension is part of the URI — the text and the view state carry over. */
function bufferFor(id: string, language: Language, value: string): Buffer {
  const existing = buffers.get(id)
  if (existing && existing.language === language) return existing

  const text = existing ? existing.model.getValue() : value
  const state = existing?.state ?? null
  existing?.model.dispose()
  const created: Buffer = { model: createModelFor(id, language, text), language, state }
  buffers.set(id, created)
  return created
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
  model = bufferFor(props.fileId, props.language, props.modelValue).model

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

  instance.onDidChangeModelContent(() => emit('update:modelValue', instance.getModel()!.getValue()))
  instance.onDidChangeCursorPosition((event) => {
    if (suppressCursorEvents) return
    emit('cursor', instance.getModel()!.getOffsetAt(event.position))
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
  for (const buffer of buffers.values()) buffer.model.dispose()
  buffers.clear()
})

watch(
  () => props.modelValue,
  (next) => {
    // Only fires for changes from outside the editor: a file open, a share link, a reset. Aimed at
    // the buffer for the file the props now name, never at whatever happens to be attached — on a
    // tab switch both props change at once, and writing this text into the outgoing model would
    // overwrite the file being left behind.
    const entry = buffers.get(props.fileId)
    if (entry && entry.model.getValue() !== next) {
      withoutCursorEvents(() => entry.model.setValue(next))
    }
  },
)

/**
 * Show the active file: attach its model, restoring where the cursor and scroll were left. A
 * language switch lands here too, since the extension is part of the URI and so means a new model.
 */
function showActive(): void {
  const instance = editor.value
  if (!instance) return

  const current = instance.getModel()
  // Before `bufferFor`, which may replace the entry this state belongs to.
  if (current) {
    for (const buffer of buffers.values()) {
      if (buffer.model === current) buffer.state = instance.saveViewState()
    }
  }

  const entry = bufferFor(props.fileId, props.language, props.modelValue)
  if (entry.model !== current) {
    if (entry.model.getValue() !== props.modelValue) entry.model.setValue(props.modelValue)
    model = entry.model
    withoutCursorEvents(() => {
      instance.setModel(entry.model)
      if (entry.state) instance.restoreViewState(entry.state)
    })

    // Detaching a model drops its decorations; put the current highlights back.
    applySelection()
    applyDefinition()
    applyHover()
    applyFlow()

    // An offset means something different in this buffer, so say where the cursor now is rather
    // than leaving the parent pointing into the file that just left.
    const position = instance.getPosition()
    if (position) emit('cursor', entry.model.getOffsetAt(position))
  }

  // After the switch, so the model being disposed is never the attached one.
  const open = new Set(props.fileIds)
  for (const [id, buffer] of buffers) {
    if (open.has(id)) continue
    buffer.model.dispose()
    buffers.delete(id)
  }
}

watch(() => [props.fileId, props.language, props.fileIds], showActive)

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
  const dropped = [...(event.dataTransfer?.files ?? [])]
  if (dropped.length) emit('openFiles', dropped)
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
    <slot name="tabs" />
    <div ref="host" class="editor" />
    <div v-if="dropActive" class="drop-hint">Drop .ts, .tsx, .js or .jsx files</div>
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
