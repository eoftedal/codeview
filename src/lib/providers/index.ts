/**
 * Which providers this browser can actually use, and which models each one offers.
 *
 * A model the browser cannot run is never shown: the picker lists what will work here, and the
 * pane falls back to its plain "no language model" message only when nothing does.
 */

import { MODELS, type ModelChoice, type Provider, type ProviderId } from '../chat'
import { builtin, hasBuiltin } from './builtin'
import { transformers } from './transformers'
import { hasWebGpu } from './webgpu'
import { webllm } from './webllm'

const PROVIDERS: Record<ProviderId, Provider> = { builtin, webllm, transformers }

export function providerFor(id: ProviderId): Provider {
  return PROVIDERS[id]
}

/** The models worth offering here: the built-in one where it exists, the rest where WebGPU does. */
export function usableModels(): ModelChoice[] {
  const gpu = hasWebGpu()
  const built = hasBuiltin()
  return MODELS.filter((choice) => (choice.provider === 'builtin' ? built : gpu))
}
