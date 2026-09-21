/**
 * The agents tab: an orchestrator and a line of sub-agents, run one after the other over the open
 * files.
 *
 * The division of labour is the whole point, and it is deliberate. **The orchestrator never sees
 * the code.** It is given the roster and the reader's task, it writes each agent's brief, it is
 * handed each agent's answer, and it writes the summary at the end — so it can only ever reason
 * about what the agents reported, never about lines it imagined. **Every sub-agent sees every open
 * file**, exactly the way the chat pane's model does, through the same `buildSystemPrompt`.
 *
 * Everything here is pure: the prompts, the message each hop is asked, and the link format. Running
 * them is `useAgents`.
 */

import { REVIEWER_BRIEF } from './chat'
import { parseSections, serializeSections } from './share'

export interface AgentSpec {
  /** Stable across a rename, so a Vue list and an in-flight run both keep pointing at the same
   *  agent. Never serialized: a link carries names. */
  id: string
  name: string
  /** This agent's half of its system prompt. The open files are appended to it. */
  role: string
  /**
   * A `ModelChoice.id` this agent runs on instead of the run's own — the picker's model, which
   * the orchestrator always uses. Absent means the run's. It is kept as an id rather than
   * resolved, so a team written on a machine that can run a model survives being opened on one
   * that cannot; whether it can is the run's question, and the pane's to show.
   */
  model?: string
}

export interface AgentTeam {
  /** The orchestrator's brief. No files are appended to this one. */
  orchestrator: string
  agents: AgentSpec[]
}

let seq = 0

export function createAgentId(): string {
  seq += 1
  return `a${Date.now().toString(36)}-${seq}`
}

/**
 * The orchestrator's brief. It is told plainly that it cannot read the code, because a model that
 * forgets this starts inventing file names — and it is the one participant here with no files in
 * its context to contradict it.
 */
export const DEFAULT_ORCHESTRATOR = `You are the orchestrator of a code review. You do not see the code. You cannot open a file, you cannot read a line, and you must never claim to have done either. What you have is a team of agents who do see the code: your job is to brief them one at a time, to read what each one reports back, and to carry that forward to the next.

**What the review is about is the reader's to decide, not yours.** Their task is given to you with every brief you are asked for, and it is the subject of the run: each brief you write serves that task and nothing else. Do not substitute a review you would rather run, do not widen a narrow task into a general audit, and do not narrow a broad one to the first thing that occurs to you. The agents already know their own trade — each carries its own brief describing what it is and how it reads code — so you are not the one who supplies the expertise. You supply the subject, the order, and the hand-off.

When you are asked to brief an agent, reply with the instruction for that agent and nothing else — no preamble, no commentary, no findings of your own. Write it as a direct instruction: a short paragraph, or a few bullets, saying what to look for, what to check, and what shape the answer should take. A brief is a pointer, not the review — write it once and stop; do not count its words, weigh its wording or draft it twice. The agent is already told who it is by its own brief, so do not repeat its role back to it.

**The previous agent's report is handed to the next agent in full, word for word, alongside your brief.** You are not the one who carries it, so do not carry it: do not summarise its findings, do not restate its verdicts in your own words, do not shorten its list, do not correct it, and do not add findings of your own. Rewriting a report is how a line number turns into the wrong line number and a "mitigated" turns into a "confirmed". Quoting a few words to point at one item is fine; reproducing or rewording the report is not. Your brief says what the next agent should *do* with the text it is about to read — nothing else.

When you are asked for the final summary, write the result of the review as an answer to the reader's task: what the agents found, each finding in the terms they reported it — if they traced a path through the code, give the path — and then a one-line verdict. Say plainly when nothing was found; an empty review is a result, not a failure. Never report a finding no agent reported, and never cite a file or line number no agent cited.`

/**
 * The first agent's brief: the chat's reviewer, closed the other way. The chat asks for a short
 * answer because a reader is waiting on one question; an agent's report is the *entire* input of
 * the agent after it, and a hop it leaves out for brevity is a hop nobody checks. The orchestrator's
 * brief asks for the shape it wants, but a system prompt beats a message every time — which is
 * why the brevity line cannot simply be overridden from there and has to be absent here.
 */
