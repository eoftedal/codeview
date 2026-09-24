<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import MarkdownText from './MarkdownText.vue'
import { DEFAULT_ROLE, describeStatus, type ModelChoice, type ModelStatus } from '../lib/chat'
import { HUNTERS, HUNTER_NAMES } from '../lib/hunters'
import type { CustomOpenRouterModel } from '../lib/providers/openrouterModels'
import { EXAMPLE_LOCAL_URL } from '../lib/providers/localServerUrl'
import type { LocalServerModel } from '../lib/providers/localServerModels'
import type { ChatMessage } from '../composables/useChat'

const props = defineProps<{
  /** Models this browser can run. Empty means none can, and the pane says only that. */
  models: ModelChoice[]
  model: string
  choice: ModelChoice | null
  thinking: boolean
  /** The instructions half of the system prompt; the code half is generated from the open files. */
  role: string
  /** Whether that is still the shipped one, which is all a rewritten prompt is marked by. */
  roleIsDefault: boolean
  /** The reader's OpenRouter key, or '' if none is set. Only OpenRouter models need it. */
  openrouterKey: string
  /** OpenRouter models the reader has added themselves, beyond the shipped ones. */
  openrouterModels: CustomOpenRouterModel[]
  /** The address of the reader's own model server, or '' if none is set. This is what the local
   *  provider offers models at all for: with no address there are no local entries to pick. */
  localServerUrl: string
  /** Models named on that server by hand — an override for what it reported, or the whole list
   *  for a server with no `/models` route. */
  localServerModels: LocalServerModel[]
  status: ModelStatus
  progress: number
  messages: ChatMessage[]
  /** The answer streaming in right now, if any. */
  pending: string
  busy: boolean
  stale: boolean
  /** What of the code the model was not shown, or null when it saw all of it. */
  clipped: string | null
}>()

const emit = defineEmits<{
  'update:model': [string]
  'update:thinking': [boolean]
  'update:role': [string]
  'update:openrouterKey': [string]
  'update:openrouterModels': [CustomOpenRouterModel[]]
  'update:localServerUrl': [string]
  'update:localServerModels': [LocalServerModel[]]
  ask: [string]
  stop: []
  newChat: []
}>()

const PROMPTS = [
  'What are the sources and sinks in this code?',
  'Does any untrusted input reach a sink unsanitised?',
  'Review this code for security problems.',
]

const draft = ref('')
const body = ref<HTMLElement>()

// The settings panel takes over the pane while it is open: a brief is several paragraphs, and a
// textarea squeezed above the conversation is no place to read one. Every draft here is a copy, so
// closing without saving leaves the prompt, the key and the added models alone. One panel and one
// Save, because they are all settings for this pane rather than three separate features.
const editingPrompt = ref(false)
const promptDraft = ref(props.role)
const keyDraft = ref(props.openrouterKey)
const modelsDraft = ref<CustomOpenRouterModel[]>(props.openrouterModels)
const localUrlDraft = ref(props.localServerUrl)
const localModelsDraft = ref<LocalServerModel[]>(props.localServerModels)

// Starting points for the brief, keyed by the name the picker shows. The shipped one is here
// beside the hunters, so the picker answers "what else could this say" on its own rather than
// leaving half the answer behind the Restore button. Picking one only *writes* it: from there it
// is the reader's text, edited, stored and shared like any brief they typed themselves, which is
// why nothing here remembers which one it came from.
const SHIPPED_TEMPLATE = 'General taint review'
const TEMPLATES: Record<string, string> = { [SHIPPED_TEMPLATE]: DEFAULT_ROLE, ...HUNTERS }

/** The template the draft still *is*, for the picker to show — no stored choice, since an edited
 *  template is no longer that template and the select must not claim otherwise. */
const templateName = computed(
  () => Object.keys(TEMPLATES).find((name) => TEMPLATES[name] === promptDraft.value) ?? '',
)

function applyTemplate(name: string): void {
  const text = TEMPLATES[name]
  if (text) promptDraft.value = text
}

// A second model of the same slug would just be a confusing duplicate in the picker — checked
// against the catalogue too, not only the draft, so adding one already shipped is refused the
// same way.
const newModelSlug = ref('')
const newModelLabel = ref('')
const newModelThinking = ref(false)
const newModelTaken = computed(() => {
  const slug = newModelSlug.value.trim()
  if (!slug) return false
  return (
    modelsDraft.value.some((entry) => entry.model === slug) ||
    props.models.some((entry) => entry.provider === 'openrouter' && entry.model === slug)
  )
})

