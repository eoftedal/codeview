<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ModelChoice } from '../lib/chat'
import type { CustomOpenRouterModel } from '../lib/providers/openrouterModels'
import { EXAMPLE_LOCAL_URL } from '../lib/providers/localServerUrl'
import type { LocalServerModel } from '../lib/providers/localServerModels'

/**
 * How the models are reached, which is one question for the whole app rather than one per pane.
 *
 * The picked model, the thinking switch and a brief all belong to whoever is asking — so they stay
 * in the pane that asks — but a key, a server address and the reader's own additions to the
 * catalogue are the same facts whether a chat or an agent run consumes them. They lived under the
 * chat's own cogwheel while the chat was the only thing that consumed them, which left the agents
 * tab sending readers to a conversation they did not want in order to configure a run.
 */
const props = defineProps<{
  /** The live catalogue, for the duplicate checks and for listing what a server reported. */
  models: ModelChoice[]
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
}>()

const emit = defineEmits<{
  'update:openrouterKey': [string]
  'update:openrouterModels': [CustomOpenRouterModel[]]
  'update:localServerUrl': [string]
  'update:localServerModels': [LocalServerModel[]]
}>()

// Every field here is a draft, and one Save commits them together. Not merely a convention carried
// over from the panel this came out of: the address is the one setting whose *storage* starts work —
// `App.vue` probes the server whenever it changes — so a field that wrote through on every keystroke
// would ask a dozen half-typed hosts before it reached the real one.
const keyDraft = ref(props.openrouterKey)
const modelsDraft = ref<CustomOpenRouterModel[]>(props.openrouterModels)
const localUrlDraft = ref(props.localServerUrl)
const localModelsDraft = ref<LocalServerModel[]>(props.localServerModels)

// A stored value only ever changes because this pane saved it, so each draft can follow its own —
// which is what shows the reader what was *kept*: an address is stored canonical, so a typed
// `localhost:11434` comes back as `http://localhost:11434/v1`, and a draft left holding what was
// typed would read as unsaved for as long as the pane stayed open.
watch(
  () => props.openrouterKey,
  (value) => (keyDraft.value = value),
)
watch(
  () => props.openrouterModels,
  (value) => (modelsDraft.value = value),
  { deep: true },
)
watch(
  () => props.localServerUrl,
  (value) => (localUrlDraft.value = value),
)
watch(
  () => props.localServerModels,
  (value) => (localModelsDraft.value = value),
  { deep: true },
)

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

const changed = computed(
  () =>
    keyDraft.value !== props.openrouterKey ||
    JSON.stringify(modelsDraft.value) !== JSON.stringify(props.openrouterModels) ||
    localUrlDraft.value !== props.localServerUrl ||
    JSON.stringify(localModelsDraft.value) !== JSON.stringify(props.localServerModels),
)

function revert(): void {
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
}

function save(): void {
  emit('update:openrouterKey', keyDraft.value)
  emit('update:openrouterModels', modelsDraft.value)
  emit('update:localServerUrl', localUrlDraft.value)
  emit('update:localServerModels', localModelsDraft.value)
}
</script>

<template>
  <section class="settings-pane">
    <div class="scroll">
      <p class="hint">
        How the models are reached — shared by the chat and the agents, since a key and a server
        address are the same facts whichever asks. Which model to use, and what to tell it, stay
        under each of those tabs.
      </p>

      <label class="group-title" for="openrouter-key">OpenRouter API key</label>
      <p class="hint">
        Needed only for an OpenRouter-hosted model. Stored in this browser only, and never included
        in a share link.
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

      <h3 class="group-title">OpenRouter models</h3>
      <p class="hint">
        Beyond the shipped ones — any model OpenRouter itself lists. Enter the slug from its model
        page (for example <code>mistralai/mistral-large</code>), and tick <em>thinks</em> if that
        page lists <code>reasoning</code> among its parameters: the think switch is only sent for a
        model marked so.
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

      <label class="group-title" for="local-server-url">Local model server</label>
      <p class="hint">
        Ollama, LM Studio, llama.cpp or vLLM running on this machine — anything serving the OpenAI
        API. Nothing is requested until an address is set, and the code never leaves the machine.
        The server has to allow this page's origin: Ollama needs
        <code>OLLAMA_ORIGINS={{ origin }}</code> for anything but a loopback page, and LM Studio has
        a CORS switch. Answers cut short usually mean the server's own context is small — Ollama's
        <code>num_ctx</code> defaults to 4096 whatever the model supports.
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
            <label class="models-think" title="Offers the thinking checkbox and asks it to reason">
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
    </div>

    <footer class="actions">
      <button class="save" :disabled="!changed" @click="save">Save</button>
      <button :disabled="!changed" @click="revert">Revert</button>
      <!-- Nothing here is stored until Save, and leaving the tab unmounts the pane — so an unsaved
           draft has to say so where the button that would keep it is. -->
      <span v-if="changed" class="unsaved">unsaved changes</span>
    </footer>
  </section>
</template>

<style scoped>
.settings-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 14px;
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

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dim);
}

.warn {
  color: var(--gold);
}

/* Each setting's own name. A `<label>` where there is one field to point at and a heading where
   there is a list, styled alike so the three read as one column of settings. */
.group-title {
  margin: 10px 0 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
}

.scroll > .group-title:first-of-type {
  margin-top: 4px;
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

/* Pinned rather than scrolled with the fields: the lists here have no fixed size, and Save is the
   one control that must never be below the fold. */
.actions {
  flex: 0 0 auto;
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
}

.save {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}

.unsaved {
  font-size: 11px;
  color: var(--gold);
}
</style>
