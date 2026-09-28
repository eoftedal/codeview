import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PromptFile } from '../src/lib/chat'
import { openAiEngine, type OpenAiConfig } from '../src/lib/providers/openaiCompatible'
import { withoutThoughts } from '../src/lib/providers/thoughts'
import { streamAnswer } from '../src/lib/stream'
import { MAX_TOOL_ROUNDS, fileTools } from '../src/lib/tools'

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

/** A frame asking for one tool call, in pieces the way a real stream sends them. */
function toolCall(name: string, args: string, index = 0): string[] {
  return [
    JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index, id: `c${index}`, function: { name, arguments: '' } }] },
          finish_reason: null,
        },
      ],
    }),
    // The arguments arrive a few characters at a time, which is what makes them worth assembling.
    ...[...args].map((piece) =>
      JSON.stringify({
        choices: [
          {
            delta: { tool_calls: [{ index, function: { arguments: piece } }] },
            finish_reason: null,
          },
        ],
      }),
    ),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ]
}

const file = (name: string, text: string): PromptFile => ({ name, language: 'ts', text })

/** Answers each request in turn, keeping every body that was posted. */
function server(rounds: (body: Record<string, unknown>) => string[]) {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    bodies.push(body)
    return sse(rounds(body))
  })
  return bodies
}

describe('a question answered through tools', () => {
  afterEach(() => vi.unstubAllGlobals())

  const files = [file('routes.ts', 'const id = req.params.id\nrun(id)')]

  async function askWithTools(rounds: (body: Record<string, unknown>) => string[]) {
    const bodies = server(rounds)
    const session = await openAiEngine(config, { model: 'm' }).chat(
      'brief',
      'index',
      fileTools(files, 10_000),
    )
    const answer = await streamAnswer(session, 'q', {}, () => {})
    return { bodies, answer: answer.text }
  }

  it('runs the call, feeds the result back, and answers from it', async () => {
    const { bodies, answer } = await askWithTools((body) =>
      (body.messages as { role: string }[]).some((message) => message.role === 'tool')
        ? [chunk('It reaches run().', 'stop')]
        : toolCall('read_file', '{"file":"routes.ts"}'),
    )

    expect(bodies).toHaveLength(2)
    // The tools are declared on every request, the file index is still the opening turn.
    expect((bodies[0]!.tools as unknown[]).length).toBe(2)

    const second = bodies[1]!.messages as {
      role: string
      content: string
      tool_calls?: { id: string; function: { name: string } }[]
      tool_call_id?: string
    }[]
    // The ask and its answer, in the pair this API requires: neither is any use without the other.
    const asked = second.find((message) => message.tool_calls)!
    expect(asked.tool_calls![0]!.function.name).toBe('read_file')
    const answered = second.find((message) => message.role === 'tool')!
    expect(answered.tool_call_id).toBe(asked.tool_calls![0]!.id)
    expect(answered.content).toContain('req.params.id')

    // What the reader sees: the answer, and a visible row naming what was read — what a model was
    // allowed to read is the first thing to check about an answer built by reading. It is kept out
    // of the history and out of an agent's relay all the same: it is what the model did, not what
    // it said.
    expect(answer).toContain('<tool>read_file routes.ts</tool>')
    expect(answer).not.toContain('<think>')
    expect(withoutThoughts(answer)).toBe('It reaches run().')
  })

  it('assembles two calls in one round and answers both before asking again', async () => {
    const { bodies } = await askWithTools((body) =>
      (body.messages as { role: string }[]).some((message) => message.role === 'tool')
        ? [chunk('Both read.', 'stop')]
        : [
            ...toolCall('read_file', '{"file":"routes.ts"}', 0).slice(0, -1),
            ...toolCall('list_files', '{}', 1),
          ],
    )
    const second = bodies[1]!.messages as { role: string; tool_call_id?: string }[]
    expect(second.filter((message) => message.role === 'tool').map((m) => m.tool_call_id)).toEqual([
      'c0',
      'c1',
    ])
  })

  it('stops asking for files at the round limit and makes the model answer', async () => {
    // A small model that has learnt to call a tool can keep calling it. The last round still
    // declares the tools — this API rejects a history of calls with nothing to declare them — and
    // takes the option away with `tool_choice`.
    const { bodies, answer } = await askWithTools((body) =>
      body.tool_choice === 'none'
        ? [chunk('Answering with what I read.', 'stop')]
        : toolCall('list_files', '{}'),
    )
    expect(bodies).toHaveLength(MAX_TOOL_ROUNDS + 1)
    expect(bodies.at(-1)!.tool_choice).toBe('none')
    expect(bodies.at(-1)!.tools).toBeDefined()
    expect(withoutThoughts(answer)).toBe('Answering with what I read.')
  })

  it('sends no tools at all for a session opened without them', async () => {
    const bodies = server(() => [chunk('Hello', 'stop')])
    const session = await openAiEngine(config, { model: 'm' }).chat('brief', 'code')
    await streamAnswer(session, 'q', {}, () => {})
    expect(bodies[0]!.tools).toBeUndefined()
    expect(bodies[0]!.tool_choice).toBeUndefined()
  })
})
