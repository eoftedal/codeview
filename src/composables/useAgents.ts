import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  DEFAULT_TASK,
  defaultTeam,
  handoffMessage,
  isDefaultTeam,
  kickoffMessage,
  normalizeTeam,
  orchestratorPrompt,
  parseTeam,
  relayMessage,
  serializeTeam,
  summaryMessage,
  teamModels,
  type AgentSpec,
  type AgentTeam,
} from '../lib/agents'
import {
  buildCodeMessage,
  buildSystemPrompt,
  modelById,
  promptFiles,
  type ChatSession,
} from '../lib/chat'
import type { CodeFile } from '../lib/files'
import { withoutThoughts } from '../lib/providers/thoughts'
import { decodeShare, parseParams } from '../lib/share'
import { isAbort, messageOf, streamAnswer, withTruncatedNote } from '../lib/stream'
import type { ModelHost } from './useModel'

/** Written only while the team differs from the shipped one, the same rule the chat's brief
 *  follows: an absent key means the defaults, so a later edit to them reaches everyone who never
 *  wrote their own. */
const TEAM_KEY = 'codeview:agents'

/** What the orchestrator is called in the transcript. It is not an agent and has no roster name. */
export const ORCHESTRATOR_LABEL = 'Orchestrator'

/** What the reader's own task is filed under in the transcript. */
export const READER_LABEL = 'You'

/**
 * The four kinds of row a run leaves behind, and the pane shows them at two depths on purpose.
 *
 * The **task** the reader wrote and the orchestrator's own messages — a **brief** for each agent,
 * then the closing **summary** — are the spine of the run and are always open: between them they
 * say what was asked and what came of it. An **agent**'s report is the bulk of the text and arrives
 * folded, since a run of three agents over a file is pages of it; opening one shows the report.
 *
 * What an agent was *handed* is deliberately not kept here. It is the brief above it plus the
 * previous agent's report, and both are already rows of their own in the same transcript — showing
 * it again under the agent would be the same text a second time.
 */
export type StepKind = 'task' | 'brief' | 'agent' | 'summary'

export interface AgentStep {
  id: number
  kind: StepKind
  /** Who spoke: an agent's name, `ORCHESTRATOR_LABEL`, or the reader. */
  who: string
  /** For a brief, the agent it is addressed to. */
  to?: string
  text: string
  /** A step that failed rather than one a model produced — rendered as a warning, not as speech. */
  failed?: boolean
}

/** The hop in flight: what is streaming, and who it will belong to when it lands. */
export interface PendingStep {
  kind: StepKind
  who: string
  to?: string
}

export interface Agents {
  team: Readonly<Ref<AgentTeam>>
  /** Whether the team is still the shipped one, for a pane that marks a rewritten one. */
  teamIsDefault: Ref<boolean>
  /** The team as link text, or null while it is the shipped one — what `copyShareLink` writes. */
  shareText: Ref<string | null>
  /** The run's opening instruction, which is what the orchestrator is asked. */
  task: Ref<string>
  /** The transcript so far: one entry per hop, orchestrator and agents alternating. */
  steps: Ref<AgentStep[]>
  /** The step streaming in right now; empty when nothing is in flight. */
  pending: Ref<string>
  /** Whose step that is, and of what kind. Null when nothing is in flight. */
  pendingStep: Ref<PendingStep | null>
  running: Ref<boolean>
  run: () => Promise<void>
  stop: () => void
  /** Drop the transcript, keeping the loaded model and the team. */
  clear: () => void
  /** Commit an edited team. Remembered, and clears the transcript, since the run it describes was
   *  produced by a different set of instructions. */
  setTeam: (next: AgentTeam) => void
}

/**
 * The agents pane: an orchestrator briefing a line of sub-agents, one after another, over the open
 * files.
 *
 * **Two kinds of participant, and the difference is the point.** The orchestrator's session is
 * built from its brief alone — no files, ever — and it lives for the whole run, so it accumulates
 * what each agent reported and can hand it forward. Each sub-agent gets a *fresh* session built the
 * way the chat pane builds its own, with every open file appended, and that session is destroyed
 * the moment its step ends: an agent is a single question, not a conversation.
 *
 * The model underneath all of them is `useModel`'s one engine, shared with the chat — a run and a
 * conversation are two uses of the same loaded weights, and loading them twice would be absurd.
 * Unless an agent has been put on a model of its own: then that one runs on the host's extra for
 * it, loaded on the first hop that needs it and kept by the host for as long as the team names it.
 * The orchestrator has no such setting — it runs on the picked model, always.
 */
