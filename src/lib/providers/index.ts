/**
 * Which providers this browser can actually use, and which models each one offers.
 *
 * A model the browser cannot run is never shown: the picker lists what will work here, and the
 * pane falls back to its plain "no language model" message only when nothing does. Two providers
 * are exceptions to "cannot run" meaning "hidden", both for the same reason — what they can be
 * missing is a setting rather than a browser capability, so their entries stay listed while it is
 * unset, `Availability`'s `'needs-key'` says so on the status line, and `useModel`'s
 * `engine()`/`engineFor()` refuse to load one until it exists rather than trying and failing:
 *
 * - `openrouter` needs neither a GPU nor Chrome's own model, only a key;
 * - `localserver` needs neither either, only an address — though it differs in that its entries
 *   *come* from that setting, so there is nothing listed to gate until one is set.
 */

import { MODELS, type ModelChoice, type Provider, type ProviderId } from '../chat'
import { builtin, hasBuiltin } from './builtin'
import { localServer } from './localServer'
import { localServerChoices } from './localServerModels'
import { openrouter } from './openrouter'
import { getCustomOpenRouterModels, toModelChoice } from './openrouterModels'
import { transformers } from './transformers'
import { hasWebGpu } from './webgpu'
import { webllm } from './webllm'

const PROVIDERS: Record<ProviderId, Provider> = {
  builtin,
  webllm,
  transformers,
  openrouter,
  localserver: localServer,
}

export function providerFor(id: ProviderId): Provider {
  return PROVIDERS[id]
}

/** The shipped catalogue plus whatever the reader has added themselves in the settings panel —
 *  turned into the same shape, so nothing past this point needs to know which is which. The local
 *  server's whole catalogue is reader-supplied (what it reported, plus what they added by hand),
 *  and is empty until an address is set — which is the entirety of that provider's opt-in gate. */
export function allModels(): ModelChoice[] {
  return [...MODELS, ...getCustomOpenRouterModels().map(toModelChoice), ...localServerChoices()]
}

/** The models worth offering here: the built-in one where it exists, OpenRouter's and a local
 *  server's always (a setting, not a browser capability, is what either can be missing), the rest
 *  where WebGPU does. */
export function usableModels(): ModelChoice[] {
  const gpu = hasWebGpu()
  const built = hasBuiltin()
  return allModels().filter((choice) => {
    if (choice.provider === 'builtin') return built
    if (choice.provider === 'openrouter' || choice.provider === 'localserver') return true
    return gpu
  })
}

/** `modelById` over the reader's own additions too — the one lookup `useModel`, `useAgents` and
 *  the agents pane should use instead of `chat.ts`'s, which only knows the shipped catalogue. */
export function findModel(id: string): ModelChoice | null {
  return allModels().find((choice) => choice.id === id) ?? null
}
