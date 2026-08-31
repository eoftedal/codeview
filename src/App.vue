<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AstPane from './components/AstPane.vue'
import EditorPane from './components/EditorPane.vue'
import SplitPane from './components/SplitPane.vue'
import { useAnalysis } from './composables/useAnalysis'
import { useBuffer } from './composables/useBuffer'
import { findNodeAtOffset } from './lib/astTree'
import type { DefinitionResult, Span } from './lib/definitions'

const SPLIT_KEY = 'codeview:split'

const { text, language, notice, openFile, copyShareLink, reset } = useBuffer()

const showTokens = ref(false)
const analysis = useAnalysis(text, language, showTokens)

/**
 * The cursor offset is the single source of truth for what is selected: node ids are only stable
 * within one parse, so after every re-parse the selection is re-derived from the offset. Tree
 * clicks additionally pin the exact node, since an offset alone can't distinguish a node from its
 * same-position ancestors.
 */
const cursorOffset = ref(0)
const selectedId = ref<number | null>(null)
const origin = ref<'editor' | 'tree'>('editor')
const definition = ref<DefinitionResult | null>(null)
const hoveredId = ref<number | null>(null)
const revealToken = ref(0)

const editorPane = ref<InstanceType<typeof EditorPane>>()

const splitRatio = ref(Number(localStorage.getItem(SPLIT_KEY)) || 0.58)
watch(splitRatio, (value) => localStorage.setItem(SPLIT_KEY, String(value)))

function spanOf(id: number | null): Span | null {
  const tree = analysis.tree.value
  if (id === null || !tree) return null
  const node = tree.nodes[id]
  return node ? { start: node.start, end: node.end } : null
}

const selectionSpan = computed(() => spanOf(selectedId.value))
const hoverSpan = computed(() => spanOf(hoveredId.value))

function refreshDefinition(): void {
  definition.value = analysis.resolve(cursorOffset.value)
}

function onCursor(offset: number): void {
  cursorOffset.value = offset
  origin.value = 'editor'
  const tree = analysis.tree.value
  selectedId.value = tree ? findNodeAtOffset(tree, offset) : null
  refreshDefinition()
}

function onSelectNode(id: number): void {
  const tree = analysis.tree.value
  if (!tree) return
  const node = tree.nodes[id]
  if (!node) return
  origin.value = 'tree'
  selectedId.value = id
  cursorOffset.value = node.start
  refreshDefinition()
  revealToken.value++
}

// Ids don't survive a re-parse, so re-derive the selection (and the definition, whose ranges may
// have shifted) from the offset every time the tree is rebuilt.
watch(analysis.revision, () => {
  const tree = analysis.tree.value
  if (!tree) return
  if (origin.value === 'editor' || selectedId.value === null) {
    selectedId.value = findNodeAtOffset(tree, cursorOffset.value)
  }
  refreshDefinition()
})

const languages = [
  { id: 'ts', label: 'TS' },
  { id: 'tsx', label: 'TSX' },
  { id: 'js', label: 'JS' },
  { id: 'jsx', label: 'JSX' },
] as const

const fileInput = ref<HTMLInputElement>()

function onFilePicked(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void openFile(file)
  ;(event.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div class="app">
    <header class="app-bar">
      <h1>codeview</h1>
      <p class="tagline">cursor ↔ AST, with definitions</p>

      <div class="actions">
        <div class="languages">
          <button
            v-for="option in languages"
            :key="option.id"
            :class="{ active: language === option.id }"
            @click="language = option.id"
          >
            {{ option.label }}
          </button>
        </div>
        <button @click="fileInput?.click()">Open file</button>
        <button @click="copyShareLink()">Copy link</button>
        <button @click="reset()">Reset</button>
        <input
          ref="fileInput"
          class="hidden-input"
          type="file"
          accept=".ts,.tsx,.js,.jsx,.mjs,.cjs,.mts,.cts"
          @change="onFilePicked"
        />
      </div>
    </header>

    <p v-if="notice" class="notice" @click="notice = null">{{ notice }}</p>

    <main>
      <SplitPane v-model="splitRatio">
        <template #left>
          <EditorPane
            ref="editorPane"
            v-model="text"
            :language="language"
            :selection="selectionSpan"
            :definition="definition"
            :hover="hoverSpan"
            :reveal-token="revealToken"
            @cursor="onCursor"
            @open-file="openFile"
          />
        </template>
        <template #right>
          <AstPane
            v-if="analysis.tree.value"
            v-model:show-tokens="showTokens"
            :tree="analysis.tree.value"
            :selected-id="selectedId"
            :definition="definition"
            :origin="origin"
            @select="onSelectNode"
            @hover="hoveredId = $event"
            @reveal-definition="editorPane?.revealDefinition()"
          />
        </template>
      </SplitPane>
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
}

.app-bar {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

h1 {
  font-size: 14px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin: 0;
  color: var(--text);
}

.tagline {
  margin: 0;
  font-size: 12px;
  color: var(--dim);
}

.actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
}

.languages {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.languages button {
  border: 0;
  border-radius: 0;
  border-right: 1px solid var(--border);
}

.languages button:last-child {
  border-right: 0;
}

.languages button.active {
  background: var(--accent);
  color: #0b0f16;
}

button {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--dim);
  border-radius: 6px;
  padding: 5px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

button:hover {
  color: var(--text);
  border-color: var(--accent);
}

.languages button:hover {
  border-color: var(--border);
  background: var(--row-hover);
}

.languages button.active:hover {
  background: var(--accent);
  color: #0b0f16;
}

.hidden-input {
  display: none;
}

.notice {
  margin: 0;
  padding: 7px 14px;
  background: color-mix(in srgb, var(--gold) 16%, var(--panel));
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}

main {
  flex: 1;
  min-height: 0;
}
</style>
