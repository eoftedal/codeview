<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import MarkdownText from './MarkdownText.vue'
import {
  createAgentId,
  defaultTeam,
  serializeTeam,
  untitledAgentName,
  type AgentTeam,
} from '../lib/agents'
import { DEFAULT_ROLE, describeStatus, type ModelChoice, type ModelStatus } from '../lib/chat'
import type { AgentStep, PendingStep } from '../composables/useAgents'

const props = defineProps<{
  /** Models this browser can run. Empty means none can, and the pane says only that. */
  models: ModelChoice[]
  model: string
  choice: ModelChoice | null
  thinking: boolean
  status: ModelStatus
  progress: number
  /** The orchestrator's brief and the agents it runs, in order. */
  team: AgentTeam
  /** Whether that is still the shipped team, which is all a rewritten one is marked by. */
  teamIsDefault: boolean
  /** What the orchestrator is asked to open the run with. */
  task: string
  steps: AgentStep[]
  /** The step streaming in right now, if any. */
  pending: string
  pendingStep: PendingStep | null
  running: boolean
}>()

const emit = defineEmits<{
  'update:model': [string]
  'update:thinking': [boolean]
  'update:task': [string]
  'update:team': [AgentTeam]
  run: []
  stop: []
  clear: []
}>()

const body = ref<HTMLElement>()

// The team editor takes over the pane while it is open: three or more briefs of several paragraphs
// each are no more readable squeezed above a transcript than one was. The draft is a copy, so
// closing without saving — including an agent added or removed — leaves the live team alone.
const editing = ref(false)
const draft = ref<AgentTeam>(cloneTeam(props.team))

function cloneTeam(team: AgentTeam): AgentTeam {
  return { orchestrator: team.orchestrator, agents: team.agents.map((agent) => ({ ...agent })) }
}

function editTeam(): void {
  draft.value = cloneTeam(props.team)
  editing.value = true
}

function saveTeam(): void {
  emit('update:team', draft.value)
  editing.value = false
}

function addAgent(): void {
  draft.value.agents = [
    ...draft.value.agents,
    {
      id: createAgentId(),
      name: untitledAgentName(draft.value.agents.map((agent) => agent.name)),
      role: DEFAULT_ROLE,
    },
  ]
}

/** The last agent is not removable: an orchestrator with nobody to brief has no run to make. */
function removeAgent(id: string): void {
  if (draft.value.agents.length < 2) return
  draft.value.agents = draft.value.agents.filter((agent) => agent.id !== id)
}

const draftChanged = computed(() => serializeTeam(draft.value) !== serializeTeam(props.team))
const draftIsDefault = computed(() => serializeTeam(draft.value) === serializeTeam(defaultTeam()))

const statusLabel = computed(() =>
  describeStatus(props.status, props.choice, props.running, props.progress, 'running…'),
)

/** What a row says about itself beside the name: who a brief is for, that a summary is one, that
 *  something failed. The task needs none — it is the reader's own line. */
function noteFor(step: AgentStep): string {
  if (step.failed) return 'failed'
  if (step.kind === 'brief') return `→ ${step.to}`
  if (step.kind === 'summary') return 'summary'
  return ''
}

/** What the pane is waiting on, said in the run's own terms rather than the model's. */
const stage = computed(() => {
  const step = props.pendingStep
  if (!step) return null
  if (step.kind === 'brief') return `${step.who} → ${step.to}`
  if (step.kind === 'summary') return `${step.who} · summary`
  return step.who
})

/**
 * The composer belongs to a run that has not begun. Once one has, the pane is the transcript: a run
 * is one task from start to finish, and a second task typed under the first one's findings would be
 * a different run wearing the same transcript. So the box goes away when a run starts and does not
 * come back when it ends — **Clear** is what offers it again, which is also what drops the
 * transcript it would otherwise be appended to.
 */
const canStart = computed(() => !props.running && props.steps.length === 0)

function start(): void {
  if (!canStart.value) return
  emit('run')
}

function onEnter(event: KeyboardEvent): void {
  // Shift+Enter is a newline; plain Enter starts the run, the way Enter asks in the chat pane.
  if (event.shiftKey || event.isComposing) return
  event.preventDefault()
  start()
}

