<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from 'vue'
import AstNodeRow from './AstNodeRow.vue'
import { astContextKey } from './astContext'
import { pathToRoot, type AstTree } from '../lib/astTree'
import type { DefinitionResult } from '../lib/definitions'

const props = defineProps<{
  tree: AstTree
  selectedId: number | null
  definition: DefinitionResult | null
  /** Which pane drove the current selection — only an editor-driven one scrolls the tree. */
  origin: 'editor' | 'tree'
  showTokens: boolean
}>()

const emit = defineEmits<{
  select: [number]
  hover: [number | null]
  revealDefinition: []
  'update:showTokens': [boolean]
}>()

const INITIAL_DEPTH = 2

const body = ref<HTMLElement>()
const filter = ref('')
const expanded = ref<Set<number>>(new Set())

/** Ids that match the filter, plus every ancestor needed to reach them. */
const matches = computed<{ visible: Set<number>; open: Set<number> } | null>(() => {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return null

  const visible = new Set<number>()
  const open = new Set<number>()
  for (const node of props.tree.nodes) {
    const hit =
      node.kind.toLowerCase().includes(needle) || node.label?.toLowerCase().includes(needle)
    if (!hit) continue
    visible.add(node.id)
    for (const ancestor of pathToRoot(props.tree, node.id)) {
      visible.add(ancestor)
      open.add(ancestor)
    }
  }
  return { visible, open }
})

const visible = computed(() => matches.value?.visible ?? null)

const effectiveExpanded = computed(() => {
  if (!matches.value) return expanded.value
  return new Set([...expanded.value, ...matches.value.open])
})

/** Rows whose range is exactly the highlighted definition, marked with a gold edge. */
const definitionIds = computed(() => {
  const ids = new Set<number>()
  const definition = props.definition
  if (!definition) return ids
  for (const node of props.tree.nodes) {
    if (node.start === definition.primary.start && node.end === definition.primary.end) {
      ids.add(node.id)
    }
  }
  return ids
})

const breadcrumb = computed(() => {
  if (props.selectedId === null) return []
  const path = [...pathToRoot(props.tree, props.selectedId), props.selectedId]
  return path.slice(-3).map((id) => ({ id, kind: props.tree.nodes[id]!.kind }))
})

const nodeCount = computed(() => props.tree.nodes.length)

function toggle(id: number): void {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

function expandAll(): void {
  expanded.value = new Set(
    props.tree.nodes.filter((node) => node.children.length > 0).map((node) => node.id),
  )
}

function collapseAll(): void {
  expanded.value = new Set([props.tree.root])
}

function expandInitial(): void {
  expanded.value = new Set(
    props.tree.nodes
      .filter((node) => node.children.length > 0 && node.depth < INITIAL_DEPTH)
      .map((node) => node.id),
  )
}

expandInitial()
watch(
  () => props.tree,
  () => {
    if (expanded.value.size === 0) expandInitial()
  },
)

// Reveal the selection: open its ancestors, then bring the row into view — but only when the
// editor drove it, otherwise clicking a row would fight the click.
watch(
  () => [props.selectedId, props.tree] as const,
  async ([id]) => {
    if (id === null) return
    const ancestors = pathToRoot(props.tree, id)
    if (ancestors.some((ancestor) => !expanded.value.has(ancestor))) {
      expanded.value = new Set([...expanded.value, ...ancestors])
    }
    if (props.origin !== 'editor') return
    await nextTick()
    body.value
      ?.querySelector(`[data-node-id="${id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  },
)

provide(astContextKey, {
  tree: computed(() => props.tree),
  expanded: effectiveExpanded,
  visible,
  selectedId: computed(() => props.selectedId),
  definitionIds,
  toggle,
  select: (id) => emit('select', id),
  hover: (id) => emit('hover', id),
})
</script>

<template>
  <section class="ast-pane">
    <header>
      <div class="toolbar">
        <input v-model="filter" class="filter" type="search" placeholder="Filter by kind or text" />
        <label class="toggle">
          <input
            type="checkbox"
            :checked="showTokens"
            @change="emit('update:showTokens', ($event.target as HTMLInputElement).checked)"
          />
          Tokens
        </label>
        <button @click="expandAll">Expand</button>
        <button @click="collapseAll">Collapse</button>
      </div>

      <div class="status">
        <nav v-if="breadcrumb.length" class="crumbs">
          <template v-for="(crumb, index) in breadcrumb" :key="crumb.id">
            <span v-if="index" class="sep">›</span>
            <button class="crumb" @click="emit('select', crumb.id)">{{ crumb.kind }}</button>
          </template>
        </nav>
        <span v-else class="crumbs muted">No node selected</span>

        <button v-if="definition" class="definition" @click="emit('revealDefinition')">
          <span class="dot" />
          defined as {{ definition.label }} · line {{ definition.line }}
        </button>
        <span v-else class="definition muted">no definition in this file</span>
      </div>
    </header>

    <div ref="body" class="body" @mouseleave="emit('hover', null)">
      <AstNodeRow v-if="visible === null || visible.has(tree.root)" :id="tree.root" />
      <p v-else class="empty">Nothing matches “{{ filter }}”.</p>
    </div>

    <footer>{{ nodeCount.toLocaleString() }} nodes</footer>
  </section>
</template>

<style scoped>
.ast-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
  border-left: 1px solid var(--border);
}

header {
  border-bottom: 1px solid var(--border);
  padding: 8px 10px;
  display: grid;
  /* minmax(0, 1fr), not 1fr: an auto-min track would size to the widest row's max-content and
     push the toolbar past the pane edge. */
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

.toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.filter {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 9px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
}

.filter:focus-visible {
  outline: 1px solid var(--accent);
  border-color: var(--accent);
}

.toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--dim);
  user-select: none;
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
}

button:hover {
  color: var(--text);
  border-color: var(--accent);
}

.status {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  min-height: 20px;
  min-width: 0;
}

.crumbs {
  display: flex;
  align-items: baseline;
  gap: 4px;
  overflow: hidden;
  min-width: 0;
  flex: 1;
}

.crumb {
  border: 0;
  background: none;
  padding: 0;
  color: var(--dim);
  font-size: 12px;
}

.crumb:hover {
  color: var(--accent);
  border: 0;
}

.crumbs .sep {
  color: var(--border);
}

.crumbs > :last-child {
  color: var(--text);
}

.definition {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: none;
  padding: 0;
  white-space: nowrap;
  color: var(--gold);
  flex: 0 0 auto;
}

.definition:hover {
  border: 0;
  text-decoration: underline;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gold);
}

.muted {
  color: var(--dim);
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
  padding: 20px;
  color: var(--dim);
  text-align: center;
}

footer {
  border-top: 1px solid var(--border);
  padding: 5px 10px;
  font-size: 11px;
  color: var(--dim);
}
</style>
