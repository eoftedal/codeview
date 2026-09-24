import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAiEngine, type OpenAiConfig } from '../src/lib/providers/openaiCompatible'
import { streamAnswer } from '../src/lib/stream'

/** A chat-completions SSE body: one `data:` event per entry, closed by `[DONE]` unless the server
 *  never got that far. */
function sse(events: string[], done = true): Response {
  const body = [...events, ...(done ? ['[DONE]'] : [])].map((event) => `data: ${event}\n\n`)
  return new Response(body.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function chunk(content: string, finish: string | null = null, extra: object = {}): string {
  return JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }], ...extra })
}

const config: OpenAiConfig = {
  endpoint: 'http://test.invalid/v1/chat/completions',
  headers: {},
  maxTokens: 100,
  repetitionPenalty: false,
  reasoningFields: () => ({}),
  errorMessage: async (response) => `status ${response.status}`,
  networkMessage: () => 'no server',
  streamError: (error) => `Test: ${error?.message ?? 'stopped without a word'}`,
}

async function ask(response: Response): Promise<{ seen: string[]; answer: Promise<string> }> {
  vi.stubGlobal('fetch', async () => response)
  const session = await openAiEngine(config, { model: 'm' }).chat('brief', 'code')
  const seen: string[] = []
  const answer = streamAnswer(session, 'q', {}, (text) => seen.push(text)).then(
    ({ text, truncated }) => (truncated ? `${text} [truncated]` : text),
  )
  return { seen, answer }
}

describe('an error reported inside the stream', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fails the answer with the server’s own words, after what streamed before it', async () => {
    // OpenRouter's documented shape for a provider dying after the response is committed: the
    // status was 200, so the only place left to say so is a chunk in the stream itself.
    const { seen, answer } = await ask(
      sse(
        [
          chunk('Hel'),
          chunk('lo'),
          chunk('', 'error', {
            error: { code: 'server_error', message: 'Provider disconnected unexpectedly' },
          }),
        ],
        false,
      ),
    )
    await expect(answer).rejects.toThrow('Test: Provider disconnected unexpectedly')
    // The pane saw the partial answer arrive before the failure; what it does with it is its own
    // business, but it was not swallowed here.
    expect(seen.at(-1)).toBe('Hello')
  })

  it('treats a finish reason of error as one even with nothing else said', async () => {
    const { answer } = await ask(sse([chunk('Hi'), chunk('', 'error')]))
    await expect(answer).rejects.toThrow('Test: stopped without a word')
  })

  it('still reads an ordinary stream to its end, and a cut-off one as cut off', async () => {
    expect(await (await ask(sse([chunk('Hel'), chunk('lo', 'stop')]))).answer).toBe('Hello')
    expect(await (await ask(sse([chunk('Hel'), chunk('lo', 'length')]))).answer).toBe(
      'Hello [truncated]',
    )
  })
})
