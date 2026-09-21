import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORCHESTRATOR,
  DEFAULT_REVIEW,
  DEFAULT_TASK,
  DEFAULT_TRIAGE,
  MAX_RELAY_CHARS,
  defaultTeam,
  handoffMessage,
  isDefaultTeam,
  kickoffMessage,
  normalizeTeam,
  orchestratorPrompt,
  parseTeam,
  relayLimit,
  relayMessage,
  serializeTeam,
  summaryMessage,
  teamModels,
  type AgentSpec,
} from '../src/lib/agents'
import { DEFAULT_ROLE, REVIEWER_BRIEF } from '../src/lib/chat'

const agent = (name: string, role = 'brief'): AgentSpec => ({ id: `id-${name}`, name, role })

const TASK = 'Find every place a path is built from user input.'

describe('the shipped team', () => {
  it('is the chat pane’s own reviewer, then triage over what it found', () => {
    const team = defaultTeam()
    expect(team.orchestrator).toBe(DEFAULT_ORCHESTRATOR)
    expect(team.agents.map((one) => one.name)).toEqual(['Review', 'Adversarial Triage'])
    expect(team.agents[0]!.role).toBe(DEFAULT_REVIEW)
    expect(team.agents[1]!.role).toBe(DEFAULT_TRIAGE)
  })

  it('asks its reviewer for a full report where the chat asks for a short answer', () => {
    // Same brief, different closing: an agent's report is the next agent's whole input, and a
    // system prompt asking for brevity would win over any orchestrator brief asking for more.
    expect(DEFAULT_REVIEW.startsWith(REVIEWER_BRIEF)).toBe(true)
    expect(DEFAULT_ROLE.startsWith(REVIEWER_BRIEF)).toBe(true)
    expect(DEFAULT_ROLE).toMatch(/keep answers short/i)
    expect(DEFAULT_REVIEW).not.toMatch(/keep answers short/i)
    expect(DEFAULT_REVIEW).toMatch(/in full/i)
  })

  it('keeps triage to the findings it was handed', () => {
    // A model given the code and a security brief hunts by default; a fresh claim in a triage
    // report is one nobody has ruled on, which is the whole point of the pass.
    expect(DEFAULT_TRIAGE).toMatch(/open none of your own/i)
    expect(DEFAULT_TRIAGE).toMatch(/not yours to report/i)
    expect(DEFAULT_TRIAGE).not.toMatch(/did not report/i)
  })

  it('gives a thinking orchestrator nothing to count', () => {
    // "Under 120 words" was a number a reasoning model spent minutes on, tallying and redrafting.
    // Shape is asked for; a figure is not.
    expect(DEFAULT_ORCHESTRATOR).not.toMatch(/\d+\s*words/i)
    expect(DEFAULT_ORCHESTRATOR).toMatch(/do not count/i)
  })

  it('tells the orchestrator it cannot read the code', () => {
    expect(DEFAULT_ORCHESTRATOR).toMatch(/do not see the code/i)
  })

  it('leaves what the review is about to the reader rather than naming one itself', () => {
    // The orchestrator cannot see the code, so it is the last participant that should be holding
    // opinions about what to look for. Its agents carry that; it carries the subject and the order.
    expect(DEFAULT_ORCHESTRATOR).toMatch(/reader's to decide|reader’s to decide/i)
    expect(DEFAULT_ORCHESTRATOR).toMatch(/do not substitute a review/i)
    // The taint vocabulary belongs to the agents that read code, not to the one that does not.
    expect(DEFAULT_ORCHESTRATOR).not.toMatch(/taint/i)
    expect(DEFAULT_ORCHESTRATOR).not.toMatch(/\bsinks?\b/i)
  })

  it('tells the orchestrator the report travels without it, so it must not rewrite one', () => {
    expect(DEFAULT_ORCHESTRATOR).toMatch(/word for word/i)
    expect(DEFAULT_ORCHESTRATOR).toMatch(/do not summarise/i)
    expect(DEFAULT_ORCHESTRATOR).toMatch(/do not restate/i)
  })

  it('recognises itself, and anything rewritten', () => {
    expect(isDefaultTeam(defaultTeam())).toBe(true)

    const renamed = defaultTeam()
    renamed.agents[0]!.name = 'Sweep'
    expect(isDefaultTeam(renamed)).toBe(false)

    const rebriefed = defaultTeam()
    rebriefed.orchestrator = 'Find the bugs.'
    expect(isDefaultTeam(rebriefed)).toBe(false)

    const extra = defaultTeam()
    extra.agents.push(agent('Third'))
    expect(isDefaultTeam(extra)).toBe(false)

    // Ids are per-session and never travel, so two teams that differ only there are the same team.
    const relabelled = defaultTeam()
    relabelled.agents[0]!.id = 'somewhere-else'
    expect(isDefaultTeam(relabelled)).toBe(true)
  })
})

describe('serializeTeam / parseTeam', () => {
  it('round-trips a team exactly', () => {
    const team = {
      orchestrator: 'Run the review.\n\nBrief them one at a time.',
      agents: [agent('Review', 'Look for taint flows.'), agent('Triage', 'Be skeptical.')],
    }
    const back = parseTeam(serializeTeam(team))
    expect(back?.orchestrator).toBe(team.orchestrator)
    expect(back?.agents.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'Review', role: 'Look for taint flows.' },
      { name: 'Triage', role: 'Be skeptical.' },
    ])
  })

  it('round-trips the shipped team', () => {
    const back = parseTeam(serializeTeam(defaultTeam()))
    expect(back).not.toBeNull()
    expect(isDefaultTeam(back!)).toBe(true)
  })

  it('keeps a brief that ends without a newline, and one that ends with several', () => {
    const team = {
      orchestrator: 'no trailing newline',
      agents: [agent('A', 'trailing\n\n'), agent('B', '')],
    }
    const back = parseTeam(serializeTeam(team))
    expect(back?.orchestrator).toBe('no trailing newline')
    expect(back?.agents[0]!.role).toBe('trailing\n\n')
    expect(back?.agents[1]!.role).toBe('')
  })

  it('survives a brief that contains the cut mark mid-line', () => {
    const team = { orchestrator: 'a --8<-- b', agents: [agent('One', 'still one agent')] }
    const back = parseTeam(serializeTeam(team))
    expect(back?.orchestrator).toBe('a --8<-- b')
    expect(back?.agents).toHaveLength(1)
  })

  it('reads a hand-written bundle', () => {
    const back = parseTeam('--8<-- orchestrator\nBrief them.\n--8<-- Scan\nLook at the code.')
    expect(back?.orchestrator).toBe('Brief them.')
    expect(back?.agents).toEqual([
      expect.objectContaining({ name: 'Scan', role: 'Look at the code.' }),
    ])
  })

  it('refuses a payload that is not a team', () => {
    // No headers at all, and an orchestrator with nobody to brief: both leave the reader's own
    // team alone rather than becoming a team of nothing.
    expect(parseTeam('just some prose')).toBeNull()
    expect(parseTeam('')).toBeNull()
    expect(parseTeam('--8<-- orchestrator\nalone')).toBeNull()
  })
})

