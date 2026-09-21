/**
 * Which device each ONNX session runs on. Its own module for the same reason `ceiling.ts` is one —
 * the worker is its own bundle and should not pull the catalogue in — and because the rule below
 * is worth asserting rather than trusting.
 *
 * Transformers.js takes `device` as either a string for the whole model or a record dispatched per
 * session **file**. The record is the interesting one and it has a trap: a file the record does not
 * name falls back to the library's default device — `'wasm'` in a browser — with nothing but an
 * `info` log to say so. So a record must name *every* session the model will ask for, not only the
 * one being moved. `SPLIT_SESSIONS` is that complete list for a text-only Gemma 4 load, which is
 * the only shape this applies to: a single-session model asks for `model` instead, which is why
 * `ModelChoice.cpuEmbeddings` is a catalogue field on those entries rather than a switch anyone
 * can throw.
 */

/** What a session may run on. The two this app has any use for. */
export type SessionDevice = 'webgpu' | 'wasm'

/**
 * The split: the embedding table on the CPU, the decoder on the GPU. Both sessions of a Gemma 4
 * text-only load are named, which is the point — an unnamed one would silently land on `wasm` and
 * take the decoder off the GPU along with it, which is the opposite of the trade.
 */
export const SPLIT_SESSIONS: Record<string, SessionDevice> = {
  embed_tokens: 'wasm',
  decoder_model_merged: 'webgpu',
}

/** Everything on the GPU, or the split. The default is the string, which needs no list at all. */
export function sessionDevices(
  cpuEmbeddings: boolean,
): SessionDevice | Record<string, SessionDevice> {
  return cpuEmbeddings ? SPLIT_SESSIONS : 'webgpu'
}