export const DEFAULT_REVIEW = `${REVIEWER_BRIEF} Report every flow you find, each in full: your report is all the next reviewer has to work from, and a hop you leave out is one nobody will check.`

/**
 * The second agent's brief: not a second look for bugs, but a ruling on the first look — which is
 * why it is told, twice, to open no finding of its own. A model handed code and a security brief
 * hunts by default, and a triage report padded with fresh claims nobody has triaged is exactly the
 * unchecked output the pass exists to catch.
 */
export const DEFAULT_TRIAGE = `You are an adversarial security reviewer, and your job is triage: deciding which of the findings another reviewer has just reported are real. You are not here to agree, and you are not here to run a review of your own. A reviewer who confirms everything is worth nothing, and so is one who dismisses everything. Read the code as closely as each finding demands — but along the paths you were handed: you rule on those findings, and open none of your own.

You have the code in front of you. Take the findings one at a time:

1. **Check the citation.** Go to the file and line the finding names and confirm that the code there actually contains what is claimed — the same names, the same call, the same assignment. A finding whose cited line does not say what it claims is wrong, and you say so plainly.
2. **Walk the flow yourself**, hop by hop, from the named source to the named sink, and look for what the first reviewer missed: a validation, an encoding, a parameterised query, an escape, a cast to a type that cannot carry an injection, a branch that cannot be reached, a sink that is not really a sink.
3. **Rule on it.** Every finding gets one of three verdicts: **confirmed** — the flow is real and nothing on the path removes the taint; **mitigated** — the weakness is real, but something on the path removes the taint today, and you name it with its file and line; still report the weakness, since the next change to that path may not; **not a finding** — the code does not say what was claimed, or there is no flow from that source to that sink at all.

Be hard on vague claims. "User input could be dangerous here", with no source, no sink and no path, is not a finding and does not become one by being repeated. Do not soften a verdict to be agreeable, and do not confirm a finding because it was stated confidently.

Report one entry per finding: the claim in a few words, the verdict in bold, and one or two sentences of reasoning citing file and line. Rule on the findings you were given and nothing else: do not open a finding of your own, and do not add a weakness you noticed while walking someone else's. A finding nobody has reported to you is not yours to report — what you were asked for is a ruling, and every entry in your report answers a claim the reviewer before you made.`

/** The team a reader starts with: the chat's reviewer asked for a full report, then triage over it. */
export function defaultTeam(): AgentTeam {
  return {
    orchestrator: DEFAULT_ORCHESTRATOR,
    agents: [
      { id: createAgentId(), name: 'Review', role: DEFAULT_REVIEW },
      { id: createAgentId(), name: 'Adversarial Triage', role: DEFAULT_TRIAGE },
    ],
  }
}

/** The task box's opening line — what a run does when the reader changes nothing. */
export const DEFAULT_TASK = 'Review this code for security vulnerabilities.'

/**
 * Whether the team is still the shipped one. The same rule the chat's brief follows: a team that
 * has not been touched is not stored and not written into a link, so a later edit to the defaults
 * above reaches everyone who never wrote their own.
 */
export function isDefaultTeam(team: AgentTeam): boolean {
  const shipped = defaultTeam()
  if (team.orchestrator !== shipped.orchestrator) return false
  if (team.agents.length !== shipped.agents.length) return false
  return team.agents.every(
    (agent, index) =>
      agent.name === shipped.agents[index]!.name &&
      agent.role === shipped.agents[index]!.role &&
      !agent.model,
  )
}

/** The header the orchestrator's section takes in a link. Only its position matters on the way
 *  back in — it is the first section, whatever it is called. */
const ORCHESTRATOR_SECTION = 'orchestrator'

/**
 * What separates an agent's name from its model in a section header: `--8<-- Triage @gemma-4-e4b`.
 * Reserved, which is why `normalizeTeam` strips it from names — a name carrying one would be read
 * back as a shorter name on a model nobody chose.
 */
const MODEL_MARK = '@'
const MODEL_HEADER = /^(.*?)\s*@\s*(\S+)$/

function agentHeader(agent: AgentSpec): string {
  return agent.model ? `${agent.name} ${MODEL_MARK}${agent.model}` : agent.name
}