function addModel(): void {
  const model = newModelSlug.value.trim()
  if (!model || newModelTaken.value) return
  const label = newModelLabel.value.trim()
  modelsDraft.value = [
    ...modelsDraft.value,
    { model, label: label || model, thinking: newModelThinking.value },
  ]
  newModelSlug.value = ''
  newModelLabel.value = ''
  newModelThinking.value = false
}

function removeModel(model: string): void {
  modelsDraft.value = modelsDraft.value.filter((entry) => entry.model !== model)
}

// The same guard for the local list, against the draft and the live picker both. A name already
// *discovered* is deliberately not taken: naming it by hand is how a reader says something the
// server's own listing cannot — that it thinks, or that its context is smaller than the default
// budget assumes — so that is an override rather than a duplicate.
const newLocalModel = ref('')
const newLocalLabel = ref('')
const newLocalThinking = ref(false)
const newLocalTaken = computed(() => {
  const name = newLocalModel.value.trim()
  if (!name) return false
  return localModelsDraft.value.some((entry) => entry.model === name)
})

function addLocalModel(): void {
  const model = newLocalModel.value.trim()
  if (!model || newLocalTaken.value) return
  const label = newLocalLabel.value.trim()
  localModelsDraft.value = [
    ...localModelsDraft.value,
    { model, label: label || model, thinking: newLocalThinking.value },
  ]
  newLocalModel.value = ''
  newLocalLabel.value = ''
  newLocalThinking.value = false
}

function removeLocalModel(model: string): void {
  localModelsDraft.value = localModelsDraft.value.filter((entry) => entry.model !== model)
}

/** This page's own origin, so the CORS hint names the value the reader actually has to allow
 *  rather than leaving them to work it out — it differs between the dev server and the deployed
 *  site, which is exactly when this goes wrong. */
const origin = computed(() => location.origin)

/**
 * What the server reported and the reader has not named: the picker's local entries less the
 * hand-added ones, saved and drafted alike. Listed by name rather than counted, so that any of them
 * can be flagged as thinking in place — `/models` cannot say which of them reason, and the think
 * switch is only ever sent for an entry marked so. Flagging one *names* it, which is the override
 * the hand-added list already is: it moves up into that list, with a Remove of its own that puts
 * it back here.
 */
const discovered = computed(() =>
  props.models
    .filter(
      (entry) =>
        entry.provider === 'localserver' &&
        !props.localServerModels.some((named) => named.model === entry.model) &&
        !localModelsDraft.value.some((named) => named.model === entry.model),
    )
    .map((entry) => entry.model ?? entry.id),
)

function flagDiscovered(model: string): void {
  if (localModelsDraft.value.some((entry) => entry.model === model)) return
  localModelsDraft.value = [...localModelsDraft.value, { model, label: model, thinking: true }]
}

const settingsChanged = computed(
  () =>
    promptDraft.value !== props.role ||
    keyDraft.value !== props.openrouterKey ||
    JSON.stringify(modelsDraft.value) !== JSON.stringify(props.openrouterModels) ||
    localUrlDraft.value !== props.localServerUrl ||
    JSON.stringify(localModelsDraft.value) !== JSON.stringify(props.localServerModels),
)

/** Whether the toolbar's dot and gold tint are earned: any setting away from what shipped. */
const settingsCustomized = computed(
  () =>
    !props.roleIsDefault ||
    props.openrouterKey !== '' ||
    props.openrouterModels.length > 0 ||
    props.localServerUrl !== '' ||
    props.localServerModels.length > 0,
)

function editPrompt(): void {
  promptDraft.value = props.role
  keyDraft.value = props.openrouterKey
  modelsDraft.value = props.openrouterModels
  localUrlDraft.value = props.localServerUrl
  localModelsDraft.value = props.localServerModels
  newModelSlug.value = ''
  newModelLabel.value = ''
  newModelThinking.value = false
  newLocalModel.value = ''
  newLocalLabel.value = ''
  newLocalThinking.value = false
  editingPrompt.value = true
}

function savePrompt(): void {
  // An emptied box means the shipped brief, not a model with no instructions at all.
  emit('update:role', promptDraft.value.trim() ? promptDraft.value : DEFAULT_ROLE)
  emit('update:openrouterKey', keyDraft.value)
  emit('update:openrouterModels', modelsDraft.value)
  emit('update:localServerUrl', localUrlDraft.value)
  emit('update:localServerModels', localModelsDraft.value)
  editingPrompt.value = false
}

