<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, watch } from 'vue'
import TraceRow from './TraceRow.vue'
import { traceContextKey } from './traceContext'
import { isExternalOrigin, type FlowTarget, type FlowTrace } from '../lib/flow'
import { traceToText } from '../lib/traceText'

const props = defineProps<{
  trace: FlowTrace | null
  /** Label of the value under the cursor — what the run button would trace, not what it did. */
  target: string | null
  /** The tab on screen. A step in another file is labelled with its own, and selecting it opens
   *  that tab. */
  activeFile: string
  /** False on a language with no backward trace. The pane then explains itself rather than
   *  offering a button that would do nothing. */
  supported: boolean
}>()

const emit = defineEmits<{
  run: []
  select: [FlowTarget]
  hover: [FlowTarget | null]
  /** Hand this trace to the chat: the question and the files it cites. */
  analyze: []
  /** The same, to a line of agents instead of one conversation. */
  analyzeWithAgents: []
}>()

const expanded = ref<Set<number>>(new Set())
const selectedId = ref<number | null>(null)

/**
 * The copy button's own feedback, where the reader's finger already is — rather than the app's
 * notice line at the top of the window, which is where the share link says so because a share
 * link is copied from up there. `blocked` is the embedded case: a page in an iframe without
 * `clipboard-write` is refused, and saying nothing would read as a button that does nothing.
 */
const copied = ref<'done' | 'blocked' | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

function flash(state: 'done' | 'blocked'): void {
  copied.value = state
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = null), 2000)
}

/**
 * The trace as text, for pasting into the chat or an agent's task — which is what it is for, and
 * why every step names its own file and line even though the pane on screen does not.
 *
 * The *whole* trace, whatever is folded away: collapsing is how a reader reads a large one, not a
 * statement about which steps matter.
 */
async function copy(): Promise<void> {
  if (!props.trace) return
  try {
    await navigator.clipboard.writeText(traceToText(props.trace))
    flash('done')
  } catch {
    flash('blocked')
  }
}

onBeforeUnmount(() => clearTimeout(copiedTimer))

// Traces are small and the whole point is seeing the path, so open everything by default.
watch(
  () => props.trace,
  (trace) => {
    expanded.value = new Set(trace ? trace.nodes.map((node) => node.id) : [])
    selectedId.value = null
    // A new trace is not the one that was copied.
    copied.value = null
  },
  { immediate: true },
)

const summary = computed(() => {
  const trace = props.trace
  if (!trace) return null
  const steps = trace.nodes.length
  const external = trace.externalCount
  const files = new Set(trace.nodes.map((node) => node.file)).size
  return {
    steps: `${steps} ${steps === 1 ? 'step' : 'steps'}`,
    // Worth saying out loud: a path that leaves the file on screen is the one you most want to
    // know about, and half of it is not visible in the editor.
    files: files > 1 ? `${files} files` : null,
    external: `${external} external ${external === 1 ? 'source' : 'sources'}`,
    hasExternal: external > 0,
    truncated: trace.truncated,
  }
})

