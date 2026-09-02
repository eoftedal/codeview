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

      <p v-else><MarkdownSpans :spans="block.spans" /></p>
    </template>
  </div>
</template>

<style scoped>
/* The bubble around this sets `pre-wrap`, which would otherwise inherit into every block. */
.md {
  white-space: normal;
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

/* The caret rides the end of the last block, so it stays on the text rather than below it. */
.streaming > :last-child::after {
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
