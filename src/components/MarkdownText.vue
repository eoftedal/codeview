<script setup lang="ts">
import { computed } from 'vue'
import MarkdownSpans from './MarkdownSpans.vue'
import { parseMarkdown } from '../lib/markdown'

const props = defineProps<{
  text: string
  /** Still streaming: the caret sits at the end of whatever the last block is so far. */
  streaming?: boolean
}>()

const blocks = computed(() => parseMarkdown(props.text))
</script>

<template>
  <div class="md" :class="{ streaming }">
    <template v-for="(block, index) in blocks" :key="index">
      <pre v-if="block.kind === 'code'" class="code"><code>{{ block.text }}</code></pre>

      <details v-else-if="block.kind === 'think'" class="think">
        <summary>thinking</summary>
        <MarkdownText :text="block.text" />
      </details>

      <component :is="`h${block.level}`" v-else-if="block.kind === 'heading'">
        <MarkdownSpans :spans="block.spans" />
      </component>

      <ol v-else-if="block.kind === 'list' && block.ordered" :start="block.start">
        <li
          v-for="(item, itemIndex) in block.items"
          :key="itemIndex"
          :style="{ marginLeft: `${item.depth * 14}px` }"
        >
          <MarkdownSpans :spans="item.spans" />
        </li>
      </ol>

      <ul v-else-if="block.kind === 'list'">
        <li
          v-for="(item, itemIndex) in block.items"
          :key="itemIndex"
          :style="{ marginLeft: `${item.depth * 14}px` }"
        >
          <MarkdownSpans :spans="item.spans" />
        </li>
      </ul>

      <blockquote v-else-if="block.kind === 'quote'">
        <MarkdownSpans :spans="block.spans" />
      </blockquote>

      <hr v-else-if="block.kind === 'rule'" />

      <!-- Wrapped so a wide table scrolls on its own rather than widening the bubble. -->
      <div v-else-if="block.kind === 'table'" class="table">
        <table>
          <thead>
            <tr>
              <th
                v-for="(cell, cellIndex) in block.header"
                :key="cellIndex"
                :style="{ textAlign: block.align[cellIndex] ?? undefined }"
              >
                <MarkdownSpans :spans="cell" />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
              <td
                v-for="(cell, cellIndex) in row"
                :key="cellIndex"
                :style="{ textAlign: block.align[cellIndex] ?? undefined }"
              >
                <MarkdownSpans :spans="cell" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-else><MarkdownSpans :spans="block.spans" /></p>
    </template>
  </div>
</template>

<style scoped>
/* The bubble around this sets `pre-wrap`, which would otherwise inherit into every block. */
.md {
  white-space: normal;
  /* A grid or flex item is `min-width: auto` by default, which means "at least as wide as my
     content" — and a `pre` that does not wrap has a min-content width of its longest line. Without
     this the column grows to fit the code and the whole pane scrolls sideways; with it the column
     keeps the reader's width and the code block scrolls inside itself. */
  min-width: 0;
}

.md > * {
  margin: 0 0 8px;
}

.md > :last-child {
  margin-bottom: 0;
}

/* Soft line breaks inside a paragraph are usually meant, in an answer about numbered lines. */
p,
blockquote {
  white-space: pre-line;
  overflow-wrap: anywhere;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  font-size: 1em;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.01em;
}

ul,
ol {
  padding-left: 20px;
}

li {
  margin: 2px 0;
  overflow-wrap: anywhere;
}

/* Both of the blocks that can be wider than the pane: they scroll inside their own box, and
   `max-width` is what stops them widening it in the first place. */
.code,
.table {
  max-width: 100%;
}

.code {
  margin: 0 0 8px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  overflow-x: auto;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.55;
}

blockquote {
  border-left: 2px solid var(--border);
  padding-left: 8px;
  color: var(--dim);
}

hr {
  border: 0;
  border-top: 1px solid var(--border);
}

.table {
  overflow-x: auto;
}

/* A wide table's own box must not be stretched by the row inside it either. */
table {
  max-width: none;
}

table {
  border-collapse: collapse;
  font-size: 12px;
  line-height: 1.4;
}

th,
td {
  padding: 3px 8px;
  border: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

th {
  font-weight: 600;
  background: var(--panel);
}

/* Reasoning is folded away: it is how the answer was reached, not the answer. */
.think {
  border-left: 2px solid var(--border);
  padding-left: 8px;
  color: var(--dim);
  font-size: 12px;
}

.think summary {
  cursor: pointer;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-size: 10px;
}

.think :deep(.md) {
  margin-top: 6px;
}

/* A thinking block stays collapsed while it fills, so the caret goes on the summary — otherwise
   a model that reasons for a while looks like a model that has stopped. */
.streaming > details.think:last-child > summary::after,
.streaming > :last-child:not(.think)::after {
  content: '';
  display: inline-block;
  width: 6px;
  height: 12px;
  margin-left: 3px;
  vertical-align: -1px;
  background: var(--accent);
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
