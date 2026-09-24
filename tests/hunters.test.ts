import { describe, expect, it } from 'vitest'
import { HUNTERS, HUNTER_CHAR_CAP, HUNTER_NAMES } from '../src/lib/hunters'
import { DEFAULT_ROLE } from '../src/lib/chat'
import { parseSections, serializeSections } from '../src/lib/share'

const entries = Object.entries(HUNTERS)

/**
 * The classes with no path to report — a missing check, a cookie flag, a key in the source. These
 * get the closing that asks for a where and a what-is-missing rather than a hop-by-hop flow, and
 * adding a class means deciding which shape it is.
 */
const CHECKLISTS = [
  'Broken object-level authorization (BOLA/IDOR)',
  'Missing function-level authorization',
  'CSRF & cross-origin',
  'Authentication & sessions',
  'Secrets & weak cryptography',
]

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
      /input validation/i,
    ]) {
      expect(HUNTER_NAMES.some((name) => term.test(name))).toBe(true)
    }
    expect(HUNTER_NAMES).toEqual(Object.keys(HUNTERS))
    expect(HUNTER_NAMES).toEqual(expect.arrayContaining(CHECKLISTS))
  })

  it('is briefer than the shipped brief, which is the whole reason they exist', () => {
    // A hunter arrives knowing what it is looking for, so it can skip the vocabulary lesson and
    // leave the difference to the code listing — which is what gets clipped on a small model.
    for (const [name, text] of entries) {
      expect(text.length, name).toBeLessThan(HUNTER_CHAR_CAP)
      expect(text.length, name).toBeLessThan(DEFAULT_ROLE.length)
    }
  })

  it('names its own class in a one-line opening', () => {
    // The opening rides every hunt, so it is where a saved character counts sixteen times over.
    // One line is room for a role and a class, and no room for a lesson in what untrusted data is.
    for (const [name, text] of entries) {
      const first = text.slice(0, text.indexOf('\n\n'))
      expect(first, name).toContain(name)
      expect(first.length, name).toBeLessThan(200)
    }
  })

  it('hunts one class and reports nothing else', () => {
    // Two agents each hunting everything is one agent run twice. A hunter that wanders is also a
    // hunter whose report the next one cannot rule on.
    for (const [name, text] of entries) {
      expect(text, name).toMatch(/single-issue hunt/i)
      expect(text, name).toMatch(/Report no other class/i)
    }
  })

  it('keeps the citation and honesty rules every brief here carries', () => {
    for (const [name, text] of entries) {
      // The rule that stops an invented line number: check the name is on the line first.
      expect(text, name).toMatch(/actually appears on that line/i)
      // An empty hunt is a result. Without this a model reaches for something to report.
      expect(text, name).toMatch(/say plainly when you find nothing/i)
    }
  })

  it('shows a flow hunter the shape of a path, and asks a checklist hunter for none', () => {
    for (const [name, text] of entries) {
      if (CHECKLISTS.includes(name)) {
        // A missing authorization check has no source and no sink; asking for hops invites a
        // model to invent them.
        expect(text, name).not.toMatch(/one numbered step per hop/i)
        expect(text, name).toMatch(/what is missing/i)
      } else {
        // Findings are paths, not adjectives — and the shape is shown, not described.
        expect(text, name).toMatch(/one numbered step per hop/i)
        expect(text, name).toMatch(/^1\. /m)
      }
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