export function useAgents(model: ModelHost, files: Ref<CodeFile[]>, activeId: Ref<string>): Agents {
  const params = parseParams(location.search, location.hash)

  const stored = localStorage.getItem(TEAM_KEY)
  const team = ref<AgentTeam>((stored && parseTeam(stored)) || defaultTeam())

  const teamIsDefault = computed(() => isDefaultTeam(team.value))
  const shareText = computed(() => (teamIsDefault.value ? null : serializeTeam(team.value)))

  const task = ref(DEFAULT_TASK)
  const steps = ref<AgentStep[]>([])
  const pending = ref('')
  const pendingStep = ref<PendingStep | null>(null)
  const running = ref(false)

  let controller: AbortController | null = null
  let nextId = 0

  function setTeam(next: AgentTeam): void {
    team.value = normalizeTeam(next)
    if (isDefaultTeam(team.value)) localStorage.removeItem(TEAM_KEY)
    else localStorage.setItem(TEAM_KEY, serializeTeam(team.value))
    clear()
  }

  // The models the team names are the ones worth holding on the GPU between runs; an agent taken
  // off a model, or a team that no longer has it, is what lets the host unload it.
  watch(team, (current) => model.retain(teamModels(current)), { immediate: true })

  /**
   * A team carried by the link, which wins over the stored one — the same order the buffer follows.
   *
   * Deliberately *not* written to `localStorage`: it belongs to the link, and opening someone
   * else's run should not overwrite the team this reader wrote for themselves. Reloading keeps it
   * anyway, since the fragment is still in the address bar.
   */
  const linked = params.get('agents') ?? null
  if (linked !== null) {
    void decodeShare(linked).then((decoded) => {
      if (decoded === null) return
      const parsed = parseTeam(decoded)
      if (!parsed) return
      team.value = normalizeTeam(parsed)
      clear()
    })
  }

  function clear(): void {
    stop()
    steps.value = []
    pending.value = ''
    pendingStep.value = null
  }

  function stop(): void {
    controller?.abort()
  }

  /**
   * One hop: ask, stream it into the pane as it arrives, then keep it as a step.
   *
   * **What is shown and what is passed on are not the same text.** The step keeps the answer whole,
   * thinking included, because `markdown.ts` folds a `<think>` block into a disclosure and a reader
   * may well want to open it. What is *returned* — and so what the next hop is built from — has the
   * thinking stripped: it is the model reasoning its way towards the answer, not the answer, and
   * feeding it to the next agent spends a small context window on working-out while inviting the
   * agent to treat a discarded line of thought as a finding.
   *
   * One thing *is* the same in both: an answer the provider cut off at its ceiling carries the
   * note saying so, in the transcript and in what the next hop is handed. The relay is verbatim
   * precisely so that nothing is lost between agents, and "this report is incomplete" is the last
   * thing that should be.
   */
  async function speak(
    session: ChatSession,
    step: PendingStep,
    input: string,
    thinking: boolean = model.thinkingNow(),
  ): Promise<string> {
    pendingStep.value = step
    pending.value = ''
    const answer = await streamAnswer(
      session,
      input,
      { signal: controller?.signal, thinking },
      (text) => {
        pending.value = text
      },
    )
    pending.value = ''
    pendingStep.value = null
    steps.value = [
      ...steps.value,
      { id: nextId++, ...step, text: withTruncatedNote(answer) || '(this agent returned nothing)' },
    ]
    // An answer that is *only* thinking — a stopped one, or a model that ran out of room before it
    // concluded — leaves nothing to pass on, and nothing is what the next hop should get: a note
    // on an empty answer would be handed on as the whole of it. A brief falls back to the
    // reader's task; a report relays as the empty report it was.
    return withTruncatedNote({ text: withoutThoughts(answer.text), truncated: answer.truncated })
  }

  /** Whatever was streamed before a stop or a failure is still worth keeping: half a report says
   *  more about where a run got to than an empty transcript does. */
  function keepPartial(suffix: string, failed = false): void {
    const partial = pending.value.trim()
    const step = pendingStep.value
    if (step && partial) {
      steps.value = [...steps.value, { id: nextId++, ...step, text: `${partial}\n\n${suffix}` }]
    } else if (failed) {
      // Nothing had streamed yet — the model would not load, most likely. It is filed against
      // whoever was about to speak, or the orchestrator when the run never got that far.
      steps.value = [
        ...steps.value,
        {
          id: nextId++,
          kind: step?.kind ?? 'summary',
          who: step?.who ?? ORCHESTRATOR_LABEL,
          to: step?.to,
          text: suffix,
          failed: true,
        },
      ]
    }
    pending.value = ''
    pendingStep.value = null
  }

  async function run(): Promise<void> {
    if (running.value) return
    const roster = team.value.agents
    if (roster.length === 0) return

    running.value = true
    // The task opens the transcript: a run is read back weeks later, and what was asked is half of
    // what it means.
    const asked = task.value.trim() || DEFAULT_TASK
    steps.value = [{ id: nextId++, kind: 'task', who: READER_LABEL, text: asked }]
    pending.value = ''
    pendingStep.value = null
    controller = new AbortController()
    const { signal } = controller

    let orchestrator: ChatSession | null = null
    try {
      const engine = await model.engine()
      // The orchestrator's context is its brief and the roster. No files reach it, which is what
      // keeps its summary to what the agents actually reported.
      // One argument, not two: with no code passed there is no opening turn to seed, and the
      // orchestrator's context begins and ends with its brief.
      orchestrator = await engine.chat(orchestratorPrompt(team.value.orchestrator, roster))
      model.markAvailable()

      // One snapshot of the buffer for the whole run: a run takes minutes, and agents disagreeing
      // about what line 12 says because the reader typed in between would be worse than either of
      // them being a little behind. The listing is built per agent all the same, because the
      // budget is the model's — an agent on a model of its own may fit more, or less, of it.
      const snapshot = promptFiles(files.value, activeId.value)
      const codeFor = (id: string) =>
        buildCodeMessage({
          files: snapshot,
          maxCodeChars: modelById(id)?.maxCodeChars ?? 12_000,
        })

      // An orchestrator that says nothing would otherwise hand the first agent an empty prompt.
      // The reader's own task is the honest thing to fall back to.
      let brief =
        (await speak(
          orchestrator,
          { kind: 'brief', who: ORCHESTRATOR_LABEL, to: roster[0]!.name },
          kickoffMessage(asked, roster[0]!),
        )) || asked
      let previous: { from: AgentSpec; output: string } | null = null

      for (let index = 0; index < roster.length; index += 1) {
        const agent = roster[index]!
        const step: PendingStep = { kind: 'agent', who: agent.name }
        // Named before its model is asked for, so that a model which will not load — or one this
        // browser cannot run at all — is filed against the agent that needed it.
        pendingStep.value = step
        const modelId = agent.model ?? model.model.value
        const own = await model.engineFor(modelId)
        // Loading can take long enough for the reader to have stopped the run in the meantime,
        // and a signal that was aborted before a question is asked never fires for it.
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        // A fresh session per agent, and gone as soon as it has answered: an agent is one question
        // asked of the files, not a conversation to come back to.
        const session = await own.chat(buildSystemPrompt(agent.role), codeFor(modelId))
        const handoff = handoffMessage(brief, previous)
        let output: string
        try {
          output = await speak(session, step, handoff, model.thinkingNow(modelId))
        } finally {
          session.destroy()
        }
        previous = { from: agent, output }

        const next = roster[index + 1]
        if (next) {
          brief =
            (await speak(
              orchestrator,
              { kind: 'brief', who: ORCHESTRATOR_LABEL, to: next.name },
              relayMessage(asked, agent, output, next),
            )) || asked
        } else {
          await speak(
            orchestrator,
            { kind: 'summary', who: ORCHESTRATOR_LABEL },
            summaryMessage(asked, agent, output),
          )
        }
      }
    } catch (caught) {
      if (isAbort(caught)) keepPartial('[stopped]')
      else keepPartial(messageOf(caught), true)
    } finally {
      orchestrator?.destroy()
      running.value = false
      pending.value = ''
      pendingStep.value = null
      controller = null
      // The team may have changed under a run — a model loaded for a hop is not one it still
      // names — and what the host keeps should follow the team, not the run.
      model.retain(teamModels(team.value))
    }
  }

  // A different model is a different run: the transcript was produced by weights that are about to
  // be unloaded, and the sessions on top of them have to go first.
  model.onChange(clear)

  onScopeDispose(() => {
    controller?.abort()
  })

  return {
    team,
    teamIsDefault,
    shareText,
    task,
    steps,
    pending,
    pendingStep,
    running,
    run,
    stop,
    clear,
    setTeam,
  }
}