/**
 * The team as one text, in the same `--8<--` bundle format the files travel in, so a link can be
 * written or read by hand. The orchestrator goes first; every section after it is an agent, in the
 * order they run. An agent on a model of its own says so in its header.
 */
export function serializeTeam(team: AgentTeam): string {
  return serializeSections([
    { name: ORCHESTRATOR_SECTION, text: team.orchestrator },
    ...team.agents.map((agent) => ({ name: agentHeader(agent), text: agent.role })),
  ])
}

/**
 * The inverse. Null for a payload that is not a team at all — no header, or nothing after the
 * orchestrator — since falling back to "one agent called nothing" would be worse than leaving the
 * reader's own team alone.
 */
export function parseTeam(payload: string): AgentTeam | null {
  const sections = parseSections(payload)
  if (sections.length < 2) return null
  const [orchestrator, ...agents] = sections
  return {
    orchestrator: orchestrator!.text,
    agents: agents.map((agent) => {
      const header = MODEL_HEADER.exec(agent.name)
      return {
        id: createAgentId(),
        name: header ? header[1]! : agent.name,
        role: agent.text,
        ...(header ? { model: header[2]! } : {}),
      }
    }),
  }
}

/**
 * The team as it is actually kept: names trimmed to one line, blanks named, duplicates numbered,
 * and a model kept only where one was actually chosen.
 *
 * A name is not decoration — it goes into the orchestrator's roster, into every brief, and into the
 * link as a section header — so a name with a newline in it would quietly break a bundle, two
 * agents answering to one name would leave the orchestrator briefing whichever it meant, and a
 * name holding the model mark would come back out of a link as a different agent on a model of
 * its own.
 */
export function normalizeTeam(team: AgentTeam): AgentTeam {
  const taken: string[] = []
  const agents = (team.agents.length > 0 ? team.agents : defaultTeam().agents).map(
    (agent, index) => {
      const cleaned =
        agent.name.replaceAll(MODEL_MARK, '').replace(/\s+/g, ' ').trim() || `Agent ${index + 1}`
      let name = cleaned
      for (let n = 2; taken.includes(name); n += 1) name = `${cleaned} ${n}`
      taken.push(name)
      const model = agent.model?.trim()
      return {
        id: agent.id || createAgentId(),
        name,
        role: agent.role,
        ...(model ? { model } : {}),
      }
    },
  )
  return {
    orchestrator: team.orchestrator.trim() ? team.orchestrator : DEFAULT_ORCHESTRATOR,
    agents,
  }
}

/** The models a team names for its agents, each once — what has to be loadable for it to run. */
export function teamModels(team: AgentTeam): string[] {
  return [...new Set(team.agents.flatMap((agent) => (agent.model ? [agent.model] : [])))]
}

/** A name for a new agent that is not already on the roster. */
export function untitledAgentName(taken: readonly string[]): string {
  for (let n = 3; ; n += 1) {
    const name = `Agent ${n}`
    if (!taken.includes(name)) return name
  }
}

/**
 * The least of an agent's answer that is carried to the next hop verbatim, whatever the model. The
 * smallest models here have a few thousand tokens for everything, system prompt included, and an
 * answer that fills the window leaves no room for the code the next agent has to check it against.
 * Clipping is stated rather than silent — a reviewer told it is reading half a report behaves
 * differently from one that thinks it has the whole thing.
 */
export const MAX_RELAY_CHARS = 6_000

/**
 * How much of a report a given model is handed. The floor above was sized for a 14 000-character
 * code budget; a model with room for 60 000 characters of code has room for a report to match,
 * and a thorough review of a large listing easily runs past 6 000 characters — clipping it there
 * would hand triage half the findings for no reason. A third of the code budget, never less than
 * the floor: the report is checked *against* the code, so the code keeps the larger share.
 */
