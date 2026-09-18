/**
 * How many tokens a provider lets a model generate for one answer. Its own module because both
 * the WebLLM provider and the ONNX worker need it, and the worker is its own bundle — it should not
 * pull the catalogue and the prompts in for one number.
 *
 * A ceiling, not a target. A model that has finished emits its end of turn long before this, so
 * the figure only matters for one that never does — looping, or reasoning past all use — and it is
 * set where reaching it means exactly that. One number whether thinking or not: the thought is
 * spent from the same budget as the answer, so a ceiling roomy enough for either is roomy enough
 * for both. Reaching it is reported (`AskOptions.onTruncated`) rather than swallowed — an answer
 * cut off mid-sentence is otherwise indistinguishable from one that finished.
 *
 * It is not a thinking budget, and neither provider has one to offer: WebLLM lets no assistant
 * prefill through its API, so a thought cannot be closed early and the model asked to answer from
 * what it has. A reasoning model that thinks past the window is told so, and the thinking switch
 * is the reader's.
 */
export const MAX_NEW_TOKENS = 4096
