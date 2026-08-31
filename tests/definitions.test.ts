import { describe, expect, it } from 'vitest'
import { createAnalyzer } from '../src/lib/analyzer'
import { resolveDefinition, type DefinitionResult } from '../src/lib/definitions'
import type { Language } from '../src/lib/analyzer'

/** Resolve at the offset marked by `|` in the fixture, returning the highlighted substrings. */
function defAt(source: string, language: Language = 'ts') {
  const offset = source.indexOf('|')
  expect(offset, 'fixture must contain a | cursor marker').toBeGreaterThan(-1)
  const text = source.replace('|', '')

  const analyzer = createAnalyzer()
  analyzer.update(text, language)
  const result = resolveDefinition(
    analyzer.service(),
    analyzer.sourceFile(),
    analyzer.fileName(),
    offset,
  )
  if (!result) return null
  return {
    ...result,
    primaryText: text.slice(result.primary.start, result.primary.end),
    secondaryText: result.secondary
      ? text.slice(result.secondary.start, result.secondary.end)
      : undefined,
  } as DefinitionResult & { primaryText: string; secondaryText?: string }
}

describe('variables', () => {
  it('resolves a variable use to its declaration', () => {
    const def = defAt(`const greeting = "hi"\nfunction f() { return gree|ting }`)
    expect(def?.reason).toBe('variable')
    expect(def?.primaryText).toBe('const greeting = "hi"')
    expect(def?.line).toBe(1)
  })

  it('keeps the keyword out when several declarators share one statement', () => {
    const def = defAt(`let a = 1, b = 2\nb|`)
    expect(def?.primaryText).toBe('b = 2')
  })

  it('resolves a destructured binding to the binding element', () => {
    const def = defAt(`const config = { port: 8080 }\nconst { port } = config\npor|t`)
    expect(def?.reason).toBe('binding')
    expect(def?.primaryText).toBe('port')
    expect(def?.secondaryText).toBe('const { port } = config')
  })
})

describe('parameters', () => {
  it('resolves a parameter, not the shadowed outer variable', () => {
    const def = defAt(`const greeting = "outer"\nfunction f(greeting) { return gree|ting }`)
    expect(def?.reason).toBe('parameter')
    expect(def?.primaryText).toBe('greeting')
    expect(def?.line).toBe(2)
  })

  it('resolves a destructured parameter to the binding element', () => {
    const def = defAt(`function f({ retries }) { return retrie|s }`)
    expect(def?.reason).toBe('parameter')
    expect(def?.primaryText).toBe('retries')
    expect(def?.secondaryText).toBe('{ retries }')
  })
})

describe('functions and classes', () => {
  it('highlights only the signature, not the body', () => {
    const def = defAt(`function greet(name: string) {\n  return name\n}\ngre|et("x")`)
    expect(def?.reason).toBe('function')
    expect(def?.primaryText).toBe('function greet(name: string)')
  })

  it('clips a multi-line signature to its first line', () => {
    const def = defAt(
      `function wide(\n  a: number,\n  b: number,\n) {\n  return a + b\n}\nwid|e(1, 2)`,
    )
    expect(def?.primaryText).toBe('function wide(')
  })

  it('treats an arrow function assigned to a const as a function', () => {
    const def = defAt(`const double = (x: number) => x * 2\ndoubl|e(2)`)
    expect(def?.reason).toBe('function')
    expect(def?.primaryText).toBe('const double = (x: number) =>')
  })

  it('resolves a class, not its constructor', () => {
    const def = defAt(`class Box {\n  constructor(readonly w: number) {}\n}\nnew Bo|x(2)`)
    expect(def?.reason).toBe('class')
    expect(def?.primaryText).toBe('class Box')
  })

  it('resolves a method to its own signature line', () => {
    const def = defAt(`class Box {\n  area(): number {\n    return 1\n  }\n}\nnew Box().are|a()`)
    expect(def?.primaryText).toBe('area(): number')
  })
})

describe('object properties', () => {
  it('highlights the property assignment and dims the object creation', () => {
    const def = defAt(`const cfg = { host: "localhost", port: 8080 }\ncfg.ho|st`)
    expect(def?.reason).toBe('property')
    expect(def?.primaryText).toBe('host: "localhost"')
    expect(def?.secondaryText).toBe('const cfg = { host: "localhost", port: 8080 }')
  })

  it('falls back to the parameter when the property itself cannot be resolved', () => {
    const def = defAt(`function connect(cfg) {\n  return cfg.ho|st\n}`, 'js')
    expect(def?.reason).toBe('parameter')
    expect(def?.primaryText).toBe('cfg')
  })

  it('resolves a shorthand property', () => {
    const def = defAt(`const port = 1\nconst cfg = { port }\ncfg.po|rt`)
    expect(def?.reason).toBe('property')
    expect(def?.primaryText).toBe('port')
  })
})

describe('imports', () => {
  it('resolves a named import to its import statement', () => {
    const def = defAt(`import { formatAddress } from './format'\nformatAddr|ess('x')`)
    expect(def?.reason).toBe('import')
    expect(def?.primaryText).toBe(`import { formatAddress } from './format'`)
  })

  it('resolves a default import to its import statement', () => {
    const def = defAt(`import defaults from './defaults'\ndefaul|ts.port`)
    expect(def?.reason).toBe('import')
    expect(def?.primaryText).toBe(`import defaults from './defaults'`)
  })

  it('resolves a property of an imported object to the import', () => {
    // The property is declared in a file this buffer can't see, so the import is the useful answer.
    const def = defAt(`import defaults from './defaults'\ndefaults.po|rt`)
    expect(def?.reason).toBe('import')
    expect(def?.primaryText).toBe(`import defaults from './defaults'`)
  })

  it('resolves a namespace import to its import statement', () => {
    const def = defAt(`import * as utils from './utils'\nutil|s.trim('x')`)
    expect(def?.reason).toBe('import')
    expect(def?.primaryText).toBe(`import * as utils from './utils'`)
  })
})

describe('no definition', () => {
  it('returns null on punctuation', () => {
    expect(defAt(`const a = 1 +| 2`)).toBeNull()
  })

  it('returns null for a global with no lib loaded', () => {
    expect(defAt(`conso|le.log(1)`)).toBeNull()
  })
})
