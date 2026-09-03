import { describe, expect, it } from 'vitest'
import { MODELS, buildSystemPrompt, modelById, numberLines } from '../src/lib/chat'

const file = (name: string, text: string) => ({ name, language: 'ts' as const, text })

const context = {
  files: [file('test.ts', 'const a = 1\nconst b = 2\n')],
  maxCodeChars: 12_000,
}

describe('the model catalogue', () => {
  it('offers the browser’s own model first, so it is the default', () => {
    expect(MODELS[0]!.id).toBe('builtin')
    expect(MODELS[0]!.provider).toBe('builtin')
  })

  it('resolves an id to its provider and model', () => {
    const choice = modelById('qwen-coder-1.5b')
    expect(choice).toMatchObject({
      provider: 'webllm',
      model: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    })
    expect(modelById('nothing-like-this')).toBeNull()
  })

  it('flags thinking only on the reasoning models, since suppressing it prefills a think block', () => {
    const thinking = MODELS.filter((choice) => choice.thinking).map((choice) => choice.id)
    expect(thinking).toEqual(['qwen3.5-2b', 'qwen3.5-4b', 'qwen3.5-9b'])
  })

  it('runs each ONNX model at the quantisation its own repo asks for', () => {
    // GLM-Edge's `transformers_js_config` names q4: its fp16 build is not sound on WebGPU.
    expect(modelById('glm-edge-1.5b')?.dtype).toBe('q4')
    // Everything else takes the q4f16 default, so it should not be pinned here.
    expect(modelById('qwen-coder-1.5b-onnx')?.dtype).toBeUndefined()
  })

  it('gives every downloadable model a provider model id and a size', () => {
    for (const choice of MODELS) {
      if (choice.provider === 'builtin') continue
      expect(choice.model, choice.id).toBeTruthy()
      expect(choice.size, choice.id).toMatch(/GB/)
    }
  })
})

describe('the system prompt', () => {
  it('carries the role, both definitions and the numbered buffer', () => {
    const prompt = buildSystemPrompt(context)
    expect(prompt).toContain('senior security engineer')
    expect(prompt).toContain('**source**')
    expect(prompt).toContain('**sink**')
    expect(prompt).toContain('1 | const a = 1')
    expect(prompt).toContain('`test.ts`')
  })

  it('carries every open file, each numbered from its own line 1', () => {
    const prompt = buildSystemPrompt({
      ...context,
      files: [file('routes.ts', 'const a = 1\n'), file('db.ts', 'const b = 2\n')],
    })
    expect(prompt).toContain('`routes.ts`')
    expect(prompt).toContain('`db.ts`')
    // Both start at 1: an answer has to say which file a line is in.
    expect(prompt).toContain('1 | const a = 1')
    expect(prompt).toContain('1 | const b = 2')
    expect(prompt).toContain('Every file open in the editor is below')
  })

  it('says nothing about other files when only one is open', () => {
    expect(buildSystemPrompt(context)).toContain('The file under review is below')
  })

  it('clips to the asked-for budget and says so', () => {
    const files = [file('big.ts', 'x'.repeat(500))]
    const prompt = buildSystemPrompt({ ...context, files, maxCodeChars: 100 })
    expect(prompt).toContain('truncated after the first 100 characters')
    expect(prompt).toContain(`1 | ${'x'.repeat(100)}\n`)
    expect(prompt).not.toContain('x'.repeat(101))
  })

  it('spends the budget in order, and names the files it could not fit', () => {
    const prompt = buildSystemPrompt({
      ...context,
      files: [file('shown.ts', 'x'.repeat(90)), file('left-out.ts', 'y'.repeat(90))],
      maxCodeChars: 100,
    })
    expect(prompt).toContain('x'.repeat(90))
    // Ten characters of the second file would teach the model nothing about it.
    expect(prompt).not.toContain('y'.repeat(10))
    expect(prompt).toContain('Also open, but not shown to you: `left-out.ts`.')
  })

  it('says nothing about truncation when the whole file fits', () => {
    expect(buildSystemPrompt(context)).not.toContain('truncated')
  })

  it('honours each model’s own budget', () => {
    const files = [file('big.ts', 'y'.repeat(13_000))]
    const builtin = buildSystemPrompt({ ...context, files, maxCodeChars: MODELS[0]!.maxCodeChars })
    const bigger = buildSystemPrompt({ ...context, files, maxCodeChars: MODELS[1]!.maxCodeChars })
    expect(builtin).toContain('truncated after the first 12000 characters')
    expect(bigger).not.toContain('truncated')
  })
})

describe('line numbering', () => {
  it('right-aligns the numbers so the code stays in one column', () => {
    const numbered = numberLines(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'))
    expect(numbered.split('\n')[0]).toBe(' 1 | line 0')
    expect(numbered.split('\n')[9]).toBe('10 | line 9')
  })
})
