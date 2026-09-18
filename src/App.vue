<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import AgentsPane from './components/AgentsPane.vue'
import AstPane from './components/AstPane.vue'
import ChatPane from './components/ChatPane.vue'
import EditorPane from './components/EditorPane.vue'
import FileTabs from './components/FileTabs.vue'
import SplitPane from './components/SplitPane.vue'
import TracePane from './components/TracePane.vue'
import { useAgents } from './composables/useAgents'
import { useAnalysis } from './composables/useAnalysis'
import { useBuffer } from './composables/useBuffer'
import { useChat } from './composables/useChat'
import { useModel } from './composables/useModel'
import { findNodeAtOffset } from './lib/astTree'
import type { DefinitionResult, Span } from './lib/definitions'
import { isExternalOrigin, type FlowTarget, type FlowTrace } from './lib/flow'

const SPLIT_KEY = 'codeview:split'

const {
  files,
  activeFileId,
  fileIds,
  text,
  language,
  fileName,
  hideHeader,
  notice,
  selectFile,
  newFile,
  closeFile,
  renameFile,
  openFiles,
  copyShareLink,
  reset,
} = useBuffer()

const showTokens = ref(false)
// Every open file is analysed together, so an import between tabs resolves; the tree is still the
// active one's alone.
const analysis = useAnalysis(files, fileName, showTokens)

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

const activeTab = ref<'ast' | 'trace' | 'chat' | 'agents'>('ast')
// Shallow: the graph is replaced wholesale and must never be deeply proxied, like the AST.
const trace = shallowRef<FlowTrace | null>(null)
/** A step the trace pane is pointing at, which wins over the AST row under the pointer. */
const tracedHover = ref<FlowTarget | null>(null)

/** One loaded model for the whole app: a conversation and an agent run are two uses of the same
 *  weights, and a second engine would put the same gigabytes on the GPU twice. */
const model = useModel()

/** Held here, not in the panes: a pane unmounts whenever another tab is shown, and neither a
 *  conversation nor a run should survive only as long as a glance at the tree. */
const chat = useChat(model, files, activeFileId)
const agents = useAgents(model, files, activeFileId)

watch(activeTab, (tab) => {
  if (tab === 'chat' || tab === 'agents') model.probe()
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

// A trace step's span is an offset into *its* file, so anything the editor draws has to be filtered
// to the tab on screen — a step in another file has no range here at all.
const hoverSpan = computed(() => {
  const traced = tracedHover.value
  if (traced) return traced.file === fileName.value ? traced.span : null
  return spanOf(hoveredId.value)
})

const flowSpans = computed(() =>
  (trace.value?.nodes ?? [])
    .filter((node) => node.file === fileName.value)
    .map((node) => ({
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

function onSelectTraceStep(target: FlowTarget): void {
  if (target.file !== fileName.value) {
    const open = files.value.find((file) => file.name === target.file)
    if (!open) return
    selectFile(open.id)
    // The editor switches buffers on the next flush and announces its own cursor as it lands, so
    // aim after it. The tree is still the old file's until the parse catches up, which is why the
    // selection is left to be re-derived from the offset rather than guessed at now.
    void nextTick(() => {
      origin.value = 'editor'
      cursorOffset.value = target.span.start
      selectedId.value = null
      definition.value = null
      revealSpan.value = target.span
      revealToken.value++
    })
    return
  }

  const tree = analysis.tree.value
  origin.value = 'tree'
  cursorOffset.value = target.span.start
  selectedId.value = tree ? findNodeAtOffset(tree, target.span.start) : null
  refreshDefinition()
  revealSpan.value = target.span
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

// A trace's spans are offsets into text that has just changed, so they cannot survive an edit —
// but they do survive a tab switch, which reparses without moving a character. Losing the trace on
// every switch would make a cross-file one impossible to follow.
watch(analysis.contentRevision, () => {
  trace.value = null
  tracedHover.value = null
})

const languages = [
  { id: 'ts', label: 'TS' },
  { id: 'tsx', label: 'TSX' },
  { id: 'js', label: 'JS' },
  { id: 'jsx', label: 'JSX' },
] as const

/** The link carries the chat's brief and the agents' team when the reader wrote either — the
 *  composables meet here, as everything else does, rather than reaching into each other. Both are
 *  null while they are the shipped ones, so an ordinary link carries neither. */
function shareLink(): void {
  void copyShareLink({
    systemPrompt: chat.roleIsDefault.value ? null : chat.role.value,
    agents: agents.shareText.value,
  })
}

const fileInput = ref<HTMLInputElement>()

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement
  const picked = [...(input.files ?? [])]
  if (picked.length) void openFiles(picked)
  input.value = ''
}
</script>

<template>
  <div class="app">
    <header v-if="!hideHeader" class="app-bar">
      <h1>codeview</h1>
      <p class="tagline">cursor ↔ AST, definitions, traces, and a local model</p>

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
        <button @click="fileInput?.click()">Open files</button>
        <button @click="shareLink()">Copy link</button>
        <button @click="reset()">Reset</button>
        <input
          ref="fileInput"
          class="hidden-input"
          type="file"
          multiple
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
            :file-id="activeFileId"
            :file-ids="fileIds"
            :selection="selectionSpan"
            :definition="definition"
            :hover="hoverSpan"
            :flow="flowSpans"
            :reveal-token="revealToken"
            :reveal-span="revealSpan"
            @cursor="onCursor"
            @trace="runTrace"
            @open-files="openFiles"
          >
            <template #tabs>
              <FileTabs
                :files="files"
                :active-id="activeFileId"
                @select="selectFile"
                @close="closeFile"
                @rename="renameFile"
                @add="newFile"
              />
            </template>
          </EditorPane>
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
              <button :class="{ active: activeTab === 'agents' }" @click="activeTab = 'agents'">
                Agents
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
              :active-file="fileName"
              @run="runTrace()"
              @select="onSelectTraceStep"
              @hover="tracedHover = $event"
            />
            <ChatPane
              v-else-if="activeTab === 'chat'"
              :models="model.models.value"
              :model="model.model.value"
              :choice="model.choice.value"
              :thinking="model.thinking.value"
              :role="chat.role.value"
              :role-is-default="chat.roleIsDefault.value"
              :status="model.status.value"
              :progress="model.progress.value"
              :messages="chat.messages.value"
              :pending="chat.pending.value"
              :busy="chat.busy.value"
              :stale="chat.stale.value"
              @update:model="model.model.value = $event"
              @update:thinking="model.thinking.value = $event"
              @update:role="chat.setRole($event)"
              @ask="chat.ask($event)"
              @stop="chat.stop()"
              @new-chat="chat.newChat()"
            />
            <AgentsPane
              v-else-if="activeTab === 'agents'"
              :models="model.models.value"
              :model="model.model.value"
              :choice="model.choice.value"
              :thinking="model.thinking.value"
              :status="model.status.value"
              :progress="model.progress.value"
              :team="agents.team.value"
              :team-is-default="agents.teamIsDefault.value"
              :task="agents.task.value"
              :steps="agents.steps.value"
              :pending="agents.pending.value"
              :pending-step="agents.pendingStep.value"
              :running="agents.running.value"
              @update:model="model.model.value = $event"
              @update:thinking="model.thinking.value = $event"
              @update:task="agents.task.value = $event"
              @update:team="agents.setTeam($event)"
              @run="agents.run()"
              @stop="agents.stop()"
              @clear="agents.clear()"
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
