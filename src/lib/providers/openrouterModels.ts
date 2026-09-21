/**
 * OpenRouter models the reader adds themselves, alongside the fixed three in `chat.ts`'s `MODELS`.
 * The shipped list is deliberately short — "every entry is a promise it works" — but OpenRouter's
 * own catalogue is much larger, and a reader who knows the slug they want should not have to wait
 * for it to be added here.
 *
 * Stored the same way the key is: unencrypted `localStorage`, this browser only, never touched by
 * a share link. Turned into ordinary `ModelChoice`s (`toModelChoice`) so nothing downstream —
 * `usableModels()`, the picker, an agent's own model — needs to know a given entry wasn't shipped.
 */

import { ref, watch, type Ref } from 'vue'
import type { ModelChoice } from '../chat'

const KEY = 'codeview:openrouter-models'

/** Namespaced so a custom entry's id can never collide with a catalogue one, however the reader
 *  spells the slug. */
const PREFIX = 'openrouter-custom:'

export interface CustomOpenRouterModel {
  /** OpenRouter's own model slug, e.g. `mistralai/mistral-large` — also what makes this entry's id. */
  model: string
  /** What the picker shows. Falls back to the slug itself when left blank. */
  label: string
  /** A reasoning model: offers the thinking checkbox and sends `reasoning.enabled`, the same as a
   *  shipped entry flagged this way. */
  thinking: boolean
}

function parse(raw: string | null): CustomOpenRouterModel[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const entries: CustomOpenRouterModel[] = []
    for (const item of parsed) {
      const model = typeof item?.model === 'string' ? item.model.trim() : ''
      if (!model || seen.has(model)) continue
      seen.add(model)
      const label = typeof item?.label === 'string' ? item.label.trim() : ''
      entries.push({ model, label: label || model, thinking: item?.thinking === true })
    }
    return entries
  } catch {
    // Hand-edited or corrupted storage reads as "none added" rather than breaking the picker.
    return []
  }
}

export function getCustomOpenRouterModels(): CustomOpenRouterModel[] {
  return parse(localStorage.getItem(KEY))
}

/** Store only while there is at least one: an empty list is the natural default, the same rule
 *  the key itself follows. */
export function setCustomOpenRouterModels(models: readonly CustomOpenRouterModel[]): void {
  if (models.length === 0) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, JSON.stringify(models))
}

export function toModelChoice(entry: CustomOpenRouterModel): ModelChoice {
  return {
    id: `${PREFIX}${entry.model}`,
    provider: 'openrouter',
    label: entry.label,
    size: 'no download',
    maxCodeChars: 60_000,
    model: entry.model,
    thinking: entry.thinking || undefined,
    note: 'Hosted by OpenRouter — code leaves this machine for this option only. Needs an API key.',
  }
}

export interface OpenRouterModelsHost {
  models: Ref<CustomOpenRouterModel[]>
}

/** One reactive view of the list, for the settings panel and for `usableModels()`'s catalogue to
 *  share without either reaching into `localStorage` directly — the same shape `useOpenRouterKey`
 *  takes for the key beside it. */
export function useOpenRouterModels(): OpenRouterModelsHost {
  const models = ref<CustomOpenRouterModel[]>(getCustomOpenRouterModels())
  watch(models, (next) => setCustomOpenRouterModels(next), { deep: true })
  return { models }
}
