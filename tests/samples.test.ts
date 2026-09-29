import { beforeAll, describe, expect, it } from 'vitest'
import { C_SAMPLE, CSHARP_SAMPLE, sampleFor } from '../src/lib/sample'
import { resolveCSharpDefinition } from '../src/lib/csharp/definitions'
import { traceCSharpOrigins } from '../src/lib/csharp/flow'
import { resolveCDefinition } from '../src/lib/c/definitions'
import { buildTreeSitterTree } from '../src/lib/treeSitterTree'
import { cParser } from './support/c'
import { csharpParser } from './support/csharp'

/**
 * A seed buffer is the first thing a reader sees, so it must parse cleanly and the rules its own
 * comments promise must actually hold. Both were wrong at least once while they were being written.
 */
describe('the C and C++ seed', () => {
  let file: { name: string; root: import('@vscode/tree-sitter-wasm').Node; text: string }

  beforeAll(async () => {
    const parser = await cParser()
    file = { name: 'example.c', root: parser.parse(C_SAMPLE)!.rootNode, text: C_SAMPLE }
  })

  it('parses with no error nodes', () => {
    const tree = buildTreeSitterTree(file.root)
    expect(tree.nodes.filter((node) => node.kind === 'ERROR')).toEqual([])
  })

  it('serves both C and C++, which share a grammar and a backend', () => {
    expect(sampleFor('c')).toBe(C_SAMPLE)
    expect(sampleFor('cpp')).toBe(C_SAMPLE)
  })

  it('resolves the macro its comment points at', () => {
    const at = C_SAMPLE.indexOf('MAX_NAME]') + 1
    expect(resolveCDefinition(file, [file], at)).toMatchObject({ reason: 'variable' })
  })

  it('resolves a struct field through a typedef receiver', () => {
    const at = C_SAMPLE.indexOf('record->length') + 'record->len'.length
    expect(resolveCDefinition(file, [file], at)).toMatchObject({ reason: 'property' })
  })

  it('shadows the outer declaration inside the block, as its comment claims', () => {
    const inner = C_SAMPLE.indexOf('Record record = {0};')
    const use = C_SAMPLE.indexOf('&record', inner) + 2
    const resolved = resolveCDefinition(file, [file], use)
    expect(resolved!.primary.start).toBeGreaterThan(inner - 1)
  })
})

describe('the C# seed', () => {
  let file: { name: string; root: import('@vscode/tree-sitter-wasm').Node; text: string }

  beforeAll(async () => {
    const parser = await csharpParser()
    file = { name: 'example.cs', root: parser.parse(CSHARP_SAMPLE)!.rootNode, text: CSHARP_SAMPLE }
  })

  it('parses with no error nodes', () => {
    const tree = buildTreeSitterTree(file.root)
    expect(tree.nodes.filter((node) => node.kind === 'ERROR')).toEqual([])
  })

  it('resolves the record component the sink reads', () => {
    const at = CSHARP_SAMPLE.indexOf('{id.Value}') + '{id.Val'.length
    expect(resolveCSharpDefinition(file, [file], at)).toMatchObject({ reason: 'property' })
  })

  it('resolves a primary constructor parameter inside the body', () => {
    const at = CSHARP_SAMPLE.indexOf('repository.Load(') + 3
    expect(resolveCSharpDefinition(file, [file], at)).toMatchObject({ reason: 'parameter' })
  })

  it('traces the sink back to the request parameter, as its comment promises', () => {
    const at = CSHARP_SAMPLE.indexOf('{id.Value}') + '{id.Val'.length
    const trace = traceCSharpOrigins(file, [file], at)
    const labels = trace!.nodes.map((node) => `${node.label}: ${node.excerpt}`)
    expect(labels.some((line) => line.startsWith('`.Value` read from'))).toBe(true)
    expect(labels.some((line) => line.includes('parameter `id`'))).toBe(true)
  })

  it('never reaches the construction in Map, which nothing passes to Load', () => {
    // The sample's own claim, and the regression the receiver rule exists for.
    const at = CSHARP_SAMPLE.indexOf('{id.Value}') + '{id.Val'.length
    const trace = traceCSharpOrigins(file, [file], at)
    expect(trace!.nodes.some((node) => node.excerpt.includes('row.GetString'))).toBe(false)
  })

  it('shows the constructor the value passes through', () => {
    // A record's extra constructor is where the value is validated or rejected, and a trace that
    // stepped over it would read as though the value arrived untouched.
    const at = CSHARP_SAMPLE.indexOf('{id.Value}') + '{id.Val'.length
    const trace = traceCSharpOrigins(file, [file], at)
    expect(trace!.nodes.some((node) => node.label.startsWith('constructed by'))).toBe(true)
  })
})
