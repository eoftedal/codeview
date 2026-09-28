<script setup lang="ts">
/**
 * The prompt box both panes ask through: a textarea that completes `@` into the name of an open
 * file.
 *
 * One component rather than two, because the two boxes must agree about what a tag *is*. A
 * question and a task are narrowed by the same rule (`mentions.ts`), and a composer that completed
 * to a name the parser would not then resolve would be worse than no completion at all.
 *
 * The parse is `mentionAt` and the ranking is `quickOpen`'s — the same subsequence matcher the
 * Cmd+P palette uses, so `@slb` finds `src/lib/base.ts` here exactly as it does there. A reader
 * has one gesture for naming a file in this app, not two.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { applyMention, mentionAt } from '../lib/mentions'
import { quickOpen, segmentsFor } from '../lib/quickOpen'

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** The open files by name, the one on screen first — what an untyped `@` lists. */
    files: readonly string[]
    placeholder?: string
    rows?: number
    disabled?: boolean
  }>(),
  { placeholder: '', rows: 2, disabled: false },
)

const emit = defineEmits<{
  'update:modelValue': [string]
  /** Enter with no completion list open — what the pane treats as "ask" or "run". */
  submit: []
}>()

/** How many completions are worth showing above a two-row box. Past this the list is a palette,
 *  and the palette is Cmd+P. */
const MAX_ROWS = 7

const el = ref<HTMLTextAreaElement>()
const caret = ref(0)
/** Escape closes the list without closing the box. It stays closed until the reader starts a
 *  *different* tag, since re-opening on the next keystroke would make Escape a flicker. */
const dismissed = ref(false)
const index = ref(0)

const token = computed(() => mentionAt(props.modelValue, caret.value))

watch(
  () => token.value?.start ?? -1,
  () => (dismissed.value = false),
)
watch(
  () => token.value?.query ?? '',
  () => (index.value = 0),
)

const matches = computed(() => {
  const at = token.value
  if (!at || dismissed.value) return []
  return quickOpen(
    props.files.map((name) => ({ name })),
    at.query,
  ).slice(0, MAX_ROWS)
})

function syncCaret(): void {
  caret.value = el.value?.selectionStart ?? 0
}

/** Coming back to a half-typed tag offers the list again: the reader left it mid-name, and the
 *  `dismissed` latch is for Escape, not for having looked away. */
function onFocus(): void {
  dismissed.value = false
  syncCaret()
}

function onInput(event: Event): void {
  const area = event.target as HTMLTextAreaElement
  caret.value = area.selectionStart
  emit('update:modelValue', area.value)
}

function move(by: number): void {
  const count = matches.value.length
  if (count === 0) return
  index.value = (index.value + by + count) % count
}

/** Complete the tag being typed, and leave the caret after it — the reader is mid-sentence, not
 *  mid-dialog. */
async function choose(name: string): Promise<void> {
  const at = token.value
  if (!at) return
  const next = applyMention(props.modelValue, at.start, name)
  emit('update:modelValue', next.text)
  await nextTick()
  const area = el.value
  if (!area) return
  // The parent owns the value, so the DOM may still hold the old one on this tick.
  area.value = next.text
  area.setSelectionRange(next.caret, next.caret)
  caret.value = next.caret
  area.focus()
}

/**
 * One handler rather than a row of `@keydown.enter.prevent` modifiers, because every key here is
 * conditional: Enter picks a completion while the list is open and asks the question while it is
 * not, and a modifier cannot say "only when".
 */
function onKeydown(event: KeyboardEvent): void {
  // Enter while an IME is composing belongs to the IME, and so does everything else.
  if (event.isComposing) return

  if (matches.value.length > 0) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        return move(1)
      case 'ArrowUp':
        event.preventDefault()
        return move(-1)
      case 'Enter':
      case 'Tab':
        event.preventDefault()
        void choose(matches.value[index.value]!.file.name)
        return
      case 'Escape':
        // Not `stopPropagation`: nothing above listens for it, and swallowing it would make the
        // key mean something different in this box than everywhere else.
        event.preventDefault()
        dismissed.value = true
        return
    }
  }

  // Shift+Enter is a newline, plain Enter asks — the way every other chat box behaves.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    emit('submit')
  }
}

defineExpose({ focus: () => el.value?.focus() })
</script>

<template>
  <div class="mention-box">
    <!-- Above the box, not below it: the box sits at the bottom of a pane, and a list dropped
         downwards would be off the window. -->
    <ul v-if="matches.length" class="mentions" role="listbox">
      <li
        v-for="(match, row) in matches"
        :key="match.file.name"
        class="mention"
        :class="{ armed: row === index }"
        role="option"
        :aria-selected="row === index"
        @mousedown.prevent="choose(match.file.name)"
        @mouseenter="index = row"
      >
        <span
          v-for="(segment, at) in segmentsFor(match.file.name, match.hits)"
          :key="at"
          :class="{ hit: segment.hit, dir: segment.dim }"
          >{{ segment.text }}</span
        >
      </li>
    </ul>

    <textarea
      ref="el"
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="syncCaret"
      @click="syncCaret"
      @select="syncCaret"
      @blur="dismissed = true"
      @focus="onFocus"
    />
  </div>
</template>

<style scoped>
.mention-box {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
}

textarea {
  flex: 1;
  min-width: 0;
  resize: none;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  padding: 6px 8px;
}

textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.mentions {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  margin: 0;
  padding: 3px;
  list-style: none;
  max-height: 40vh;
  overflow-y: auto;
  scrollbar-width: thin;
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 6px;
  box-shadow: 0 10px 28px #000000aa;
}

.mention {
  padding: 4px 7px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention.armed {
  background: var(--row-hover);
  box-shadow: inset 2px 0 0 var(--accent);
}

/* The matched characters, marked the way the palette marks them — a tint and an underline. */
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
</style>
