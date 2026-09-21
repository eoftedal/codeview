import { describe, expect, it } from 'vitest'
import { HUNTERS, HUNTER_CHAR_CAP, HUNTER_NAMES } from '../src/lib/hunters'
import { DEFAULT_ROLE } from '../src/lib/chat'
import { parseSections, serializeSections } from '../src/lib/share'

const entries = Object.entries(HUNTERS)

describe('the hunting briefs', () => {
  it('covers the classic classes a reader would come looking for', () => {
    // Not an exhaustive list — the point is that the obvious ones are not missing.
    for (const term of [
      /SQL/,
      /command injection/i,
      /XSS/,
      /SSRF/,
      /path traversal/i,
      /BOLA/,
      /mass assignment/i,
      /prototype pollution/i,
      /deserialization/i,
      /template injection/i,
      /open redirect/i,
      /CSRF/,
      /crypt/i,
    ]) {
      expect(HUNTER_NAMES.some((name) => term.test(name))).toBe(true)
    }
    expect(HUNTER_NAMES).toEqual(Object.keys(HUNTERS))
  })

  it('is briefer than the shipped brief, which is the whole reason they exist', () => {
    // A hunter arrives knowing what it is looking for, so it can skip the vocabulary lesson and
    // leave the difference to the code listing — which is what gets clipped on a small model.
    for (const [name, text] of entries) {
      expect(text.length, name).toBeLessThan(HUNTER_CHAR_CAP)
      expect(text.length, name).toBeLessThan(DEFAULT_ROLE.length)
    }
  })

  it('names its own class in its opening line', () => {
    for (const [name, text] of entries) {
      expect(text.slice(0, 200), name).toContain(name)
    }
  })

  it('hunts one class and reports nothing else', () => {
    // Two agents each hunting everything is one agent run twice. A hunter that wanders is also a
    // hunter whose report the next one cannot rule on.
    for (const [name, text] of entries) {
      expect(text, name).toMatch(/only thing you report/i)
      expect(text, name).toMatch(/Report no other class/i)
    }
  })

  it('keeps the citation and honesty rules every brief here carries', () => {
    for (const [name, text] of entries) {
      // The rule that stops an invented line number: check the name is on the line first.
      expect(text, name).toMatch(/actually appears on that line/i)
      // Findings are paths, not adjectives.
      expect(text, name).toMatch(/one numbered step per hop/i)
      // An empty hunt is a result. Without this a model reaches for something to report.
      expect(text, name).toMatch(/say plainly when you find nothing/i)
    }
  })

  it('gives each class its own text', () => {
    expect(new Set(Object.values(HUNTERS)).size).toBe(entries.length)
  })

  it('survives a team link', () => {
    // A hunter usually ends up as an agent's brief, and a team travels as a `--8<--` bundle: a
    // line starting with the marker inside a brief would come back out of a link as two agents.
    const sections = entries.map(([name, text]) => ({ name, text }))
    expect(parseSections(serializeSections(sections))).toEqual(sections)
  })
})