function toggle(id: number): void {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

function select(id: number): void {
  const node = props.trace?.nodes[id]
  if (!node) return
  selectedId.value = id
  emit('select', { span: node.span, file: node.file })
}

function expandAll(): void {
  expanded.value = new Set(props.trace?.nodes.map((node) => node.id) ?? [])
}

function collapseAll(): void {
  expanded.value = new Set(props.trace ? [props.trace.root] : [])
}

/** Jump straight to the first origin outside the buffer — usually the reason you ran the trace. */
function revealFirstExternal(): void {
  const found = props.trace?.nodes.find((node) => isExternalOrigin(node.origin))
  if (found) select(found.id)
}

provide(traceContextKey, {
  // Guarded by v-if in the template: rows only render when a trace exists.
  trace: computed(() => props.trace!),
  activeFile: computed(() => props.activeFile),
  expanded,
  selectedId,
  toggle,
  select,
  hover: (target) => emit('hover', target),
})
</script>

<template>
  <section class="trace-pane">
    <header>
      <div class="toolbar">
        <!-- Always "Trace": the button acts on whatever is under the cursor now, which is rarely
             what the trace on screen was run from, and "Retrace" claimed otherwise. -->
        <button class="run" :disabled="!supported" @click="emit('run')">
          Trace<span v-if="target"> {{ target }}</span>
        </button>
        <template v-if="trace">
          <button @click="expandAll">Expand</button>
          <button @click="collapseAll">Collapse</button>
        </template>
      </div>

      <div class="status">
        <span v-if="summary" class="counts">
          {{ summary.steps }}
          <template v-if="summary.files">
            <span class="sep">·</span>
            <span class="across">{{ summary.files }}</span>
          </template>
          <span class="sep">·</span>
          <button
            v-if="summary.hasExternal"
            class="external"
            @click="revealFirstExternal"
            title="Jump to the first origin outside the open files"
          >
            <span class="dot" />
            {{ summary.external }}
          </button>
          <span v-else class="muted">nothing external</span>
          <span v-if="summary.truncated" class="sep">·</span>
          <span v-if="summary.truncated" class="muted">stopped at the budget</span>
        </span>
        <span v-else class="counts muted">no trace yet</span>
      </div>
    </header>

    <div class="body" @mouseleave="emit('hover', null)">
      <TraceRow v-if="trace" :id="trace.root" :depth="0" />
      <!-- Every language shipped today has a trace, so this branch is unreachable — and it stays,
           because it is what a language added without one shows instead of an empty pane. -->
      <p v-else-if="!supported" class="empty">
        This language has <strong>no backward trace</strong>.
        <br />
        Following a value needs every place a name is written and every place a function is called,
        and neither is available here. Guessing at it would quietly miss paths — worse than not
        offering it at all.
        <br />
        The syntax tree and the definition highlight work as normal.
      </p>
      <p v-else class="empty">
        Put the cursor on a value and press <strong>Trace</strong> — or <kbd>Alt</kbd>+<kbd>T</kbd>
        in the editor.
        <br />
        Every assignment, return value and call-site argument is followed back — across the open
        files, wherever an import leads — until the value reaches a constant or something no open
        file can see.
      </p>
    </div>

    <!-- Below the trace rather than beside the Trace button, because these two act on what is on
         screen: you read the path first and then do something with it. -->
    <div v-if="trace" class="actions">
      <button
        class="copy"
        :class="{ done: copied === 'done', blocked: copied === 'blocked' }"
        title="Copy the whole trace as text — every step with its file and line — to paste into a chat or an agent’s task"
        @click="copy"
      >
        {{ copied === 'done' ? 'Copied' : copied === 'blocked' ? 'Blocked' : 'Copy' }}
      </button>
      <button
        class="analyze"
        title="Start a new chat about this trace, over the files it cites"
        @click="emit('analyze')"
      >
        Analyze this trace
      </button>
      <button
        class="analyze agents"
        title="Run the agents over this trace, over the files it cites"
        @click="emit('analyzeWithAgents')"
      >
        Analyze with agents
      </button>
    </div>

    <footer v-if="supported">
      Shows every path that <em>could</em> reach the value — no aliasing, no path sensitivity.
    </footer>
  </section>
</template>

<style scoped>
.trace-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
}

header {
  border-bottom: 1px solid var(--border);
  padding: 8px 10px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

.toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

button {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--dim);
  border-radius: 6px;
  padding: 5px 9px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

button:hover {
  color: var(--text);
  border-color: var(--accent);
}

.run {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  /* The one button whose width is the buffer's to decide — a traced name can be long, and with
     four buttons in the row it is what has to give. The rest keep their labels whole. */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolbar button:not(.run) {
  flex: none;
}

.run span {
  /* A margin, not a space in the template: Vue condenses whitespace-only text away. */
  margin-left: 5px;
  color: var(--dim);
}

.status {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-size: 12px;
  min-height: 20px;
  min-width: 0;
}

.counts {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dim);
  min-width: 0;
}

.sep {
  color: var(--border);
}

.across {
  color: var(--accent);
}

.external {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: none;
  padding: 0;
  color: var(--danger);
}

.external:hover {
  border: 0;
  color: var(--danger);
  text-decoration: underline;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
}

.muted {
  opacity: 0.65;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 0 20px;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
}

.actions {
  border-top: 1px solid var(--border);
  padding: 8px 10px;
  display: flex;
  gap: 6px;
  align-items: center;
}

.analyze {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  /* These two give way when the pane is narrow: their labels are the long ones, and "Copy"
     truncated to nothing would be a button with no word on it at all. */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The second reading of the same trace, by several models instead of one — a quieter border says
   so without making it a different kind of thing. */
.analyze.agents {
  border-color: var(--border);
}

.analyze.agents:hover {
  border-color: var(--accent);
}

.actions .copy {
  flex: none;
}

.copy.done {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}

/* The clipboard refused — an embedded page without `clipboard-write`. Said in the button rather
   than swallowed, since the alternative reads as a button that does nothing. */
.copy.blocked {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 50%, transparent);
}

.run:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.empty {
  padding: 24px 20px;
  margin: 0;
  color: var(--dim);
  text-align: center;
  line-height: 1.7;
  font-family: 'Inter', sans-serif;
}

.empty strong {
  color: var(--text);
  font-weight: 500;
}

.empty kbd {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  background: var(--bg);
}

footer {
  border-top: 1px solid var(--border);
  padding: 5px 10px;
  font-size: 11px;
  color: var(--dim);
}
</style>
