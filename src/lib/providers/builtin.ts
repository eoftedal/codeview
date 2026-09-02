/**
 * Chrome's built-in `LanguageModel` — the Prompt API. Nothing to download and nothing to bundle:
 * the browser owns the weights. Where the global is missing, this provider is simply unavailable.
 */

import type { Availability, ChatSession, LoadOptions, ModelEngine, Provider } from '../chat'

interface BuiltinCreateOptions {
  initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[]
  monitor?: (monitor: EventTarget) => void
}

interface BuiltinApi {
  availability(): Promise<Availability>
  create(options?: BuiltinCreateOptions): Promise<ChatSession>
}

/** The global, or null in a browser with no Prompt API. */
function api(): BuiltinApi | null {
  return (globalThis as { LanguageModel?: BuiltinApi }).LanguageModel ?? null
}

export function hasBuiltin(): boolean {
  return api() !== null
}

export const builtin: Provider = {
  async availability(): Promise<Availability> {
    const model = api()
    if (!model) return 'unavailable'
    try {
      return await model.availability()
    } catch {
      return 'unavailable'
    }
  },

  async load({ onProgress }: LoadOptions): Promise<ModelEngine> {
    const model = api()
    if (!model) throw new Error('This browser has no built-in language model.')

    return {
      // Chrome binds the system prompt when the session is made and owns the weights itself, so a
      // new conversation is simply a new session — there is nothing here to reload.
      async chat(system) {
        // A first run may have to fetch the model, which is large enough that silence looks
        // broken. The monitor is handed over every time, so only real progress reports a download.
        return model.create({
          initialPrompts: [{ role: 'system', content: system }],
          monitor: (monitor) => {
            monitor.addEventListener('downloadprogress', (event) => {
              onProgress?.((event as ProgressEvent).loaded)
            })
          },
        })
      },

      // The browser keeps its own model; there is nothing of ours to unload.
      destroy() {},
    }
  },
}