const statusLabel = computed(() =>
  describeStatus(props.status, props.choice, props.busy, props.progress),
)

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
    <p v-if="models.length === 0" class="unsupported">
      No language model is available in this browser.
    </p>

    <template v-else>
      <header>
        <div class="toolbar">
          <select
            class="model"
            :value="model"
            :title="choice?.note"
            @change="emit('update:model', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="option in models" :key="option.id" :value="option.id">
              {{ option.label }} · {{ option.size }}
            </option>
          </select>
          <label
            v-if="choice?.thinking"
            class="reason"
            title="Let the model reason before it answers. Slower, and the reasoning is kept out of the way."
          >
            <input
              type="checkbox"
              :checked="thinking"
              @change="emit('update:thinking', ($event.target as HTMLInputElement).checked)"
            />
            think
          </label>
          <button class="new" :disabled="messages.length === 0 && !busy" @click="emit('newChat')">
            New chat
          </button>
          <button v-if="busy" @click="emit('stop')">Stop</button>
          <button
            class="prompt"
            :class="{ custom: settingsCustomized, open: editingPrompt }"
            title="System prompt, OpenRouter API key and added models"
            aria-label="Chat settings"
            @click="editingPrompt ? (editingPrompt = false) : editPrompt()"
          >
            <span class="cog" aria-hidden="true">⚙</span>
            <span class="label">Settings</span>
            <span v-if="settingsCustomized" class="edited" aria-hidden="true">·</span>
          </button>
        </div>
        <div v-if="status === 'downloading'" class="bar">
          <span :style="{ width: `${Math.round(progress * 100)}%` }" />
        </div>
        <div class="status">
          <span class="muted">{{ statusLabel }}</span>
          <button
            v-if="stale"
            class="staleness"
            title="This chat was started against an earlier version of the code"
            @click="emit('newChat')"
          >
            code has changed — start a new chat
          </button>
          <!-- The model was told what it cannot see; this is where the reader is. An answer over
               part of the code reads exactly like one over all of it otherwise. -->
          <span v-else-if="clipped" class="clipped" :title="clipped">
            ⚠ the model sees part of the code — {{ clipped }}
          </span>
        </div>
      </header>

      <section v-if="editingPrompt" class="prompt-editor">
        <p class="hint">
          What the model is told before the code. Every open file is appended below this,
          line-numbered — you write the brief, the editor supplies the code.
        </p>
        <!-- A template is a starting point and nothing more: it writes the box, and what you do
             with it afterwards is yours. The hunters are short on purpose — a brief that already
             knows what it is looking for leaves more of a small window for the code. -->
        <div class="template-row">
          <label for="chat-template">Start from</label>
          <select
            id="chat-template"
            class="template"
            :value="templateName"
            @change="applyTemplate(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ templateName ? 'Start from…' : 'Your own wording' }}</option>
            <optgroup label="Shipped">
              <option :value="SHIPPED_TEMPLATE">{{ SHIPPED_TEMPLATE }}</option>
            </optgroup>
            <optgroup label="Hunt one vulnerability class">
              <option v-for="name in HUNTER_NAMES" :key="name" :value="name">{{ name }}</option>
            </optgroup>
          </select>
        </div>
        <textarea v-model="promptDraft" class="prompt-text" spellcheck="false" />
        <p v-if="messages.length > 0" class="hint warn">
          Saving starts a new chat: a conversation keeps the prompt it began with.
        </p>
        <button
          class="restore"
          :disabled="promptDraft === DEFAULT_ROLE"
          @click="promptDraft = DEFAULT_ROLE"
        >
          Restore default prompt
        </button>

        <label class="key-label" for="openrouter-key">OpenRouter API key</label>
        <p class="hint">
          Needed only for an OpenRouter-hosted model. Stored in this browser only, and never
          included in a share link — the key stays out of the URL the way the prompt above does not
          have to.
        </p>
        <div class="key-row">
          <input
            id="openrouter-key"
            v-model="keyDraft"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="sk-or-…"
            class="key-input"
          />
          <button :disabled="!keyDraft" @click="keyDraft = ''">Clear</button>
        </div>

        <label class="key-label">OpenRouter models</label>
        <p class="hint">
          Beyond the ones shipped above — any model OpenRouter itself lists. Enter the slug from its
          model page (for example <code>mistralai/mistral-large</code>), and tick <em>thinks</em> if
          that page lists <code>reasoning</code> among its parameters: the think switch is only sent
          for a model marked so.
        </p>
        <ul v-if="modelsDraft.length > 0" class="models-list">
          <li v-for="entry in modelsDraft" :key="entry.model" class="models-row">
            <span class="models-label" :title="entry.model">{{ entry.label }}</span>
            <span v-if="entry.thinking" class="models-thinking" title="Has a thinking mode">
              thinks
            </span>
            <button class="models-remove" @click="removeModel(entry.model)">Remove</button>
          </li>
        </ul>
        <div class="models-add">
          <input
            v-model="newModelSlug"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="vendor/model-slug"
            class="models-input"
            @keydown.enter.prevent="addModel"
          />
          <input
            v-model="newModelLabel"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Label (optional)"
            class="models-input"
            @keydown.enter.prevent="addModel"
          />
          <label class="models-think" title="Offers the thinking checkbox and asks it to reason">
            <input v-model="newModelThinking" type="checkbox" />
            thinks
          </label>
          <button :disabled="!newModelSlug.trim() || newModelTaken" @click="addModel">Add</button>
        </div>
        <p v-if="newModelTaken" class="hint warn">Already on the list.</p>

        <label class="key-label" for="local-server-url">Local model server</label>
        <p class="hint">
          Ollama, LM Studio, llama.cpp or vLLM running on this machine — anything serving the OpenAI
          API. Nothing is requested until an address is set, and the code never leaves the machine.
          The server has to allow this page's origin: Ollama needs
          <code>OLLAMA_ORIGINS={{ origin }}</code> for anything but a loopback page, and LM Studio
          has a CORS switch. Answers cut short usually mean the server's own context is small —
          Ollama's <code>num_ctx</code> defaults to 4096 whatever the model supports.
        </p>
        <div class="key-row">
          <input
            id="local-server-url"
            v-model="localUrlDraft"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="EXAMPLE_LOCAL_URL"
            class="key-input"
          />
          <button :disabled="!localUrlDraft" @click="localUrlDraft = ''">Clear</button>
        </div>
        <template v-if="localServerUrl && discovered.length > 0">
          <p class="hint">
            Found on the server. The listing cannot say which of them reason, so tick
            <em>thinks</em> on one that does: the think switch is only sent for a model marked so.
          </p>
          <ul class="models-list local discovered">
            <li v-for="name in discovered" :key="name" class="models-row">
              <span class="models-label" :title="name">{{ name }}</span>
              <label
                class="models-think"
                title="Offers the thinking checkbox and asks it to reason"
              >
                <input type="checkbox" @change="flagDiscovered(name)" />
                thinks
              </label>
            </li>
          </ul>
        </template>
        <p v-else-if="localServerUrl" class="hint warn">
          No models found there yet — the address may be wrong, the server down, or it may not list
          them. Name one below to use it anyway.
        </p>

        <ul v-if="localModelsDraft.length > 0" class="models-list local">
          <li v-for="entry in localModelsDraft" :key="entry.model" class="models-row">
            <span class="models-label" :title="entry.model">{{ entry.label }}</span>
            <span v-if="entry.thinking" class="models-thinking" title="Has a thinking mode">
              thinks
            </span>
            <button class="models-remove" @click="removeLocalModel(entry.model)">Remove</button>
          </li>
        </ul>
        <div class="models-add local">
          <input
            v-model="newLocalModel"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="model name on the server"
            class="models-input"
            @keydown.enter.prevent="addLocalModel"
          />
          <input
            v-model="newLocalLabel"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Label (optional)"
            class="models-input"
            @keydown.enter.prevent="addLocalModel"
          />
          <label class="models-think" title="Offers the thinking checkbox and asks it to reason">
            <input v-model="newLocalThinking" type="checkbox" />
            thinks
          </label>
          <button :disabled="!newLocalModel.trim() || newLocalTaken" @click="addLocalModel">
            Add
          </button>
        </div>
        <p v-if="newLocalTaken" class="hint warn">Already on the list.</p>

        <div class="prompt-actions">
          <button class="save" :disabled="!settingsChanged" @click="savePrompt">Save</button>
          <button @click="editingPrompt = false">Cancel</button>
        </div>
      </section>

      <div v-show="!editingPrompt" ref="body" class="body">
        <p v-if="messages.length === 0 && !pending" class="empty">
          Ask about the code in the editor. Every open file goes to the model with a system prompt
          that makes it a security engineer reasoning about <strong>sources</strong> and
          <strong>sinks</strong>.
          <br />
          <span v-if="choice">{{ choice.note }}</span>
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

      <form v-if="!editingPrompt" class="composer" @submit.prevent="send()">
        <textarea
          v-model="draft"
          rows="2"
          placeholder="Ask about this code…"
          @keydown.enter="onEnter"
        />
        <button type="submit" class="send" :disabled="busy || !draft.trim()">Ask</button>
      </form>

      <footer v-if="choice?.provider === 'openrouter'">
        Hosted by OpenRouter for this model — the code goes to their API, not only this machine.
      </footer>
      <footer v-else-if="choice?.provider === 'localserver'">
        Runs on your own model server — nothing downloads here, and the code goes no further than
        this machine.
      </footer>
      <footer v-else>Runs on this machine — weights come down, the code never goes up.</footer>
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
  /* The split is draggable down to a sixth of the window, so what the toolbar can afford is a
     question about this pane rather than about the viewport. */
  container-type: inline-size;
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

