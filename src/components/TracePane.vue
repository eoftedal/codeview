<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import TraceRow from './TraceRow.vue'
import { traceContextKey } from './traceContext'
import type { Span } from '../lib/definitions'
import { isExternalOrigin, type FlowTrace } from '../lib/flow'

const props = defineProps<{
  trace: FlowTrace | null
  /** Label of the value the trace starts from, for the run button's wording. */
  target: string | null
}>()

const emit = defineEmits<{
  run: []
  select: [Span]
  hover: [Span | null]
}>()

const expanded = ref<Set<number>>(new Set())
const selectedId = ref<number | null>(null)

// Traces are small and the whole point is seeing the path, so open everything by default.
watch(
  () => props.trace,
  (trace) => {
    expanded.value = new Set(trace ? trace.nodes.map((node) => node.id) : [])
    selectedId.value = null
  },
  { immediate: true },
)

const summary = computed(() => {
  const trace = props.trace
  if (!trace) return null
  const steps = trace.nodes.length
  const external = trace.externalCount
  return {
    steps: `${steps} ${steps === 1 ? 'step' : 'steps'}`,
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
  emit('select', node.span)
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
  expanded,
  selectedId,
  toggle,
  select,
  hover: (span) => emit('hover', span),
})
</script>

<template>
  <section class="trace-pane">
    <header>
      <div class="toolbar">
        <button class="run" @click="emit('run')">
          {{ trace ? 'Retrace' : 'Trace' }}<span v-if="target"> {{ target }}</span>
        </button>
        <template v-if="trace">
          <button @click="expandAll">Expand</button>
          <button @click="collapseAll">Collapse</button>
        </template>
      </div>

      <div class="status">
        <span v-if="summary" class="counts">
          {{ summary.steps }}
          <span class="sep">·</span>
          <button
            v-if="summary.hasExternal"
            class="external"
            @click="revealFirstExternal"
            title="Jump to the first origin outside this file"
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
      <p v-else class="empty">
        Put the cursor on a value and press <strong>Trace</strong> — or <kbd>Alt</kbd>+<kbd>T</kbd>
        in the editor.
        <br />
        Every assignment, return value and call-site argument is followed back until the value
        reaches a constant, an import, or something this file cannot see.
      </p>
    </div>

    <footer>
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
