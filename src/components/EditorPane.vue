<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { monaco, monacoLanguageId, setupMonaco } from '../lib/monacoSetup'
import type { Language } from '../lib/analyzer'
import type { DefinitionResult, Span } from '../lib/definitions'

const props = defineProps<{
  modelValue: string
  language: Language
  /** Range of the selected AST node. */
  selection: Span | null
  definition: DefinitionResult | null
  /** Range of the AST row under the pointer. */
  hover: Span | null
  /** Bumped by the parent when the selection should scroll into view. */
  revealToken: number
}>()

const emit = defineEmits<{
  'update:modelValue': [string]
  cursor: [number]
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
  return monaco.Range.fromPositions(target.getPositionAt(span.start), target.getPositionAt(span.end))
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

  selectionDecorations = instance.createDecorationsCollection()
  definitionDecorations = instance.createDecorationsCollection()
  hoverDecorations = instance.createDecorationsCollection()

  instance.onDidChangeModelContent(() => emit('update:modelValue', model!.getValue()))
  instance.onDidChangeCursorPosition((event) => {
    if (suppressCursorEvents) return
    emit('cursor', model!.getOffsetAt(event.position))
  })

  emit('cursor', 0)

  // Test hook: the browser suite uses the editor's own coordinate mapping to click an exact
  // character. Dev-only, so it never reaches a production bundle.
  if (import.meta.env.DEV) {
    ;(window as unknown as { __codeviewEditor?: monaco.editor.IStandaloneCodeEditor }).__codeviewEditor =
      instance
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
  },
)

watch(() => props.selection, applySelection)
watch(() => props.definition, applyDefinition)
watch(() => props.hover, applyHover)

watch(
  () => props.revealToken,
  () => {
    const instance = editor.value
    if (!instance || !model || !props.selection) return
    const range = toRange(props.selection)
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
    <div ref="host" class="editor" />
    <div v-if="dropActive" class="drop-hint">Drop a .ts, .tsx, .js or .jsx file</div>
  </div>
</template>

<style scoped>
.editor-pane {
  position: relative;
  height: 100%;
}

.editor {
  height: 100%;
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
