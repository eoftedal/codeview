<script setup lang="ts">
import { computed, inject } from 'vue'
import { traceContextKey } from './traceContext'
import { isExternalOrigin, type FlowOrigin } from '../lib/flow'

const props = defineProps<{
  id: number
  /** Passed down rather than stored: a step's depth is a property of the path, not of the node. */
  depth: number
}>()

const ctx = inject(traceContextKey)!

const node = computed(() => ctx.trace.value.nodes[props.id]!)
/** A step in another tab: the line number alone would point at the wrong file. */
const elsewhere = computed(() => node.value.file !== ctx.activeFile.value)
const isOpen = computed(() => ctx.expanded.value.has(props.id))
const isSelected = computed(() => ctx.selectedId.value === props.id)
const external = computed(() => isExternalOrigin(node.value.origin))

/** What a terminal means, in the fewest words that stay honest. */
const ORIGIN_TEXT: Record<FlowOrigin, string> = {
  literal: 'defined here',
  import: 'another module',
  external: 'outside',
  entry: 'uncalled here',
  callback: 'caller supplies',
  cycle: 'seen above',
  budget: 'stopped',
}
</script>

<template>
  <div class="node">
    <div
      class="row"
      :class="{ selected: isSelected, external }"
      :data-trace-id="id"
      :style="{ paddingLeft: `${depth * 14 + 6}px` }"
      @click="ctx.select(id)"
      @mouseenter="ctx.hover({ span: node.span, file: node.file })"
      @mouseleave="ctx.hover(null)"
    >
      <button
        v-if="node.children.length"
        class="twisty"
        :aria-label="isOpen ? 'Collapse' : 'Expand'"
        @click.stop="ctx.toggle(id)"
      >
        <span :class="{ open: isOpen }">▸</span>
      </button>
      <span v-else class="twisty spacer" />

      <span class="label">{{ node.label }}</span>
      <code class="excerpt">{{ node.excerpt }}</code>
      <span v-if="node.origin" class="origin">{{ ORIGIN_TEXT[node.origin] }}</span>
      <span class="line" :class="{ elsewhere }">
        <span v-if="elsewhere" class="file">{{ node.file }}:</span>{{ node.line }}
      </span>
    </div>

    <template v-if="isOpen">
      <TraceRow v-for="child in node.children" :key="child" :id="child" :depth="depth + 1" />
    </template>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 8px 2px 0;
  cursor: default;
  white-space: nowrap;
  border-left: 2px solid transparent;
}

.row:hover {
  background: var(--row-hover);
}

.row.selected {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border-left-color: var(--accent);
}

.row.external {
  border-left-color: var(--danger);
}

.twisty {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  align-self: center;
  display: grid;
  place-items: center;
  border: 0;
  padding: 0;
  background: none;
  color: var(--dim);
  font-size: 9px;
  cursor: pointer;
}

.twisty span {
  transition: transform 120ms ease;
}

.twisty span.open {
  transform: rotate(90deg);
}

.spacer {
  cursor: default;
}

.label {
  flex: 0 0 auto;
  color: var(--dim);
}

.row.external .label {
  color: var(--danger);
}

.excerpt {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  font-family: inherit;
}

.origin {
  flex: 0 0 auto;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--dim);
}

.row.external .origin {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
}

.line {
  flex: 0 0 auto;
  min-width: 2ch;
  text-align: right;
  color: var(--dim);
  font-size: 11px;
  opacity: 0.55;
}

/* A step in another tab earns full contrast: it is the part of the path you cannot see. */
.line.elsewhere {
  opacity: 1;
}

.file {
  color: var(--accent);
}
</style>
