/**
 * Which models the reader's own server offers. Unlike every other provider here there is no fixed
 * catalogue worth shipping — what exists depends entirely on what the reader pulled — so this
 * module *is* the local provider's whole catalogue, and `MODELS` in `chat.ts` gains nothing.
 *
 * **Discovery has to be cached, because `allModels()` is synchronous and `GET /models` is not.**
 * That is the one structural fact this file exists to absorb. Two lists feed the picker:
 *
 * - what the server said when it was last asked (`SEEN_KEY`), refreshed by
 *   `refreshLocalServerModels()` — persisted rather than held in memory so a reload restores the
 *   picker at once and a remembered model id still resolves before the probe returns, which is
 *   otherwise how `useModel` quietly bumps the reader onto a different model on every reload;
 * - what the reader added by hand (`KEY`), for a server with no `/models` route, or to say
 *   something about a discovered model that the route cannot — that it thinks, or that its context
 *   is smaller than the default budget assumes.
 *
 * The hand-added entry wins where both name the same model, which is what makes it an override
 * rather than a duplicate.
 */

import { type ModelChoice } from '../chat'
import { getLocalServerUrl } from './localServerUrl'
import { ref, watch, type Ref } from 'vue'

const KEY = 'codeview:local-server-models'
const SEEN_KEY = 'codeview:local-server-seen'

/** Namespaced so a local entry's id can never collide with a catalogue one, or with an OpenRouter
 *  slug the reader happens to have added under the same name. */
const PREFIX = 'local:'

/**
 * How much numbered code a local model is given. Lower than the hosted budget on purpose, and the
 * one figure here that is not read off a context window: `/models` reports no context length on any
 * of these servers, so there is nothing to size it from.
 *
 * `14_000` is the figure the catalogue already uses for its knowingly over-committed 8k entries.
 * The trap it is aimed at is **Ollama's `num_ctx`, which defaults to 4096 whatever the model
 * supports** — so a reader whose answers come back truncated needs to raise it on the server, not
 * here. A hand-added entry can lower it for a model that really is that small.
 */
const DEFAULT_LOCAL_CODE_CHARS = 14_000

export interface LocalServerModel {
  /** The server's own model name — `qwen2.5-coder:7b`, `Qwen2.5-Coder-7B-Instruct-GGUF` — which is
   *  also what makes this entry's id. */
  model: string
  /** What the picker shows. Falls back to the model name itself when left blank. */
  label: string
  /** A reasoning model: offers the thinking checkbox and asks the server for a thought. Not
   *  discoverable from `/models`, so it is only ever set by hand. */
  thinking: boolean
  /** Overrides `DEFAULT_LOCAL_CODE_CHARS` for a model whose context is smaller than that assumes. */
  maxCodeChars?: number
}

function parse(raw: string | null): LocalServerModel[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const entries: LocalServerModel[] = []
    for (const item of parsed) {
      const model = typeof item?.model === 'string' ? item.model.trim() : ''
      if (!model || seen.has(model)) continue
      seen.add(model)
      const label = typeof item?.label === 'string' ? item.label.trim() : ''
      const budget = typeof item?.maxCodeChars === 'number' ? item.maxCodeChars : undefined
      entries.push({
        model,
        label: label || model,
        thinking: item?.thinking === true,
        ...(budget && budget > 0 ? { maxCodeChars: Math.floor(budget) } : {}),
      })
    }
    return entries
  } catch {
    // Hand-edited or corrupted storage reads as "none added" rather than breaking the picker.
    return []
  }
}

export function getLocalServerModels(): LocalServerModel[] {
  return parse(localStorage.getItem(KEY))
}

/** Store only while there is at least one: an empty list is the natural default, the same rule
 *  the URL itself follows. */
export function setLocalServerModels(models: readonly LocalServerModel[]): void {
  if (models.length === 0) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, JSON.stringify(models))
}

/** What the server last said it had. Same storage shape as the hand-added list, so one `parse`
 *  serves both and a corrupted cache degrades the same way. */
function getSeenModels(): LocalServerModel[] {
  return parse(localStorage.getItem(SEEN_KEY))
}

/**
 * Ask the server what it has, and remember the answer. The one async entry point here, called from
 * the provider's `availability()` and whenever the reader changes the URL.
 *
 * Returns whether the server answered, which is what `availability()` reports — a refusal is not
 * worth throwing over, since "no server there" is an ordinary state for this provider rather than
 * a failure. A server that answers but lists nothing is still a server that answered.
 */
export async function refreshLocalServerModels(signal?: AbortSignal): Promise<boolean> {
  const base = getLocalServerUrl()
  if (!base) {
    localStorage.removeItem(SEEN_KEY)
    return false
  }
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Accept: 'application/json' },
      signal,
    })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: { id?: unknown }[] }
    const discovered: LocalServerModel[] = []
    const seen = new Set<string>()
    for (const item of Array.isArray(body.data) ? body.data : []) {
      const model = typeof item?.id === 'string' ? item.id.trim() : ''
      if (!model || seen.has(model)) continue
      seen.add(model)
      discovered.push({ model, label: model, thinking: false })
    }
    setSeenModels(discovered)
    return true
  } catch {
    // Nothing listening, a port with something else on it, or an origin the server will not allow.
    // The cache is left alone: a server that was up a minute ago is likely up again shortly, and
    // emptying the picker on one failed probe would drop the reader's remembered model with it.
    return false
  }
}

function setSeenModels(models: readonly LocalServerModel[]): void {
  if (models.length === 0) localStorage.removeItem(SEEN_KEY)
  else localStorage.setItem(SEEN_KEY, JSON.stringify(models))
}

/**
 * Everything the picker should offer for the local server: what it reported, plus what the reader
 * added, with the reader's own entry winning on a shared name so it reads as an override. Empty
 * whenever no URL is set, which is the whole of the opt-in gate — `usableModels()` needs no arm of
 * its own for it.
 */
export function localServerChoices(): ModelChoice[] {
  if (!getLocalServerUrl()) return []
  const byName = new Map<string, LocalServerModel>()
  for (const entry of getSeenModels()) byName.set(entry.model, entry)
  for (const entry of getLocalServerModels()) byName.set(entry.model, entry)
  return [...byName.values()].map(toModelChoice)
}

export function toModelChoice(entry: LocalServerModel): ModelChoice {
  return {
    id: `${PREFIX}${entry.model}`,
    provider: 'localserver',
    label: entry.label,
    // Nothing comes down to the browser: the weights are already on the machine serving them.
    size: 'no download',
    maxCodeChars: entry.maxCodeChars ?? DEFAULT_LOCAL_CODE_CHARS,
    model: entry.model,
    thinking: entry.thinking || undefined,
    note: 'Served by your own model server — the code stays on this machine.',
  }
}

export interface LocalServerModelsHost {
  models: Ref<LocalServerModel[]>
}

export function useLocalServerModels(): LocalServerModelsHost {
  const models = ref<LocalServerModel[]>(getLocalServerModels())
  watch(models, (next) => setLocalServerModels(next), { deep: true })
  return { models }
}
