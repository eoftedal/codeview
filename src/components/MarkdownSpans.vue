<script setup lang="ts">
import type { Inline } from '../lib/markdown'

defineProps<{ spans: Inline[] }>()
</script>

<template>
  <template v-for="(span, index) in spans" :key="index">
    <code v-if="span.kind === 'code'">{{ span.text }}</code>
    <strong v-else-if="span.kind === 'strong'">{{ span.text }}</strong>
    <em v-else-if="span.kind === 'em'">{{ span.text }}</em>
    <a
      v-else-if="span.kind === 'link'"
      :href="span.href"
      target="_blank"
      rel="noreferrer noopener"
      >{{ span.text }}</a
    >
    <template v-else>{{ span.text }}</template>
  </template>
</template>

<style scoped>
code {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
  color: var(--gold);
  background: color-mix(in srgb, var(--gold) 10%, transparent);
  border-radius: 3px;
  padding: 0 3px;
  overflow-wrap: anywhere;
}

strong {
  color: var(--text);
  font-weight: 600;
}

em {
  font-style: italic;
}

a {
  color: var(--accent);
}
</style>
