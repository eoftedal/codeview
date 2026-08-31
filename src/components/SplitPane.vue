<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Left pane width as a fraction of the container. */
    modelValue: number
    min?: number
    max?: number
  }>(),
  { min: 0.2, max: 0.85 },
)

const emit = defineEmits<{ 'update:modelValue': [number] }>()

const container = ref<HTMLElement>()
const dragging = ref(false)

function clamp(ratio: number): number {
  return Math.min(props.max, Math.max(props.min, ratio))
}

function onPointerDown(event: PointerEvent): void {
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  dragging.value = true
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value || !container.value) return
  const bounds = container.value.getBoundingClientRect()
  emit('update:modelValue', clamp((event.clientX - bounds.left) / bounds.width))
}

function onPointerUp(event: PointerEvent): void {
  ;(event.target as HTMLElement).releasePointerCapture(event.pointerId)
  dragging.value = false
}

/** Keyboard resizing, so the divider isn't pointer-only. */
function onKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 0.1 : 0.02
  if (event.key === 'ArrowLeft') emit('update:modelValue', clamp(props.modelValue - step))
  else if (event.key === 'ArrowRight') emit('update:modelValue', clamp(props.modelValue + step))
  else return
  event.preventDefault()
}
</script>

<template>
  <div ref="container" class="split" :class="{ dragging }">
    <div class="pane" :style="{ width: `${modelValue * 100}%` }">
      <slot name="left" />
    </div>
    <div
      class="divider"
      role="separator"
      aria-orientation="vertical"
      :aria-valuenow="Math.round(modelValue * 100)"
      tabindex="0"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
    />
    <div class="pane grow">
      <slot name="right" />
    </div>
  </div>
</template>

<style scoped>
.split {
  display: flex;
  min-height: 0;
  height: 100%;
}

.pane {
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

.grow {
  flex: 1;
}

.divider {
  flex: 0 0 auto;
  width: 7px;
  cursor: col-resize;
  background: var(--border);
  position: relative;
  transition: background 120ms ease;
}

.divider::after {
  content: '';
  position: absolute;
  inset: 0 2px;
  border-radius: 2px;
  background: var(--panel);
}

.divider:hover,
.divider:focus-visible,
.dragging .divider {
  background: var(--accent);
  outline: none;
}

/* While dragging, the iframe-free editor still swallows pointer moves without this. */
.dragging .pane {
  pointer-events: none;
  user-select: none;
}
</style>