describe('an agent on a model of its own', () => {
  it('rides the section header, and only when there is one', () => {
    const team = {
      orchestrator: 'Brief them.',
      agents: [agent('Review'), { ...agent('Triage'), model: 'gemma-4-e4b' }],
    }
    const text = serializeTeam(team)
    expect(text).toContain('--8<-- Review\n')
    expect(text).toContain('--8<-- Triage @gemma-4-e4b\n')
    expect(parseTeam(text)?.agents.map(({ name, model }) => ({ name, model }))).toEqual([
      { name: 'Review' },
      { name: 'Triage', model: 'gemma-4-e4b' },
    ])
  })

  it('reads a hand-written header, spaced either way', () => {
    const back = parseTeam(
      '--8<-- orchestrator\nBrief.\n--8<-- Scan @ qwen-coder-3b\nRead.\n--8<-- Check@builtin\nRule.',
    )
    expect(back?.agents.map(({ name, model }) => ({ name, model }))).toEqual([
      { name: 'Scan', model: 'qwen-coder-3b' },
      { name: 'Check', model: 'builtin' },
    ])
  })

  it('keeps a model the catalogue does not know, for the pane to say so', () => {
    const back = parseTeam('--8<-- orchestrator\nBrief.\n--8<-- Scan @no-such-model\nRead.')
    expect(back?.agents[0]!.model).toBe('no-such-model')
  })

  it('makes the shipped team a rewritten one', () => {
    const team = defaultTeam()
    team.agents[1]!.model = 'gemma-4-e4b'
    expect(isDefaultTeam(team)).toBe(false)
  })

  it('is stripped from a name that would otherwise read as one', () => {
    const team = normalizeTeam({ orchestrator: 'x', agents: [agent('Ask @ me')] })
    expect(team.agents[0]!.name).toBe('Ask me')
    expect(team.agents[0]!.model).toBeUndefined()
    // And the round trip now holds: the name comes back as the name.
    expect(parseTeam(serializeTeam(team))?.agents[0]!.name).toBe('Ask me')
  })

  it('is dropped by normalisation when blank, and kept when set', () => {
    const team = normalizeTeam({
      orchestrator: 'x',
      agents: [
        { ...agent('A'), model: '  ' },
        { ...agent('B'), model: 'builtin' },
      ],
    })
    expect(team.agents[0]).not.toHaveProperty('model')
    expect(team.agents[1]!.model).toBe('builtin')
  })

  it('is what the team asks the host to keep, each model once', () => {
    expect(
      teamModels({
        orchestrator: 'x',
        agents: [
          agent('A'),
          { ...agent('B'), model: 'gemma-4-e4b' },
          { ...agent('C'), model: 'gemma-4-e4b' },
          { ...agent('D'), model: 'builtin' },
        ],
      }),
    ).toEqual(['gemma-4-e4b', 'builtin'])
    expect(teamModels(defaultTeam())).toEqual([])
  })
})

