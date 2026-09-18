/**
 * Share links. The buffer lives in the URL fragment, which browsers never send to the server, so
 * shared code stays between the people holding the link.
 */

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function pipe(bytes: Uint8Array, transform: TransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Keys whose value is prose rather than code, and which therefore take the ordinary query-string
 * reading: `+` is a space, and a literal plus is `%2B`. Everywhere else a `+` must survive exactly
 * as written — `#src=a+b` is an addition — which is the whole reason this file parses by hand.
 *
 * The swap happens *before* the percent-decoding, so the two do not eat each other: `%2B` is still
 * `%2B` when the `+`s become spaces, and comes back a plus.
 */
const PROSE_KEYS = new Set(['systemprompt', 'agents'])

/**
 * Parsed by hand rather than with `URLSearchParams`, which decodes `+` as a space — that would
 * quietly corrupt a hand-written `#src=a+b`.
 *
 * Keys are lower-cased: these get typed by hand, and `hideHeader` should not fail over its capital
 * H. Values are left exactly as written, bar the one prose key above.
 */
export function parseFragment(hash: string): Map<string, string> {
  const params = new Map<string, string>()
  for (const part of hash.replace(/^[#?]/, '').split('&')) {
    if (!part) continue
    const equals = part.indexOf('=')
    const rawKey = equals < 0 ? part : part.slice(0, equals)
    const rawValue = equals < 0 ? '' : part.slice(equals + 1)
    try {
      const key = decodeURIComponent(rawKey).toLowerCase()
      const value = PROSE_KEYS.has(key) ? rawValue.replace(/\+/g, '%20') : rawValue
      params.set(key, decodeURIComponent(value))
    } catch {
      // A malformed %-escape is more useful kept raw than dropped.
      params.set(rawKey.toLowerCase(), rawValue)
    }
  }
  return params
}

/** `z.` marks a deflated payload, `r.` an uncompressed one where the browser lacks the streams. */
export async function encodeShare(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  if (typeof CompressionStream === 'undefined') return `r.${toBase64Url(bytes)}`
  return `z.${toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')))}`
}

/**
 * Anything without a recognised prefix is taken literally, so a link can be written by hand:
 * `#src=const%20x%20%3D%201`. A prefixed payload that fails to decode is treated the same way —
 * it is far likelier to be source that happens to start with `z.` than a link we produced.
 *
 * Returns null only when a payload is recognisably ours but undecodable, where showing the raw
 * base64 as source would be worse than falling back to what was already stored.
 */
export async function decodeShare(payload: string): Promise<string | null> {
  if (payload.startsWith('z.')) {
    if (typeof DecompressionStream === 'undefined') return null
    try {
      return new TextDecoder().decode(
        await pipe(fromBase64Url(payload.slice(2)), new DecompressionStream('deflate-raw')),
      )
    } catch {
      // Not ours after all — fall through and treat it as source.
    }
  } else if (payload.startsWith('r.')) {
    try {
      return new TextDecoder().decode(fromBase64Url(payload.slice(2)))
    } catch {
      // Likewise.
    }
  }
  return payload
}

/**
 * A file inside a shared bundle. A null name means the payload had no header at all — a link
 * written by hand as plain source — and the reader names it.
 */
export interface SharedFile {
  name: string | null
  text: string
}

/** Starts a file inside a bundle. Chosen to be a cut mark rather than anything JavaScript could
 *  be mistaken for, and to stay readable when a link is written or read by hand. */
const MARKER = '--8<--'

const MARKER_LINE = /^--8<--\s+(.*)$/

/** One named chunk of a bundle. Files use it; so do the agents' prompts, which are the same
 *  problem — several named texts that have to survive one link intact. */
export interface Section {
  name: string
  text: string
}

/**
 * Several texts as one payload: a header line per section, then its body, verbatim.
 *
 *     --8<-- server.ts
 *     import db from './db'
 *     --8<-- db.ts
 *     export default …
 *
 * One text, so **Copy link** deflates the whole set together — far better than a payload per file,
 * since the second file compresses against the first. The newline before a header belongs to the
 * header, which is what makes the round trip exact for a body that ends without one.
 */
export function serializeSections(sections: readonly Section[]): string {
  return sections.map((section) => `${MARKER} ${section.name}\n${section.text}`).join('\n')
}

/** The inverse. A payload with no header at all has no sections — what the caller makes of that
 *  differs: a file bundle reads it as plain source, an agent bundle as malformed. */
export function parseSections(payload: string): Section[] {
  const sections: Section[] = []
  let name: string | null = null
  let body: string[] = []

  const flush = (): void => {
    if (name !== null) sections.push({ name, text: body.join('\n') })
    body = []
  }

  for (const line of payload.split('\n')) {
    const header = MARKER_LINE.exec(line)
    if (header) {
      flush()
      name = header[1]!.trim()
      continue
    }
    body.push(line)
  }
  flush()

  return sections
}

export function serializeFiles(files: readonly { name: string; text: string }[]): string {
  return serializeSections(files)
}

/**
 * The file reading of a bundle. A payload with no header at all is one unnamed file, so `files=`
 * degrades to exactly what `src=` means and a hand-written link can leave the ceremony out.
 */
export function parseFiles(payload: string): SharedFile[] {
  const files = parseSections(payload)
  if (files.length === 0) return payload.length > 0 ? [{ name: null, text: payload }] : []
  return files
}

/** Query string and fragment together, the fragment winning where both name the same key. */
export function parseParams(search: string, hash: string): Map<string, string> {
  const params = parseFragment(search)
  for (const [key, value] of parseFragment(hash)) params.set(key, value)
  return params
}

const FALSY = new Set(['false', '0', 'no', 'off'])

/**
 * A flag is on when present, so `#hideHeader` needs no value — but an explicit `=false` or `=0`
 * turns it off, which is what someone templating a URL will expect.
 */
export function isFlagSet(params: Map<string, string>, key: string): boolean {
  const value = params.get(key.toLowerCase())
  return value !== undefined && !FALSY.has(value.trim().toLowerCase())
}

/**
 * Build a share fragment. Values are percent-encoded to match `parseFragment` — notably not with
 * `URLSearchParams`, which would write a space as `+` that the parser then hands back literally.
 * Empty entries are dropped so a link never carries `filename=`.
 */
export function buildFragment(entries: Record<string, string | null | undefined>): string {
  const parts = Object.entries(entries)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
  return parts.length ? `#${parts.join('&')}` : ''
}
