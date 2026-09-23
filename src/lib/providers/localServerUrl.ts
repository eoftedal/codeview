/**
 * Where the reader's own model server listens. This is the local provider's equivalent of
 * `openrouterKey.ts`'s key, and it gates the provider the same way: absent means the entry offers
 * nothing and **nothing is ever requested**, which is what keeps the deployed site behaving
 * exactly as it did before this provider existed.
 *
 * That gating is deliberately configuration rather than build mode. A page on GitHub Pages *can*
 * reach `http://localhost` — loopback is carved out of mixed-content blocking, since the Secure
 * Contexts spec counts `127.0.0.1`, `[::1]` and the `localhost` name as potentially trustworthy —
 * so the obstacles are ones the reader can clear rather than ones the browser imposes: the server
 * has to allow this origin (Ollama's default origins are loopback-only, so
 * `OLLAMA_ORIGINS=https://…` is needed; LM Studio has a toggle), and Chrome gates a public page's
 * request to a loopback address behind a local-network permission prompt. Both are reasons never
 * to probe `localhost` unasked — which is why a URL typed by the reader is what starts any of it —
 * and neither is a reason the feature cannot exist off the dev server.
 *
 * Unlike the OpenRouter key this is not a secret, but it is just as much a fact about one machine,
 * so it stays out of a share link for the same reason: a URL naming another machine's `localhost`
 * means nothing wherever the link is opened.
 */

import { ref, watch, type Ref } from 'vue'

const KEY = 'codeview:local-server-url'

/** Ollama's default port, and the shape the rest of them want. Offered as the settings field's
 *  placeholder rather than stored on the reader's behalf: seeding it in dev would make the e2e
 *  suite's pinned picker listings depend on whether the machine running them happens to have a
 *  server up, which is the kind of test that passes in CI and fails on a laptop. */
export const EXAMPLE_LOCAL_URL = 'http://localhost:11434/v1'

/**
 * What the reader typed, made into something `fetch` can use. They will write
 * `localhost:11434`, `http://localhost:11434`, one with a trailing slash, or the `/v1` already on
 * the end — and occasionally the whole endpoint, pasted from a curl example.
 *
 * Returns `''` for anything unusable, which reads as "not configured" everywhere else rather than
 * as an error to report: a half-typed URL in a settings field is not a failure yet.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // No scheme is the common spelling of a local address, and it is always plain HTTP.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return ''
  }
  if (!url.hostname) return ''
  let path = url.pathname.replace(/\/+$/, '')
  // Pasted from a curl example rather than read off the server's own banner.
  path = path.replace(/\/chat\/completions$/, '')
  // `/v1` is the OpenAI-compatible route on all of these, and Ollama's own base carries no path at
  // all — so add it where there is no version segment, and leave an unusual one alone.
  if (!/\/v\d+\w*$/.test(path)) path = `${path}/v1`
  return `${url.origin}${path}`
}

/** Stored canonical, so what comes back out is what was actually requested — a reader who typed a
 *  bare host sees the scheme and the `/v1` that were added for them. Empty clears the key: absent
 *  means "no server", which is the natural default with nothing to fall back to. */
export function getLocalServerUrl(): string | null {
  return localStorage.getItem(KEY)
}

export function setLocalServerUrl(next: string): void {
  const normalized = normalizeBaseUrl(next)
  if (normalized) localStorage.setItem(KEY, normalized)
  else localStorage.removeItem(KEY)
}

export interface LocalServerUrlHost {
  url: Ref<string>
}

/** One reactive view of the URL, for the settings panel and for `usableModels()`'s gating to share
 *  without either reaching into `localStorage` directly. The ref settles on the canonical spelling
 *  after a write, so the field shows the reader what was understood. */
export function useLocalServerUrl(): LocalServerUrlHost {
  const url = ref(getLocalServerUrl() ?? '')
  watch(url, (next) => {
    setLocalServerUrl(next)
    const stored = getLocalServerUrl() ?? ''
    // Re-enters this watcher exactly once, then settles: `stored` is already canonical.
    if (stored !== next) url.value = stored
  })
  return { url }
}
