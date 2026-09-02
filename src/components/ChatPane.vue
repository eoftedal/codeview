<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import MarkdownText from './MarkdownText.vue'
import type { ChatMessage, ChatStatus } from '../composables/useChat'

const props = defineProps<{
  status: ChatStatus
  progress: number
  messages: ChatMessage[]
  /** The answer streaming in right now, if any. */
  pending: string
  busy: boolean
  stale: boolean
}>()

const emit = defineEmits<{
  ask: [string]
  stop: []
  newChat: []
}>()

const PROMPTS = [
  'What are the sources and sinks in this file?',
  'Does any untrusted input reach a sink unsanitised?',
  'Review this file for security problems.',
]

const draft = ref('')
const body = ref<HTMLElement>()

const statusLabel = computed(() => {
  switch (props.status) {
    case 'checking':
      return 'looking for an on-device model…'
    case 'downloadable':
      return 'model downloads on the first question'
    case 'downloading':
      return `downloading the model… ${Math.round(props.progress * 100)}%`
    default:
      return props.busy ? 'thinking…' : 'on-device model ready'
  }
})

function send(question: string = draft.value): void {
  if (props.busy || !question.trim()) return
  draft.value = ''
  emit('ask', question)
}

function onEnter(event: KeyboardEvent): void {
  // Shift+Enter is a newline; plain Enter asks, the way every other chat box behaves. Enter while
  // an IME is composing belongs to the IME.
  if (event.shiftKey || event.isComposing) return
  event.preventDefault()
  send()
}

// Follow the conversation as it grows, including each streamed chunk.
watch(
  () => [props.messages.length, props.pending] as const,
  async () => {
    await nextTick()
    const el = body.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <section class="chat-pane">
    <p v-if="status === 'unavailable'" class="unsupported">
      No language model is available in this browser.
    </p>

    <template v-else>
      <header>
        <div class="toolbar">
          <button class="new" :disabled="messages.length === 0 && !busy" @click="emit('newChat')">
            New chat
          </button>
          <button v-if="busy" @click="emit('stop')">Stop</button>
        </div>
        <div class="status">
          <span class="muted">{{ statusLabel }}</span>
          <button
            v-if="stale"
            class="staleness"
            title="This chat was started against an earlier version of the buffer"
            @click="emit('newChat')"
          >
            code has changed — start a new chat
          </button>
        </div>
      </header>

      <div ref="body" class="body">
        <p v-if="messages.length === 0 && !pending" class="empty">
          Ask about the code in the editor. The whole buffer goes to the model with a system prompt
          that makes it a security engineer reasoning about <strong>sources</strong> and
          <strong>sinks</strong>.
          <span class="suggestions">
            <button v-for="prompt in PROMPTS" :key="prompt" @click="send(prompt)">
              {{ prompt }}
            </button>
          </span>
        </p>

        <article
          v-for="message in messages"
          :key="message.id"
          class="message"
          :class="[message.role, { failed: message.failed }]"
        >
          <span class="who">{{ message.role === 'user' ? 'you' : 'model' }}</span>
          <p v-if="message.role === 'user' || message.failed" class="text">{{ message.text }}</p>
          <div v-else class="text"><MarkdownText :text="message.text" /></div>
        </article>

        <article v-if="pending" class="message assistant">
          <span class="who">model</span>
          <div class="text"><MarkdownText :text="pending" streaming /></div>
        </article>
        <p v-else-if="busy" class="waiting">…</p>
      </div>

      <form class="composer" @submit.prevent="send()">
        <textarea
          v-model="draft"
          rows="2"
          placeholder="Ask about this code…"
          @keydown.enter="onEnter"
        />
        <button type="submit" class="send" :disabled="busy || !draft.trim()">Ask</button>
      </form>

      <footer>Runs on the browser’s built-in model — the code never leaves this machine.</footer>
    </template>
  </section>
</template>

<style scoped>
.chat-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
}

.unsupported {
  margin: 0;
  padding: 24px 20px;
  color: var(--dim);
  text-align: center;
  line-height: 1.7;
}

header {
  border-bottom: 1px solid var(--border);
  padding: 8px 10px;
  display: grid;
  gap: 8px;
}

.toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
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
  white-space: nowrap;
}

button:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}

button:disabled {
  opacity: 0.45;
  cursor: default;
}

.new {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}

.status {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  min-height: 20px;
  min-width: 0;
}

.muted {
  color: var(--dim);
  opacity: 0.75;
}

.staleness {
  border: 0;
  background: none;
  padding: 0;
  color: var(--gold);
}

.staleness:hover:not(:disabled) {
  border: 0;
  color: var(--gold);
  text-decoration: underline;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty {
  padding: 18px 8px;
  margin: 0;
  color: var(--dim);
  text-align: center;
  line-height: 1.7;
}

.empty strong {
  color: var(--text);
  font-weight: 500;
}

.suggestions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
}

.message {
  display: grid;
  gap: 3px;
}

.who {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dim);
}

.text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.65;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--bg);
}

.user .text {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
}

.failed .text {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger);
}

.waiting {
  margin: 0;
  color: var(--dim);
}

.composer {
  display: flex;
  gap: 6px;
  align-items: flex-end;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
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

footer {
  border-top: 1px solid var(--border);
  padding: 5px 10px;
  font-size: 11px;
  color: var(--dim);
}
</style>
