import { describe, expect, it } from 'vitest'
import { decodeShare, encodeShare, parseFragment } from '../src/lib/share'

describe('encodeShare / decodeShare', () => {
  it('round-trips a buffer through deflate', async () => {
    const source = "const greeting = 'hello'\nfunction greet(name) {\n  return name + greeting\n}\n"
    const payload = await encodeShare(source)
    expect(payload.startsWith('z.')).toBe(true)
    expect(await decodeShare(payload)).toBe(source)
  })

  it('round-trips text that is not ASCII', async () => {
    const source = "const emoji = '🌱 grüß dich'\n"
    expect(await decodeShare(await encodeShare(source))).toBe(source)
  })

  it('decodes an uncompressed r. payload', async () => {
    const payload = `r.${btoa('const x = 1').replace(/=+$/, '')}`
    expect(await decodeShare(payload)).toBe('const x = 1')
  })
})

describe('hand-written links', () => {
  it('treats an unprefixed payload as literal source', async () => {
    expect(await decodeShare('const x = 1')).toBe('const x = 1')
  })

  it('keeps source that happens to start with z.', async () => {
    // Not valid base64 after the prefix, so it can only be source.
    expect(await decodeShare('z.trim(name)')).toBe('z.trim(name)')
  })

  it('keeps z.-prefixed source that is accidentally valid base64', async () => {
    // 'abcd' decodes as base64 but is not a deflate stream.
    expect(await decodeShare('z.abcd')).toBe('z.abcd')
  })

  it('keeps r.-prefixed source that is not base64', async () => {
    expect(await decodeShare('r.map(fn)')).toBe('r.map(fn)')
  })
})

describe('parseFragment', () => {
  it('reads src and lang', () => {
    const params = parseFragment('#src=z.abc&lang=tsx')
    expect(params.get('src')).toBe('z.abc')
    expect(params.get('lang')).toBe('tsx')
  })

  it('percent-decodes a hand-written buffer', () => {
    expect(parseFragment('#src=const%20x%20%3D%201').get('src')).toBe('const x = 1')
  })

  it('leaves + alone, unlike URLSearchParams', () => {
    // URLSearchParams would turn this into 'a b' and quietly corrupt the source.
    expect(parseFragment('#src=a+b').get('src')).toBe('a+b')
    expect(new URLSearchParams('src=a+b').get('src')).toBe('a b')
  })

  it('keeps a malformed escape rather than dropping the key', () => {
    expect(parseFragment('#src=100%%20done').get('src')).toBe('100%%20done')
  })

  it('survives an empty or absent fragment', () => {
    expect(parseFragment('').size).toBe(0)
    expect(parseFragment('#').size).toBe(0)
  })

  it('does not mistake an equals sign in the value for a separator', () => {
    expect(parseFragment('#src=const%20x%20=%201').get('src')).toBe('const x = 1')
  })
})
