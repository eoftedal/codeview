import { describe, expect, it } from 'vitest'
import { MODELS, buildSystemPrompt, modelById, numberLines } from '../src/lib/chat'

const context = {
  code: 'const a = 1\nconst b = 2\n',
  language: 'ts' as const,
  fileName: 'test.ts',
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
    expect(prompt).toContain('A SOURCE is')
    expect(prompt).toContain('A SINK is')
    expect(prompt).toContain('1 | const a = 1')
    expect(prompt).toContain('`test.ts`')
  })

  it('names the file after the language when there is no filename', () => {
    expect(buildSystemPrompt({ ...context, fileName: null })).toContain('`main.ts`')
  })

  it('clips to the asked-for budget and says so', () => {
    const code = 'x'.repeat(500)
    const prompt = buildSystemPrompt({ ...context, code, maxCodeChars: 100 })
    expect(prompt).toContain('truncated after the first 100 characters')
    expect(prompt).toContain(`1 | ${'x'.repeat(100)}\n`)
    expect(prompt).not.toContain('x'.repeat(101))
  })

  it('says nothing about truncation when the whole file fits', () => {
    expect(buildSystemPrompt(context)).not.toContain('truncated')
  })

  it('honours each model’s own budget', () => {
    const code = 'y'.repeat(13_000)
    const builtin = buildSystemPrompt({ ...context, code, maxCodeChars: MODELS[0]!.maxCodeChars })
    const bigger = buildSystemPrompt({ ...context, code, maxCodeChars: MODELS[1]!.maxCodeChars })
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
