/**
 * The one secret this app persists. Every other value kept in `localStorage` here — the chat role,
 * the agent team, the picked model id, the thinking toggle — is a preference: readable by anyone
 * with access to this browser profile, but worth nothing to them. An OpenRouter key is not: it
 * spends its owner's prepaid credits, and it is stored exactly the same way, unencrypted, in the
 * same `localStorage` any script on this origin can read. That is consistent with the trust model
 * everywhere else in this app, but it is the first time that model actually costs something if it
 * is ever broken — worth stating plainly rather than leaving implicit.
 *
 * `providers/index.ts` reads presence/absence from this module directly, without importing
 * `openrouter.ts` itself, the same way it reads `hasWebGpu()` from its own module rather than from
 * `webllm.ts`.
 */

import { ref, watch, type Ref } from 'vue'

const KEY = 'codeview:openrouter-key'

/** Store only while a key is actually set: absent means "no key," which is the natural default —
 *  there is nothing to fall back to the way `DEFAULT_ROLE` falls back for the system prompt. */
export function getOpenRouterKey(): string | null {
  return localStorage.getItem(KEY)
}

export function setOpenRouterKey(next: string): void {
  const trimmed = next.trim()
  if (trimmed) localStorage.setItem(KEY, trimmed)
  else localStorage.removeItem(KEY)
}

export interface OpenRouterKeyHost {
  key: Ref<string>
}

/** One reactive view of the key, for the settings panel and for `usableModels()`'s gating to share
 *  without either reaching into `localStorage` directly. */
export function useOpenRouterKey(): OpenRouterKeyHost {
  const key = ref(getOpenRouterKey() ?? '')
  watch(key, (next) => setOpenRouterKey(next))
  return { key }
}
