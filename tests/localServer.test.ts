import { describe, expect, it } from 'vitest'
import { normalizeBaseUrl } from '../src/lib/providers/localServerUrl'
import { toModelChoice } from '../src/lib/providers/localServerModels'

// The storage and discovery halves of this provider are browser-bound and covered by the e2e
// suite, the same way the OpenRouter key and its added models are. What is pure is the reading of
// what the reader typed, and the shape of the catalogue entry it becomes.

describe('normalizeBaseUrl', () => {
  it('adds the scheme a local address is usually written without', () => {
    expect(normalizeBaseUrl('localhost:11434')).toBe('http://localhost:11434/v1')
    expect(normalizeBaseUrl('127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1')
  })

  it('adds the OpenAI route when the address stops at the host', () => {
    expect(normalizeBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1')
    expect(normalizeBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1')
  })

  it('leaves a route that is already there alone', () => {
    expect(normalizeBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1')
    expect(normalizeBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1')
    // An unusual version segment is the server's business, not ours to correct.
    expect(normalizeBaseUrl('http://localhost:8000/v2')).toBe('http://localhost:8000/v2')
  })

  it('accepts the endpoint itself, which is what a curl example carries', () => {
    expect(normalizeBaseUrl('http://localhost:11434/v1/chat/completions')).toBe(
      'http://localhost:11434/v1',
    )
  })

  it('keeps a path a server is mounted under', () => {
    expect(normalizeBaseUrl('http://localhost:8080/llama')).toBe('http://localhost:8080/llama/v1')
  })

  it('does not insist on loopback — a server on the network is the reader’s call', () => {
    expect(normalizeBaseUrl('192.168.1.5:11434')).toBe('http://192.168.1.5:11434/v1')
    expect(normalizeBaseUrl('https://gpu.lan/v1')).toBe('https://gpu.lan/v1')
  })

  it('reads anything unusable as "not configured" rather than as an error', () => {
    // A half-typed address in a settings field is not a failure yet.
    expect(normalizeBaseUrl('')).toBe('')
    expect(normalizeBaseUrl('   ')).toBe('')
    expect(normalizeBaseUrl('http://')).toBe('')
    expect(normalizeBaseUrl(':::')).toBe('')
  })

  it('is idempotent, since what it returns is what gets stored and read back', () => {
    const once = normalizeBaseUrl('localhost:11434')
    expect(normalizeBaseUrl(once)).toBe(once)
  })
})

describe('toModelChoice', () => {
  const entry = { model: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder', thinking: false }

  it('namespaces the id so it cannot collide with a catalogue or OpenRouter one', () => {
    expect(toModelChoice(entry).id).toBe('local:qwen2.5-coder:7b')
    expect(toModelChoice(entry).model).toBe('qwen2.5-coder:7b')
  })

  it('downloads nothing into the browser, so it reads the way a hosted entry does', () => {
    expect(toModelChoice(entry).size).toBe('no download')
    expect(toModelChoice(entry).provider).toBe('localserver')
  })

  it('carries no contextTokens, which is WebLLM-only', () => {
    // `tests/chat.test.ts` refuses the figure on every other provider's entries; a reader-added
    // one has to keep the same rule, and there is nothing to read it from anyway.
    expect(toModelChoice(entry).contextTokens).toBeUndefined()
  })

  it('leaves thinking absent rather than false, the shape a shipped entry has', () => {
    expect(toModelChoice(entry).thinking).toBeUndefined()
    expect(toModelChoice({ ...entry, thinking: true }).thinking).toBe(true)
  })

  it('takes the default code budget, or a smaller one named by hand', () => {
    expect(toModelChoice(entry).maxCodeChars).toBe(14_000)
    expect(toModelChoice({ ...entry, maxCodeChars: 4_000 }).maxCodeChars).toBe(4_000)
  })
})
