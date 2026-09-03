import { describe, expect, it } from 'vitest'
import {
  createId,
  languageForFile,
  neighbourId,
  sampleName,
  untitledName,
  withLanguage,
  type CodeFile,
} from '../src/lib/files'

const file = (id: string, name = `${id}.ts`): CodeFile => ({
  id,
  name,
  text: '',
  language: 'ts',
})

describe('languageForFile', () => {
  it('reads the language off the extension, whatever its case', () => {
    expect(languageForFile('App.tsx')).toBe('tsx')
    expect(languageForFile('src/util.MTS')).toBe('ts')
    expect(languageForFile('worker.cjs')).toBe('js')
  })

  it('knows nothing about extensions it does not own', () => {
    expect(languageForFile('README.md')).toBeNull()
    expect(languageForFile('Makefile')).toBeNull()
    // A leading dot is a dotfile, not an extension.
    expect(languageForFile('.eslintrc')).toBeNull()
  })
})

describe('withLanguage', () => {
  it('rewrites an extension we recognise', () => {
    expect(withLanguage('src/App.ts', 'tsx')).toBe('src/App.tsx')
    expect(withLanguage('worker.mjs', 'ts')).toBe('worker.ts')
  })

  it('leaves a name whose extension already means that language', () => {
    // `.mts` is TypeScript: rewriting it to `.ts` would be a rename nobody asked for.
    expect(withLanguage('util.mts', 'ts')).toBe('util.mts')
    expect(withLanguage('App.tsx', 'tsx')).toBe('App.tsx')
  })

  it('leaves anything it cannot read, rather than guessing', () => {
    expect(withLanguage('Makefile', 'ts')).toBe('Makefile')
    expect(withLanguage('.eslintrc', 'js')).toBe('.eslintrc')
    expect(withLanguage('notes.md', 'ts')).toBe('notes.md')
  })
})

describe('names for files we make up', () => {
  it('names the sample after its language', () => {
    expect(sampleName('ts')).toBe('example.ts')
    expect(sampleName('jsx')).toBe('example.jsx')
  })

  it('takes the first untitled number no tab has claimed', () => {
    expect(untitledName([], 'ts')).toBe('untitled-1.ts')
    expect(untitledName(['untitled-1.ts', 'untitled-2.ts'], 'ts')).toBe('untitled-3.ts')
    // A gap gets filled, and the comparison ignores case.
    expect(untitledName(['Untitled-1.TS', 'untitled-3.ts'], 'ts')).toBe('untitled-2.ts')
    expect(untitledName(['untitled-1.ts'], 'jsx')).toBe('untitled-1.jsx')
  })

  it('hands out ids nothing else holds', () => {
    expect(new Set([createId(), createId(), createId()]).size).toBe(3)
  })
})

describe('neighbourId', () => {
  const files = [file('a'), file('b'), file('c')]

  it('hands over to the tab on the right', () => {
    expect(neighbourId(files, 'a')).toBe('b')
    expect(neighbourId(files, 'b')).toBe('c')
  })

  it('falls back to the left when there is nothing to the right', () => {
    expect(neighbourId(files, 'c')).toBe('b')
  })

  it('has no answer for the last tab, or one it has never seen', () => {
    expect(neighbourId([file('a')], 'a')).toBeNull()
    expect(neighbourId(files, 'zz')).toBeNull()
  })
})