// Follow the run as it grows, including each streamed chunk.
watch(
  () => [props.steps.length, props.pending] as const,
  async () => {
    await nextTick()
    const el = body.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <section class="agents-pane">
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
          <button v-if="running" @click="emit('stop')">Stop</button>
          <button v-else class="clear" :disabled="steps.length === 0" @click="emit('clear')">
            Clear
          </button>
          <button
            class="prompt"
            :class="{ custom: !teamIsDefault, open: editing }"
            :title="
              teamIsDefault
                ? 'Edit the orchestrator and the agents it runs'
                : 'A rewritten team is in use — click to edit or restore it'
            "
            aria-label="Agents"
            @click="editing ? (editing = false) : editTeam()"
          >
            <span class="cog" aria-hidden="true">⚙</span>
            <span class="label">Agents</span>
            <span v-if="!teamIsDefault" class="edited" aria-hidden="true">·</span>
          </button>
        </div>
        <div v-if="status === 'downloading'" class="bar">
          <span :style="{ width: `${Math.round(progress * 100)}%` }" />
        </div>
        <div class="status">
          <span class="muted">{{ statusLabel }}</span>
          <span v-if="stage" class="stage">{{ stage }}</span>
        </div>
      </header>

      <section v-if="editing" class="team-editor">
        <p class="hint">
          The orchestrator is briefed on the roster, never on the code — it only ever sees what the
          agents report. Every agent below is given all the open files, line-numbered, under its own
          brief.
        </p>

        <div class="scroll">
          <section class="card orchestrator">
            <div class="card-head">
              <span class="role-tag">Orchestrator</span>
              <span class="role-note">no files</span>
            </div>
            <textarea v-model="draft.orchestrator" class="prompt-text" spellcheck="false" />
          </section>

          <section v-for="(agent, index) in draft.agents" :key="agent.id" class="card">
            <div class="card-head">
              <span class="role-tag">{{ index + 1 }}</span>
              <input
                v-model="agent.name"
                class="name"
                spellcheck="false"
                aria-label="Agent name"
                :placeholder="`Agent ${index + 1}`"
              />
              <span class="role-note">sees all files</span>
              <button
                class="remove"
                :disabled="draft.agents.length < 2"
                title="Remove this agent"
                @click="removeAgent(agent.id)"
              >
                ✕
              </button>
            </div>
            <textarea v-model="agent.role" class="prompt-text" spellcheck="false" />
          </section>

          <button class="add" @click="addAgent">Add an agent</button>
        </div>

        <p v-if="steps.length > 0" class="hint warn">
          Saving clears the transcript: it was produced by a different set of instructions.
        </p>
        <div class="prompt-actions">
          <button class="save" :disabled="!draftChanged" @click="saveTeam">Save</button>
          <button @click="editing = false">Cancel</button>
          <button class="restore" :disabled="draftIsDefault" @click="draft = defaultTeam()">
            Restore defaults
          </button>
        </div>
      </section>

      <div v-show="!editing" ref="body" class="body">
        <div v-if="steps.length === 0 && !pending" class="empty">
          <p>
            An orchestrator runs {{ team.agents.length }}
            {{ team.agents.length === 1 ? 'agent' : 'agents' }} over the open files, one after the
            other. It writes each brief, reads what comes back, and carries it to the next.
          </p>
          <ol class="pipeline">
            <li class="orchestrator-row">
              <span class="who">Orchestrator</span>
              <span class="role-note">briefs each agent · never sees the code</span>
            </li>
            <li v-for="agent in team.agents" :key="agent.id">
              <span class="who">{{ agent.name }}</span>
              <span class="role-note">sees every open file</span>
            </li>
          </ol>
        </div>

        <article
          v-for="step in steps"
          :key="step.id"
          class="step"
          :class="[step.kind, { failed: step.failed }]"
        >
          <!-- An agent's report: pages of it, so it arrives folded. What it was handed is not
               repeated under it — that is the brief above and the report before, both already rows
               of their own. A failure is never folded: it is the one thing you must not have to go
               looking for. -->
          <details v-if="step.kind === 'agent' && !step.failed" class="fold report">
            <summary>
              <span class="who">{{ step.who }}</span>
              <span class="role-note">report</span>
            </summary>
            <div class="text"><MarkdownText :text="step.text" /></div>
          </details>

          <!-- The spine: what was asked, the orchestrator's briefs and its summary — and anything
               that went wrong, wherever it went wrong. -->
          <template v-else>
            <span class="who">
              {{ step.who }}
              <span v-if="noteFor(step)" class="role-note">{{ noteFor(step) }}</span>
            </span>
            <!-- The task is the reader's own text, and a failure is ours: neither is markdown. -->
            <p v-if="step.kind === 'task' || step.failed" class="text">{{ step.text }}</p>
            <div v-else class="text"><MarkdownText :text="step.text" /></div>
          </template>
        </article>

        <!-- The hop in flight is shown open whatever kind it is: a run is slow, and watching the
             text arrive is how a reader knows it is still going. It folds when it lands. -->
        <article v-if="pending && pendingStep" class="step" :class="pendingStep.kind">
          <span class="who">
            {{ pendingStep.who }}
            <span v-if="pendingStep.to" class="role-note">→ {{ pendingStep.to }}</span>
            <span v-else-if="pendingStep.kind === 'summary'" class="role-note">summary</span>
          </span>
          <div class="text"><MarkdownText :text="pending" streaming /></div>
        </article>
        <p v-else-if="running" class="waiting">…</p>
      </div>

      <form v-if="!editing && canStart" class="composer" @submit.prevent="start()">
        <textarea
          :value="task"
          rows="2"
          placeholder="What should the run look for?"
          @input="emit('update:task', ($event.target as HTMLTextAreaElement).value)"
          @keydown.enter="onEnter"
        />
        <button type="submit" class="send" :disabled="!task.trim()">Run</button>
      </form>

      <footer>Runs on this machine — weights come down, the code never goes up.</footer>
    </template>
  </section>
</template>

<style scoped>
.agents-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--panel);
  /* Same reasoning as the chat pane: what the toolbar can afford is a question about this pane
     rather than about the viewport. */
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

@container (max-width: 360px) {
  .prompt .label {
    display: none;
  }

  .prompt {
    padding: 5px 7px;
  }
}

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

.model {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 5px 7px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
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

/* Which hop the run is on, which is the one thing a reader watching a slow run wants. */
.stage {
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.team-editor {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
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

.scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  background: var(--bg);
}

.card.orchestrator {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}

.card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.role-tag {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dim);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 7px;
  white-space: nowrap;
}

.role-note {
  font-size: 10px;
  color: var(--dim);
  opacity: 0.8;
  white-space: nowrap;
}

.name {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 3px 6px;
}

.name:focus {
  outline: none;
  border-color: var(--accent);
}

.remove {
  padding: 2px 7px;
  line-height: 1.4;
}

.card .prompt-text {
  min-height: 120px;
}

.prompt-text {
  resize: vertical;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.55;
}

.add {
  align-self: flex-start;
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
  margin-left: auto;
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
  padding: 14px 8px;
  color: var(--dim);
  line-height: 1.7;
}

.empty p {
  margin: 0 0 12px;
}

.pipeline {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.pipeline li {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.pipeline .orchestrator-row {
  list-style: none;
  margin-left: -20px;
  padding-left: 20px;
}

.step {
  display: grid;
  gap: 3px;
}

.who {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dim);
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.step.task .text {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
}

.step.summary .who {
  color: var(--accent);
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

.step.summary .text {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
}

.failed .text {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger);
}

.fold > summary {
  display: flex;
  align-items: baseline;
  gap: 6px;
  cursor: pointer;
  list-style: none;
  padding: 2px 0;
}

.fold > summary::-webkit-details-marker {
  display: none;
}

.fold > summary::before {
  content: '▸';
  font-size: 9px;
  color: var(--dim);
}

.fold[open] > summary::before {
  content: '▾';
}

.fold > summary:hover .who,
.fold > summary:hover .role-note {
  color: var(--text);
}

.report > .text {
  margin-top: 5px;
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

.send {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}

footer {
  border-top: 1px solid var(--border);
  padding: 5px 10px;
  font-size: 11px;
  color: var(--dim);
}
</style>
