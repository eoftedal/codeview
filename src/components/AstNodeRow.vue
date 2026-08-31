<script setup lang="ts">
import { computed, inject } from 'vue'
import { astContextKey } from './astContext'

const props = defineProps<{ id: number }>()

const ctx = inject(astContextKey)!

const node = computed(() => ctx.tree.value.nodes[props.id]!)
const children = computed(() =>
  ctx.visible.value === null
    ? node.value.children
    : node.value.children.filter((child) => ctx.visible.value!.has(child)),
)
const isOpen = computed(() => ctx.expanded.value.has(props.id))
const isSelected = computed(() => ctx.selectedId.value === props.id)
const isDefinition = computed(() => ctx.definitionIds.value.has(props.id))
</script>

<template>
  <div class="node">
    <div
      class="row"
      :class="{ selected: isSelected, definition: isDefinition }"
      :data-node-id="id"
      :style="{ paddingLeft: `${node.depth * 13 + 6}px` }"
      @click="ctx.select(id)"
      @mouseenter="ctx.hover(id)"
      @mouseleave="ctx.hover(null)"
    >
      <button
        v-if="children.length"
        class="twisty"
        :aria-label="isOpen ? 'Collapse' : 'Expand'"
        @click.stop="ctx.toggle(id)"
      >
        <span :class="{ open: isOpen }">▸</span>
      </button>
      <span v-else class="twisty spacer" />

      <span class="kind">{{ node.kind }}</span>
      <span v-if="node.label" class="label">{{ node.label }}</span>
      <span class="range">{{ node.start }}–{{ node.end }}</span>
    </div>

    <template v-if="isOpen">
      <AstNodeRow v-for="child in children" :key="child" :id="child" />
    </template>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px 1px 0;
  cursor: default;
  white-space: nowrap;
  border-left: 2px solid transparent;
}

.row:hover {
  background: var(--row-hover);
}

.row.definition {
  border-left-color: var(--gold);
}

.row.selected {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border-left-color: var(--accent);
}

.twisty {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
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

.kind {
  color: var(--text);
}

.row.selected .kind {
  color: #fff;
}

.label {
  color: var(--gold);
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40ch;
}

.range {
  margin-left: auto;
  padding-left: 12px;
  color: var(--dim);
  font-size: 11px;
  opacity: 0;
}

.row:hover .range,
.row.selected .range {
  opacity: 0.7;
}
</style>