/* One row, always: a second row would move the buttons under the picker the moment a Stop
   appears. Nothing here wraps or shrinks except the model name — see `.model` — and `min-width: 0`
   is what lets this row be narrower than its own content, since a grid child defaults to
   `min-width: auto` and would otherwise size the header to the widest thing in it. */
.toolbar {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.toolbar button {
  flex: 0 0 auto;
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

/* Settings, so: the far end of the toolbar, away from the two buttons that act on the
   conversation itself. */
.prompt {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
}

.cog {
  font-size: 13px;
  line-height: 1;
}

/* Narrow enough that the label would push the toolbar onto a second row: the cogwheel alone is
   still the settings gesture, and the dot still says the brief has been rewritten. */
@container (max-width: 360px) {
  .prompt .label {
    display: none;
  }

  .prompt {
    padding: 5px 7px;
  }
}

/* A rewritten brief is the one thing about this pane that is not visible in it, so the button
   carries the fact. */
.prompt.custom {
  color: var(--gold);
  border-color: color-mix(in srgb, var(--gold) 45%, var(--border));
}

.prompt.custom:hover:not(:disabled) {
  color: var(--gold);
}

.prompt.open {
  background: var(--panel);
  border-color: var(--accent);
}

.prompt-editor {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  /* Three settings now share this panel, and the added-models list has no fixed size — without
     this, a reader with several of their own models, or a short pane, could not reach Save. */
  overflow-y: auto;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dim);
}

.warn {
  color: var(--gold);
}

.template-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dim);
  min-width: 0;
}

