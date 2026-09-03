<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from 'vue'
import type { Language } from '../lib/analyzer'
import type { CodeFile } from '../lib/files'

const props = defineProps<{
  files: readonly CodeFile[]
  activeId: string
}>()

const emit = defineEmits<{
  select: [string]
  close: [string]
  rename: [id: string, name: string]
  add: []
}>()

/** Stands in for VS Code's file icons — the language, in the colour the editor tints it. */
const BADGE: Record<Language, string> = { ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX' }

/** There is always a buffer, so the last tab has no close button rather than an empty editor. */
const closable = () => props.files.length > 1

const menu = ref<{ id: string; x: number; y: number } | null>(null)
const renaming = ref<string | null>(null)
const draft = ref('')

function openMenu(id: string, event: MouseEvent): void {
  menu.value = { id, x: event.clientX, y: event.clientY }
}

function closeMenu(): void {
  menu.value = null
}

/** No sidebar to rename from, so the tab itself is the handle: right-click, then edit in place. */
function startRename(id: string): void {
  const file = props.files.find((open) => open.id === id)
  if (!file) return
  closeMenu()
  renaming.value = id
  draft.value = file.name
}

/** Which tab's rename field has already been focused, since Vue re-invokes a function ref on
 *  every patch — refocusing on each keystroke would drag the selection along with it. */
let focused: string | null = null

/** A function ref, not a named one: inside `v-for` Vue collects named refs into an array. */
function focusRename(el: Element | ComponentPublicInstance | null): void {
  const field = el as HTMLInputElement | null
  if (!field) {
    focused = null
    return
  }
  if (focused === renaming.value) return
  focused = renaming.value
  // After the flush: `v-model` writes the value back in its own mounted hook, which would drop
  // any selection set before it.
  void nextTick(() => {
    field.focus()
    // Select the stem and leave the extension — a rename is almost always about the name.
    const dot = draft.value.lastIndexOf('.')
    field.setSelectionRange(0, dot > 0 ? dot : draft.value.length)
  })
}

function commitRename(): void {
  const id = renaming.value
  renaming.value = null
  if (id) emit('rename', id, draft.value)
}

function cancelRename(): void {
  renaming.value = null
}

/** The menu swallows its own clicks, so it has to take itself down. */
function closeFromMenu(): void {
  const id = menu.value?.id
  closeMenu()
  if (id) emit('close', id)
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu()
}

onMounted(() => {
  window.addEventListener('click', closeMenu)
  window.addEventListener('resize', closeMenu)
  window.addEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeMenu)
  window.removeEventListener('resize', closeMenu)
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <div class="file-tabs">
    <div class="strip" role="tablist">
      <div
        v-for="file in files"
        :key="file.id"
        class="tab"
        :class="{ active: file.id === activeId }"
        role="tab"
        :aria-selected="file.id === activeId"
        :title="file.name"
        @click="emit('select', file.id)"
        @contextmenu.prevent.stop="openMenu(file.id, $event)"
        @auxclick.middle.prevent="closable() && emit('close', file.id)"
      >
        <span class="badge" :class="`lang-${file.language}`">{{ BADGE[file.language] }}</span>
        <input
          v-if="renaming === file.id"
          :ref="focusRename"
          v-model="draft"
          class="rename"
          spellcheck="false"
          @click.stop
          @contextmenu.stop
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
        <span v-else class="file-name">{{ file.name }}</span>
        <button
          v-if="closable()"
          class="close"
          type="button"
          :aria-label="`Close ${file.name}`"
          title="Close"
          @click.stop="emit('close', file.id)"
        >
          ✕
        </button>
      </div>
    </div>

    <button class="add" type="button" aria-label="New file" title="New file" @click="emit('add')">
      +
    </button>

    <div v-if="menu" class="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button type="button" @click.stop="startRename(menu.id)">Rename…</button>
      <button type="button" :disabled="!closable()" @click.stop="closeFromMenu">Close</button>
    </div>
  </div>
</template>

<style scoped>
.file-tabs {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

/* Content-width until the tabs run out of room, so `+` sits just after the last tab rather than
   marooned at the far edge — then it pins to the right and the strip scrolls under it. */
.strip {
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  overflow-x: auto;
  scrollbar-width: thin;
}

.tab {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: 220px;
  padding: 6px 8px 6px 10px;
  border-right: 1px solid var(--border);
  color: var(--dim);
  cursor: pointer;
  user-select: none;
}

.tab:hover {
  background: var(--row-hover);
}

.tab.active {
  background: var(--bg);
  color: var(--text);
  /* Reads as the selected tab without the whole strip shifting a pixel. */
  box-shadow: inset 0 -2px 0 var(--accent);
}

.badge {
  flex: 0 0 auto;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.lang-ts,
.lang-tsx {
  color: var(--accent);
}

.lang-js,
.lang-jsx {
  color: var(--gold);
}

.file-name {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rename {
  width: 13ch;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 3px;
  color: var(--text);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  padding: 1px 4px;
  outline: none;
}

.close,
.add {
  flex: 0 0 auto;
  background: none;
  border: 0;
  border-radius: 3px;
  color: var(--dim);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 3px 5px;
  cursor: pointer;
}

.close {
  opacity: 0;
}

.tab:hover .close,
.tab.active .close {
  opacity: 1;
}

.close:hover,
.add:hover {
  background: #ffffff14;
  color: var(--text);
}

.add {
  align-self: center;
  margin: 0 6px;
  font-size: 15px;
  padding: 1px 7px 3px;
}

.menu {
  position: fixed;
  z-index: 20;
  min-width: 130px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 22px #00000066;
}

.menu button {
  background: none;
  border: 0;
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  padding: 5px 9px;
  cursor: pointer;
}

.menu button:hover:not(:disabled) {
  background: var(--accent);
  color: #0b0f16;
}

.menu button:disabled {
  color: var(--dim);
  cursor: default;
}
</style>
