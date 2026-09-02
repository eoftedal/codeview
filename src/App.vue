<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import AstPane from './components/AstPane.vue'
import ChatPane from './components/ChatPane.vue'
import EditorPane from './components/EditorPane.vue'
import SplitPane from './components/SplitPane.vue'
import TracePane from './components/TracePane.vue'
import { useAnalysis } from './composables/useAnalysis'
import { useBuffer } from './composables/useBuffer'
import { useChat } from './composables/useChat'
import { findNodeAtOffset } from './lib/astTree'
import type { DefinitionResult, Span } from './lib/definitions'
import { isExternalOrigin, type FlowTrace } from './lib/flow'

const SPLIT_KEY = 'codeview:split'

const { text, language, fileName, hideHeader, notice, openFile, copyShareLink, reset } = useBuffer()

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
/** Set when a trace row asks for a scroll, so the reveal lands on that exact step. */
const revealSpan = ref<Span | null>(null)

const activeTab = ref<'ast' | 'trace' | 'chat'>('ast')
// Shallow: the graph is replaced wholesale and must never be deeply proxied, like the AST.
const trace = shallowRef<FlowTrace | null>(null)
/** A span the trace pane is pointing at, which wins over the AST row under the pointer. */
const tracedHover = ref<Span | null>(null)

/** Held here, not in the pane: the pane unmounts whenever another tab is shown, and a
 *  conversation should survive a glance at the tree. */
const chat = useChat(text, language, fileName)

watch(activeTab, (tab) => {
  if (tab === 'chat') chat.probe()
})

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
const hoverSpan = computed(() => tracedHover.value ?? spanOf(hoveredId.value))

const flowSpans = computed(() =>
  (trace.value?.nodes ?? []).map((node) => ({
    span: node.span,
    external: isExternalOrigin(node.origin),
  })),
)

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
  revealSpan.value = null
  revealToken.value++
}

/** Walking a value back to its sources costs many reference queries, so it only ever runs here —
 *  on an explicit request, never on cursor movement the way the definition highlight does. */
function runTrace(offset: number = cursorOffset.value): void {
  cursorOffset.value = offset
  trace.value = analysis.trace(offset)
  activeTab.value = 'trace'
}

function onSelectTraceStep(span: Span): void {
  const tree = analysis.tree.value
  origin.value = 'tree'
  cursorOffset.value = span.start
  selectedId.value = tree ? findNodeAtOffset(tree, span.start) : null
  refreshDefinition()
  revealSpan.value = span
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
  // Every span in a trace is an offset into the text that just changed, so it cannot survive an
  // edit. Re-walking on each parse would cost far more than the definition lookup beside it.
  trace.value = null
  tracedHover.value = null
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
    <header v-if="!hideHeader" class="app-bar">
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
            :file-name="fileName"
            :selection="selectionSpan"
            :definition="definition"
            :hover="hoverSpan"
            :flow="flowSpans"
            :reveal-token="revealToken"
            :reveal-span="revealSpan"
            @cursor="onCursor"
            @trace="runTrace"
            @open-file="openFile"
          />
        </template>
        <template #right>
          <div class="right-pane">
            <nav class="tabs">
              <button :class="{ active: activeTab === 'ast' }" @click="activeTab = 'ast'">
                AST
              </button>
              <button :class="{ active: activeTab === 'trace' }" @click="activeTab = 'trace'">
                Trace
                <span v-if="trace && trace.externalCount" class="badge">
                  {{ trace.externalCount }}
                </span>
              </button>
              <button :class="{ active: activeTab === 'chat' }" @click="activeTab = 'chat'">
                Chat
              </button>
            </nav>

            <AstPane
              v-if="activeTab === 'ast' && analysis.tree.value"
              v-model:show-tokens="showTokens"
              :tree="analysis.tree.value"
              :selected-id="selectedId"
              :definition="definition"
              :origin="origin"
              @select="onSelectNode"
              @hover="hoveredId = $event"
              @reveal-definition="editorPane?.revealDefinition()"
            />
            <TracePane
              v-else-if="activeTab === 'trace'"
              :trace="trace"
              :target="definition?.label ?? null"
              @run="runTrace()"
              @select="onSelectTraceStep"
              @hover="tracedHover = $event"
            />
            <ChatPane
              v-else-if="activeTab === 'chat'"
              :status="chat.status.value"
              :progress="chat.progress.value"
              :messages="chat.messages.value"
              :pending="chat.pending.value"
              :busy="chat.busy.value"
              :stale="chat.stale.value"
              @ask="chat.ask($event)"
              @stop="chat.stop()"
              @new-chat="chat.newChat()"
            />
          </div>
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

.right-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
  border-left: 1px solid var(--border);
}

.tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  padding: 6px 8px 0;
  border-bottom: 1px solid var(--border);
}

.tabs button {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 6px 6px 0 0;
  background: none;
  color: var(--dim);
  padding: 5px 12px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  position: relative;
  top: 1px;
}

.tabs button:hover {
  color: var(--text);
  border-color: transparent;
}

.tabs button.active {
  color: var(--text);
  background: var(--bg);
  border-color: var(--border);
}

.badge {
  font-size: 10px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--danger) 26%, transparent);
  color: var(--danger);
  text-align: center;
}

.right-pane > :not(.tabs) {
  flex: 1;
  min-height: 0;
}
</style>