.template {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 11px;
  padding: 4px 6px;
  cursor: pointer;
}

.template:hover {
  border-color: var(--accent);
}

.prompt-text {
  flex: 1;
  /* A floor, not `0`: the panel scrolls past this rather than squeezing the prompt itself away to
     fit the models list below it. */
  min-height: 120px;
  resize: none;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.55;
}

.prompt-actions {
  display: flex;
  gap: 6px;
}

.save {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}

.restore {
  align-self: flex-start;
}

.key-label {
  font-size: 12px;
  color: var(--text);
}

.key-row {
  display: flex;
  gap: 6px;
}

.key-input {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 6px 8px;
}

.key-input:focus {
  outline: none;
  border-color: var(--accent);
}

.models-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.models-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.models-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.models-thinking {
  color: var(--dim);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.models-remove {
  margin-left: auto;
}

/* A discovered row has no Remove; its checkbox takes that seat. */
.models-list.discovered .models-think {
  margin-left: auto;
}

.models-add {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.models-input {
  flex: 1 1 140px;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 6px 8px;
}

.models-input:focus {
  outline: none;
  border-color: var(--accent);
}

.models-think {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--dim);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.models-think input {
  accent-color: var(--accent);
  margin: 0;
  cursor: pointer;
}

.model {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 5px 7px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  /* The one item here that gives way: a model name is still recognisable clipped, while a clipped
     button is a button you cannot use. The cap is
     absolute rather than a percentage: at 60% of a wide pane the picker took space it had no use
     for, and at 60% of a narrow one it still crowded out the buttons. */
  flex: 0 1 auto;
  max-width: 200px;
  min-width: 0;
}

.model:hover {
  border-color: var(--accent);
}

.reason {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--dim);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.reason:hover {
  color: var(--text);
}

.reason input {
  accent-color: var(--accent);
  margin: 0;
  cursor: pointer;
}

/* Weights are big enough that a bare percentage reads as a stall. */
.bar {
  height: 3px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}

.bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease-out;
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

.clipped {
  color: var(--gold);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  /* `minmax(0, …)` rather than the implicit `auto`: a bubble holding a code block must be allowed
     to be narrower than that block's longest line, or the log scrolls sideways instead of the
     block doing it. */
  grid-template-columns: minmax(0, 1fr);
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
  min-width: 0;
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
