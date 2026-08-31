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
 * Parsed by hand rather than with `URLSearchParams`, which decodes `+` as a space — that would
 * quietly corrupt a hand-written `#src=a+b`.
 */
export function parseFragment(hash: string): Map<string, string> {
  const params = new Map<string, string>()
  for (const part of hash.replace(/^#/, '').split('&')) {
    if (!part) continue
    const equals = part.indexOf('=')
    const key = equals < 0 ? part : part.slice(0, equals)
    const value = equals < 0 ? '' : part.slice(equals + 1)
    try {
      params.set(decodeURIComponent(key), decodeURIComponent(value))
    } catch {
      // A malformed %-escape is more useful kept raw than dropped.
      params.set(key, value)
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
