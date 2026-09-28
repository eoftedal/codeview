import { describe, expect, it } from 'vitest'
import { MODELS } from '../src/lib/chat'
import {
  dialectFor,
  keepsSpecialTokens,
  parseCall,
  parseGemmaArguments,
  toolFilter,
  type ToolDialect,
} from '../src/lib/providers/onnxTools'

/** Feeding a whole answer through the filter, split wherever the caller says — a marker arriving
 *  in two pieces is the ordinary case, not the edge one. */
function run(dialect: ToolDialect, chunks: string[]) {
  const filter = toolFilter(dialect)
  let shown = ''
  for (const chunk of chunks) shown += filter.chunk(chunk)
  shown += filter.end()
  return { shown, calls: filter.calls() }
}

describe('which ONNX models can be given tools', () => {
  it('knows a dialect for exactly the flagged entries, and none for the rest', () => {
    // The catalogue flag and the parser have to agree: a flagged model with no dialect would be
    // handed an index and no way to open it, and an unflagged one with a dialect is a model we
    // could be offering and are not.
    for (const choice of MODELS.filter((entry) => entry.provider === 'transformers')) {
      expect(dialectFor(choice.model!) !== null).toBe(choice.supportsTools === true)
    }
  })

  it('has none for GLM-Edge, whose template has no tools in it', () => {
    expect(dialectFor('onnx-community/glm-edge-1.5b-chat-ONNX')).toBeNull()
  })

  it('keeps special tokens only for Gemma, whose markers are special tokens', () => {
    // Qwen's `<tool_call>` is an added token but not a special one, so it survives skipping.
    expect(keepsSpecialTokens('gemma')).toBe(true)
    expect(keepsSpecialTokens('qwen')).toBe(false)
  })
})

describe('reading a Qwen call', () => {
  // The shape Qwen2.5's own template prints into the system prompt it renders.
  const call =
    '<tool_call>\n{"name": "read_file", "arguments": {"file": "routes.ts"}}\n</tool_call>'

  it('takes the call out of the answer and hands it over parsed', () => {
    const { shown, calls } = run('qwen', [`Let me look.${call}`])
    expect(shown).toBe('Let me look.')
    expect(calls).toEqual([{ id: 'call_0', name: 'read_file', args: { file: 'routes.ts' } }])
  })

  it('reads a marker that arrived split across chunks', () => {
    // Nothing lines a token boundary up with a marker, and a missed one puts raw call syntax in
    // front of the reader.
    const chunks = [
      'Let me look.<tool',
      '_call>\n{"name": "list_files", "arg',
      'uments": {}}\n</tool',
      '_call>',
    ]
    const { shown, calls } = run('qwen', chunks)
    expect(shown).toBe('Let me look.')
    expect(calls).toEqual([{ id: 'call_0', name: 'list_files', args: {} }])
  })

  it('reads arguments a model wrote as a JSON string instead of an object', () => {
    const { calls } = run('qwen', [
      '<tool_call>{"name":"read_file","arguments":"{\\"file\\":\\"a.ts\\"}"}</tool_call>',
    ])
    expect(calls[0]!.args).toEqual({ file: 'a.ts' })
  })

  it('keeps two calls in the order they were asked', () => {
    const { calls } = run('qwen', [
      '<tool_call>{"name":"read_file","arguments":{"file":"a.ts"}}</tool_call>',
      '<tool_call>{"name":"read_file","arguments":{"file":"b.ts"}}</tool_call>',
    ])
    expect(calls.map((entry) => entry.args.file)).toEqual(['a.ts', 'b.ts'])
  })

  it('drops a call that never closed rather than showing its syntax', () => {
    // A stopped answer, or one that ran out of room mid-call. Half a call is not a call.
    const { shown, calls } = run('qwen', ['Reading.<tool_call>{"name":"read_'])
    expect(shown).toBe('Reading.')
    expect(calls).toEqual([])
  })

  it('leaves text that merely looked like the start of a marker alone', () => {
    const { shown } = run('qwen', ['a < b, and <tool'])
    expect(shown).toBe('a < b, and <tool')
  })
})

describe('reading a Gemma call', () => {
  // Gemma 4's tokenizer config names this shape itself, in a `response_schema`: the markers, the
  // `call:name{…}` regex, and a parser for the arguments that is not JSON.
  const call = '<|tool_call>call:read_file{end:40,file:<|"|>routes.ts<|"|>,start:1}<tool_call|>'

  it('parses the arguments out of the syntax the template taught it', () => {
    const { shown, calls } = run('gemma', [`Reading.${call} and on`])
    expect(shown).toBe('Reading. and on')
    expect(calls).toEqual([
      { id: 'call_0', name: 'read_file', args: { end: 40, file: 'routes.ts', start: 1 } },
    ])
  })

  it('reads a call with no arguments at all', () => {
    const { calls } = run('gemma', ['<|tool_call>call:list_files{}<tool_call|>'])
    expect(calls).toEqual([{ id: 'call_0', name: 'list_files', args: {} }])
  })

  it('reads a string holding the characters that end a value elsewhere', () => {
    // The escape markers are what ends a string, and only they — a comma or a brace inside one is
    // ordinary text, which is exactly what a file name or a query string can hold.
    expect(parseGemmaArguments('{file:<|"|>a,b}c.ts<|"|>}')).toEqual({ file: 'a,b}c.ts' })
  })

  it('reads booleans, nested objects and lists', () => {
    expect(parseGemmaArguments('{deep:{on:true,names:[<|"|>a<|"|>,<|"|>b<|"|>]},n:2}')).toEqual({
      deep: { on: true, names: ['a', 'b'] },
      n: 2,
    })
  })

  it('reads keys written in the escaped form the declarations use', () => {
    expect(parseGemmaArguments('{<|"|>file<|"|>:<|"|>a.ts<|"|>}')).toEqual({ file: 'a.ts' })
  })

  it('gives nothing for a body that is not a call', () => {
    expect(parseCall('gemma', 'nonsense', 0)).toBeNull()
    expect(parseCall('qwen', 'nonsense', 0)).toBeNull()
  })
})
