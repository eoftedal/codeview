/**
 * Which providers this browser can actually use, and which models each one offers.
 *
 * A model the browser cannot run is never shown: the picker lists what will work here, and the
 * pane falls back to its plain "no language model" message only when nothing does. OpenRouter is
 * the one exception to "cannot run" meaning "hidden": it needs neither a GPU nor Chrome's own
 * model, only a key the reader can type into the settings panel, so its entries stay listed even
 * before one is set — `Availability`'s `'needs-key'` says so on the status line, and `useModel`'s
 * `engine()`/`engineFor()` refuse to load one until a key exists, rather than trying and failing.
 */

import { MODELS, type ModelChoice, type Provider, type ProviderId } from '../chat'
import { builtin, hasBuiltin } from './builtin'
import { openrouter } from './openrouter'
import { getCustomOpenRouterModels, toModelChoice } from './openrouterModels'
import { transformers } from './transformers'
import { hasWebGpu } from './webgpu'
import { webllm } from './webllm'

const PROVIDERS: Record<ProviderId, Provider> = { builtin, webllm, transformers, openrouter }

export function providerFor(id: ProviderId): Provider {
  return PROVIDERS[id]
}

/** The shipped catalogue plus whatever the reader has added themselves in the settings panel —
 *  turned into the same shape, so nothing past this point needs to know which is which. */
export function allModels(): ModelChoice[] {
  return [...MODELS, ...getCustomOpenRouterModels().map(toModelChoice)]
}

/** The models worth offering here: the built-in one where it exists, OpenRouter's always (a key,
 *  not a browser capability, is what it is missing), the rest where WebGPU does. */
export function usableModels(): ModelChoice[] {
  const gpu = hasWebGpu()
  const built = hasBuiltin()
  return allModels().filter((choice) => {
    if (choice.provider === 'builtin') return built
    if (choice.provider === 'openrouter') return true
    return gpu
  })
}

/** `modelById` over the reader's own additions too — the one lookup `useModel`, `useAgents` and
 *  the agents pane should use instead of `chat.ts`'s, which only knows the shipped catalogue. */
export function findModel(id: string): ModelChoice | null {
  return allModels().find((choice) => choice.id === id) ?? null
}
