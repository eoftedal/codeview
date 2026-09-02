/**
 * WebLLM's own worker handler. Inference runs here rather than on the main thread, which already
 * carries Monaco and the whole TypeScript compiler — a decode loop there would freeze the editor.
 */

import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (event: MessageEvent) => handler.onmessage(event)