describe('normalizeTeam', () => {
  it('names the unnamed and numbers the duplicates', () => {
    const team = normalizeTeam({
      orchestrator: 'Brief them.',
      agents: [agent('  ', 'a'), agent('Review', 'b'), agent('Review', 'c')],
    })
    expect(team.agents.map((one) => one.name)).toEqual(['Agent 1', 'Review', 'Review 2'])
  })

  it('flattens a name that would break a bundle', () => {
    const team = normalizeTeam({
      orchestrator: 'x',
      agents: [agent('two\nlines', 'a')],
    })
    expect(team.agents[0]!.name).toBe('two lines')
  })

  it('falls back to the shipped agents rather than keeping none', () => {
    const team = normalizeTeam({ orchestrator: 'x', agents: [] })
    expect(team.agents.map((one) => one.name)).toEqual(['Review', 'Adversarial Triage'])
  })

  it('falls back to the shipped brief rather than sending an empty one', () => {
    expect(normalizeTeam({ orchestrator: '   ', agents: [agent('A')] }).orchestrator).toBe(
      DEFAULT_ORCHESTRATOR,
    )
  })
})

describe('the orchestrator’s prompt', () => {
  it('carries the roster in running order', () => {
    const prompt = orchestratorPrompt('Brief them.', [agent('Review'), agent('Triage')])
    expect(prompt).toContain('Brief them.')
    expect(prompt).toContain('1. Review')
    expect(prompt).toContain('2. Triage')
    expect(prompt).toContain('2 agents')
  })

  it('does not claim a second agent when there is one', () => {
    const prompt = orchestratorPrompt('Brief them.', [agent('Review')])
    expect(prompt).toContain('one agent')
    expect(prompt).not.toContain('2. ')
  })

  it('falls back to the shipped brief when the reader empties it', () => {
    expect(orchestratorPrompt('   ', [agent('Review')])).toContain(DEFAULT_ORCHESTRATOR)
  })
})

