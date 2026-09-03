import { describe, expect, it } from 'vitest'
import {
  buildFragment,
  decodeShare,
  encodeShare,
  isFlagSet,
  parseFiles,
  parseFragment,
  parseParams,
  serializeFiles,
} from '../src/lib/share'

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

describe('parseParams', () => {
  it('reads the query string as well as the fragment', () => {
    const params = parseParams('?filename=App.tsx', '#src=z.abc')
    expect(params.get('filename')).toBe('App.tsx')
    expect(params.get('src')).toBe('z.abc')
  })

  it('lets the fragment win over the query string', () => {
    expect(parseParams('?lang=js', '#lang=tsx').get('lang')).toBe('tsx')
  })

  it('is case-insensitive about keys, since they get typed by hand', () => {
    expect(parseParams('?HideHeader=1', '').get('hideheader')).toBe('1')
    expect(parseParams('', '#FileName=a.ts').get('filename')).toBe('a.ts')
  })

  it('keeps values exactly as written', () => {
    expect(parseParams('?filename=My%20File.TS', '').get('filename')).toBe('My File.TS')
  })

  it('copes with an empty location', () => {
    expect(parseParams('', '').size).toBe(0)
  })
})

describe('isFlagSet', () => {
  it('is on when the key is present with no value', () => {
    expect(isFlagSet(parseParams('?hideHeader', ''), 'hideHeader')).toBe(true)
  })

  it('is on for the usual truthy spellings', () => {
    for (const value of ['true', '1', 'yes', 'on', 'anything']) {
      expect(isFlagSet(parseParams(`?hideHeader=${value}`, ''), 'hideHeader')).toBe(true)
    }
  })

  it('is off when explicitly disabled', () => {
    for (const value of ['false', '0', 'no', 'off', 'FALSE', ' 0 ']) {
      expect(isFlagSet(parseParams(`?hideHeader=${value}`, ''), 'hideHeader')).toBe(false)
    }
  })

  it('is off when absent', () => {
    expect(isFlagSet(parseParams('?src=x', ''), 'hideHeader')).toBe(false)
  })
})

describe('buildFragment', () => {
  it('writes the keys a share link carries', () => {
    expect(buildFragment({ src: 'z.abc', lang: 'tsx', filename: 'App.tsx' })).toBe(
      '#src=z.abc&lang=tsx&filename=App.tsx',
    )
  })

  it('drops empty and absent values', () => {
    expect(buildFragment({ src: 'z.abc', lang: 'ts', filename: null })).toBe('#src=z.abc&lang=ts')
    expect(buildFragment({ src: 'z.abc', filename: '' })).toBe('#src=z.abc')
    expect(buildFragment({ filename: undefined })).toBe('')
  })

  it('leaves a base64url payload untouched', () => {
    const payload = 'z.abcDEF123-_'
    expect(buildFragment({ src: payload })).toBe(`#src=${payload}`)
  })

  it('round-trips a filename that needs escaping', () => {
    for (const name of [
      'src/services/Connection.ts',
      'my file.ts',
      'a&b.ts',
      'hash#tag.ts',
      'plus+one.ts',
      'grüß.ts',
    ]) {
      const fragment = buildFragment({ src: 'z.abc', lang: 'ts', filename: name })
      expect(parseFragment(fragment).get('filename'), name).toBe(name)
      expect(parseFragment(fragment).get('src'), name).toBe('z.abc')
    }
  })
})

describe('several files in one payload', () => {
  const FILES = [
    { name: 'server.ts', text: "import db from './db'\nconst row = db.get(1)\n" },
    { name: 'db.ts', text: 'export default { get: (id) => id }\n' },
  ]

  it('round-trips names and source exactly', () => {
    expect(parseFiles(serializeFiles(FILES))).toEqual(FILES)
  })

  it('round-trips a file that ends without a newline', () => {
    // The newline before a header belongs to the header, so it is not added to the file above it.
    const files = [
      { name: 'a.ts', text: 'const a = 1' },
      { name: 'b.ts', text: 'const b = 2\n' },
      { name: 'c.ts', text: '' },
    ]
    expect(parseFiles(serializeFiles(files))).toEqual(files)
  })

  it('survives source that looks like a header but is not one', () => {
    const files = [{ name: 'a.ts', text: 'const arrow = `--8<--`\n// --8<-- not a header\n' }]
    expect(parseFiles(serializeFiles(files))).toEqual(files)
  })

  it('reads a payload written by hand, uncompressed', () => {
    // The newline in front of a header is the header's, so `a.ts` ends where its last line does;
    // write a blank line before the next header to give a file a trailing newline of its own.
    expect(parseFiles('--8<-- a.ts\nconst a = 1\n--8<-- lib/b.ts\nconst b = 2\n')).toEqual([
      { name: 'a.ts', text: 'const a = 1' },
      { name: 'lib/b.ts', text: 'const b = 2\n' },
    ])
    // Extra spacing in the header, and a name with a path in it, are both fine.
    expect(parseFiles('--8<--    src/a.ts  \nconst a = 1')).toEqual([
      { name: 'src/a.ts', text: 'const a = 1' },
    ])
  })

  it('treats a payload with no header at all as one unnamed file', () => {
    // Which is exactly what `src=` means, so a hand-written link can leave the ceremony out.
    expect(parseFiles('const answer = 42')).toEqual([{ name: null, text: 'const answer = 42' }])
    expect(parseFiles('')).toEqual([])
  })

  it('goes through the same z. / r. / literal rules as a single buffer', async () => {
    const payload = await encodeShare(serializeFiles(FILES))
    expect(payload.startsWith('z.')).toBe(true)
    expect(parseFiles((await decodeShare(payload))!)).toEqual(FILES)

    // The uncompressed form a browser without CompressionStream would write.
    const raw = `r.${btoa(serializeFiles(FILES)).replace(/=+$/, '')}`
    expect(parseFiles((await decodeShare(raw))!)).toEqual(FILES)
  })

  it('is worth bundling: one stream over the set beats a payload apiece', async () => {
    // The reason the whole strip goes into one payload. Files that import each other repeat each
    // other's names, and the second one compresses against the first.
    const body =
      "import { helper } from './helper'\nexport function run(value) {\n  return helper(value)\n}\n"
    const many = Array.from({ length: 6 }, (_, index) => ({
      name: `module-${index}.ts`,
      text: body,
    }))

    const bundled = await encodeShare(serializeFiles(many))
    const separate = (await Promise.all(many.map((file) => encodeShare(file.text)))).reduce(
      (total, payload) => total + payload.length,
      0,
    )
    expect(bundled.length).toBeLessThan(separate)
  })
})
