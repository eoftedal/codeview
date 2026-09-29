<script setup lang="ts">
/**
 * Quick open: Cmd+P, type, Enter. The palette is mounted only while it is showing, which is what
 * lets the query and the highlighted row live here rather than in `App.vue` — there is no state to
 * preserve once it closes, and starting empty every time is the behaviour anyway.
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import type { CodeFile } from '../lib/files'
import { quickOpen, segmentsFor } from '../lib/quickOpen'

const props = defineProps<{
  /** The open files, most recently shown first — the order an untyped palette lists. */
  files: CodeFile[]
}>()

const emit = defineEmits<{
  pick: [id: string]
  close: []
}>()

const BADGE: Record<CodeFile['language'], string> = {
  ts: 'TS',
  tsx: 'TSX',
  js: 'JS',
  jsx: 'JSX',
  py: 'PY',
  java: 'JAVA',
  c: 'C',
  cpp: 'C++',
  cs: 'C#',
}

const query = ref('')
const input = ref<HTMLInputElement>()
const list = ref<HTMLUListElement>()

const matches = computed(() => quickOpen(props.files, query.value))

/**
 * Which row is armed. Untyped, it is the **second** file: the first is the tab already on screen, so
 * opening the palette and pressing Enter on it would do nothing, while the one below it is the file
 * you were in before — which is what makes the gesture a toggle. Typed, it is the best match.
 */
const index = ref(props.files.length > 1 ? 1 : 0)

function onQuery(): void {
  index.value = 0
}

function move(by: number): void {
  const count = matches.value.length
  if (count === 0) return
  index.value = (index.value + by + count) % count
  // The list scrolls, so walking past its edge has to bring the row with it. `nearest` keeps the
  // list still while the armed row is already visible, which is most of the time.
  list.value?.children[index.value]?.scrollIntoView({ block: 'nearest' })
}

/** Enter on nothing does nothing: the palette stays open on a query that found no file, since the
 *  reader is mid-word far more often than they are asking to dismiss it. */
function choose(): void {
  const picked = matches.value[index.value]
  if (picked) emit('pick', picked.file.id)
}

onMounted(() => void nextTick(() => input.value?.focus()))
</script>

<template>
  <!-- The backdrop closes on a click, which is the gesture every palette has; `self` so a click
       landing on the dialog itself does not travel out here and dismiss it. -->
  <div class="quick-open" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-label="Open file">
      <input
        ref="input"
        v-model="query"
        class="query"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="Go to file…"
        aria-label="Go to file"
        @input="onQuery"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="choose"
        @keydown.esc.prevent="emit('close')"
        @keydown.tab.exact.prevent="move(1)"
        @keydown.tab.shift.prevent="move(-1)"
      />

      <ul v-if="matches.length" ref="list" class="results" role="listbox">
        <li
          v-for="(match, row) in matches"
          :key="match.file.id"
          class="result"
          :class="{ armed: row === index }"
          role="option"
          :aria-selected="row === index"
          @click="emit('pick', match.file.id)"
          @mouseenter="index = row"
        >
          <span class="badge" :class="`lang-${match.file.language}`">
            {{ BADGE[match.file.language] }}
          </span>
          <span class="name">
            <span
              v-for="(segment, at) in segmentsFor(match.file.name, match.hits)"
              :key="at"
              :class="{ hit: segment.hit, dir: segment.dim }"
              >{{ segment.text }}</span
            >
          </span>
        </li>
      </ul>

      <p v-else class="empty">No open file matches that.</p>

      <p class="hint">↑↓ or tab to move · ↵ to open · esc to dismiss</p>
    </div>
  </div>
</template>

<style scoped>
.quick-open {
  position: fixed;
  inset: 0;
  /* Above Monaco's own layers and the tab strip's context menu. */
  z-index: 60;
  display: flex;
  justify-content: center;
  /* Near the top, where the eye already is and where the editor below stays visible. */
  align-items: flex-start;
  padding-top: 12vh;
  background: #00000055;
}

.dialog {
  width: min(560px, 90vw);
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 18px 50px #000000aa;
  overflow: hidden;
}

.query {
  flex: 0 0 auto;
  margin: 8px;
  padding: 7px 9px;
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 4px;
  color: var(--text);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  outline: none;
}

.results {
  flex: 1 1 auto;
  max-height: 46vh;
  overflow-y: auto;
  scrollbar-width: thin;
  margin: 0;
  padding: 0 4px 4px;
  list-style: none;
}

.result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 7px;
  border-radius: 4px;
  cursor: pointer;
}

.result.armed {
  background: var(--row-hover);
  box-shadow: inset 2px 0 0 var(--accent);
}

.badge {
  flex: 0 0 auto;
  width: 4ch;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.lang-ts,
.lang-tsx {
  color: var(--accent);
}

.lang-py {
  color: var(--violet);
}

.lang-java {
  color: var(--flow);
}

/* C and C++ share a grammar and a backend, so they share a colour. */
.lang-c,
.lang-cpp {
  color: var(--cyan);
}

.lang-cs {
  color: var(--teal);
}

.lang-js,
.lang-jsx {
  color: var(--gold);
}

.name {
  min-width: 0;
  color: var(--text);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The matched characters, marked the way a definition is: a tint and an underline rather than a
   box behind the text. */
.hit {
  color: var(--gold);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.dir {
  color: var(--dim);
}

.dir.hit {
  color: var(--gold);
}

.empty,
.hint {
  margin: 0;
  padding: 4px 11px 8px;
  color: var(--dim);
  font-size: 11px;
}

.hint {
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
</style>