export function relayLimit(maxCodeChars: number): number {
  return Math.max(MAX_RELAY_CHARS, Math.floor(maxCodeChars / 3))
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}\n\n[…truncated: this report was longer than fits here]`
}

/** The orchestrator's system prompt: its own brief, plus who it has to work with. It cannot be
 *  told what the code is, so the roster is the only context it gets. */
export function orchestratorPrompt(role: string, agents: readonly AgentSpec[]): string {
  const roster = agents.map((agent, index) => `${index + 1}. ${agent.name}`).join('\n')
  return [
    role.trim() || DEFAULT_ORCHESTRATOR,
    '',
    agents.length === 1
      ? 'You have one agent, and it runs once:'
      : `You have ${agents.length} agents, and they run in this order, each one seeing what the one before it reported:`,
    '',
    roster,
    '',
    'They are the only ones who can read the code. You will be asked for one brief at a time.',
  ].join('\n')
}

/**
 * The reader's task, restated as the thing every brief has to serve.
 *
 * It rides *every* message the orchestrator is asked for rather than only the first. A task
 * mentioned once at the top of a conversation is a task a small model has drifted away from by the
 * second brief — back towards whatever its own instructions made salient, which is exactly the
 * failure this is here to stop.
 */
function taskBlock(task: string): string {
  return [
    'The reader’s task for this run — the thing every brief you write must serve:',
    '',
    task.trim() || DEFAULT_TASK,
  ].join('\n')
}

/** Asking the orchestrator to open the run. */
export function kickoffMessage(task: string, first: AgentSpec): string {
  return [
    taskBlock(task),
    '',
    `Write the brief for **${first.name}**, the first agent, in service of that task. Reply with that brief and nothing else.`,
  ].join('\n')
}

/**
 * Asking the orchestrator to hand one agent's report on to the next.
 *
 * It is shown the report because it has to brief against it — but told twice, here and in its own
 * prompt, that the report travels on its own. A model given a verdict and asked to write about it
 * will rewrite it by default, and a rewritten verdict is worse than no verdict: it arrives in the
 * next agent's context contradicting the copy beside it, in a voice that sounds equally
 * authoritative.
 *
 * `limit` is the orchestrator's own model's `relayLimit`, not the next agent's: this copy is read
 * by the orchestrator, and the next agent gets its own in `handoffMessage`.
 */
export function relayMessage(
  task: string,
  from: AgentSpec,
  output: string,
  next: AgentSpec,
  limit: number = MAX_RELAY_CHARS,
): string {
  return [
    taskBlock(task),
    '',
    `**${from.name}** reported this:`,
    '',
    clip(output, limit),
    '',
    `**${next.name}** runs next, and will be given that report in full, word for word, alongside your brief — so do not summarise it, do not restate its verdicts and do not reword its findings. Write only the brief: what **${next.name}** should do with the report it is about to read. Reply with that brief and nothing else.`,
  ].join('\n')
}

/** Asking the orchestrator to close the run. */
export function summaryMessage(
  task: string,
  from: AgentSpec,
  output: string,
  limit: number = MAX_RELAY_CHARS,
): string {
  return [
    taskBlock(task),
    '',
    `**${from.name}**, the last agent, reported this:`,
    '',
    clip(output, limit),
    '',
    'That is the end of the run. Write the final summary, and let it answer the reader’s task above — not a different question you would rather have been asked.',
  ].join('\n')
}

/**
 * What an agent is actually asked: the orchestrator's brief, and — for every agent after the first
 * — the previous agent's report verbatim. The report is passed on rather than left to the
 * orchestrator's paraphrase because the details are the part that matters: a file, a line and a
 * name survive a relay only if they are copied.
 *
 * The last line is the one that has to be here. The orchestrator is told not to rewrite a verdict,
 * and mostly does not, but "mostly" is not a guarantee you can build on — so when its brief and the
 * report below it disagree, the agent is told outright which of the two to believe. The copy that
 * was not written by a model in the middle.
 */
export function handoffMessage(
  brief: string,
  previous: { from: AgentSpec; output: string } | null,
  limit: number = MAX_RELAY_CHARS,
): string {
  if (!previous) return brief.trim()
  return [
    brief.trim(),
    '',
    `This is the verdict from **${previous.from.name}**, the agent before you, exactly as it was written:`,
    '',
    clip(previous.output, limit),
    '',
    `Work from that text itself, not from any description of it. Where the brief above characterises it differently — a different verdict, a different finding, a different line — the text above is what is authoritative.`,
  ].join('\n')
}