describe('the messages each hop is asked', () => {
  it('opens with the reader’s task and names the first agent', () => {
    const message = kickoffMessage('Look for SQL injection.', agent('Review'))
    expect(message).toContain('Look for SQL injection.')
    expect(message).toContain('Review')
  })

  it('hands one agent’s report to the orchestrator and names who is next', () => {
    const message = relayMessage(TASK, agent('Review'), 'Found a flow.', agent('Triage'))
    expect(message).toContain('Review')
    expect(message).toContain('Found a flow.')
    expect(message).toContain('Triage')
  })

  it('tells the orchestrator, at the point of asking, not to rewrite what it just read', () => {
    const message = relayMessage(TASK, agent('Review'), 'Found a flow.', agent('Triage'))
    expect(message).toMatch(/word for word/i)
    expect(message).toMatch(/do not summarise it/i)
    expect(message).toMatch(/do not reword/i)
  })

  it('puts the reader’s task in front of the orchestrator at every brief, not just the first', () => {
    // A task mentioned once is a task a small model has drifted away from by the second brief —
    // back towards whatever its own instructions made salient.
    for (const message of [
      kickoffMessage(TASK, agent('Review')),
      relayMessage(TASK, agent('Review'), 'Found a flow.', agent('Triage')),
      summaryMessage(TASK, agent('Triage'), 'Two confirmed.'),
    ]) {
      expect(message).toContain(TASK)
      expect(message).toMatch(/task for this run/i)
    }
  })

  it('falls back to the shipped task when the box was emptied', () => {
    expect(kickoffMessage('   ', agent('Review'))).toContain(DEFAULT_TASK)
  })

  it('closes with the last agent’s report', () => {
    const message = summaryMessage(TASK, agent('Triage'), 'Two confirmed.')
    expect(message).toContain('Two confirmed.')
    expect(message).toMatch(/final summary/i)
  })

  it('gives the first agent the brief alone', () => {
    expect(handoffMessage('Look at the routes.', null)).toBe('Look at the routes.')
  })

  it('gives every later agent the previous report verbatim, not a paraphrase', () => {
    const report = '1. `req.body.name` (routes.ts line 4) — source'
    const message = handoffMessage('Check these.', { from: agent('Review'), output: report })
    expect(message).toContain('Check these.')
    expect(message).toContain(report)
    expect(message).toContain('Review')
    expect(message).toMatch(/exactly as it was written/i)
  })

  it('tells the agent the verbatim verdict wins over the brief describing it', () => {
    // The orchestrator is told not to rewrite a verdict, and mostly does not. "Mostly" is not
    // something the next agent can be left to resolve on its own.
    const message = handoffMessage('Review found nothing much.', {
      from: agent('Review'),
      output: 'CONFIRMED: SQL injection at db.ts line 9.',
    })
    expect(message).toMatch(/authoritative/i)
    expect(message).toMatch(/not from any description of it/i)
  })

  it('clips a report that would crowd out the code, and says it clipped it', () => {
    const huge = 'x'.repeat(MAX_RELAY_CHARS + 500)
    const message = handoffMessage('Check these.', { from: agent('Review'), output: huge })
    expect(message).toContain('truncated')
    expect(message.length).toBeLessThan(huge.length)
    expect(message).toContain('x'.repeat(100))
  })

  it('hands a model with room for more code a longer report to match', () => {
    // The floor was sized for a 14 000-character code budget. A model that can hold 60 000 of
    // code is not served by triage seeing 6 000 of a review written over all of it.
    expect(relayLimit(14_000)).toBe(MAX_RELAY_CHARS)
    expect(relayLimit(1_000)).toBe(MAX_RELAY_CHARS)
    expect(relayLimit(60_000)).toBe(20_000)

    const report = 'x'.repeat(MAX_RELAY_CHARS + 500)
    const previous = { from: agent('Review'), output: report }
    const wide = handoffMessage('Check these.', previous, relayLimit(60_000))
    expect(wide).not.toContain('truncated')
    expect(wide).toContain(report)
    // The orchestrator's two messages take the same limit, since it reads them on its own model.
    expect(relayMessage(TASK, agent('Review'), report, agent('Triage'), 20_000)).toContain(report)
    expect(summaryMessage(TASK, agent('Review'), report, 20_000)).toContain(report)
    expect(summaryMessage(TASK, agent('Review'), report)).toContain('truncated')
  })
})
