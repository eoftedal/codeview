import { describe, expect, it } from 'vitest'
import {
  arrangeForOpen,
  fitToStrip,
  createId,
  isIgnoredDir,
  isIgnoredPath,
  languageForFile,
  neighbourId,
  sampleName,
  uniqueName,
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
    expect(languageForFile('routes.py')).toBe('py')
    expect(languageForFile('stubs/db.PYI')).toBe('py')
    expect(languageForFile('com/example/Db.java')).toBe('java')
    expect(languageForFile('src/main.c')).toBe('c')
    // `.h` goes to C, as Monaco's own contribution does — the C++ grammar parses both anyway.
    expect(languageForFile('include/util.H')).toBe('c')
    expect(languageForFile('src/widget.cpp')).toBe('cpp')
    expect(languageForFile('src/widget.hpp')).toBe('cpp')
    expect(languageForFile('src/widget.CXX')).toBe('cpp')
    expect(languageForFile('Shop/Controller.cs')).toBe('cs')
    expect(languageForFile('build.csx')).toBe('cs')
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
    expect(withLanguage('src/App.ts', 'py')).toBe('src/App.py')
    expect(withLanguage('routes.py', 'ts')).toBe('routes.ts')
    expect(withLanguage('src/main.c', 'cpp')).toBe('src/main.cpp')
    expect(withLanguage('src/widget.cpp', 'cs')).toBe('src/widget.cs')
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

  it('steps a clashing name past the ones already open', () => {
    expect(uniqueName('db.ts', [])).toBe('db.ts')
    expect(uniqueName('db.ts', ['db.ts'])).toBe('db-2.ts')
    expect(uniqueName('db.ts', ['db.ts', 'db-2.ts'])).toBe('db-3.ts')
    expect(uniqueName('lib/db.ts', ['LIB/DB.TS'])).toBe('lib/db-2.ts')
    // Nothing to step around the extension when there is none.
    expect(uniqueName('Makefile', ['Makefile'])).toBe('Makefile-2')
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

describe('isIgnoredDir', () => {
  it('steps over what a checkout holds but a review never reads', () => {
    expect(isIgnoredDir('node_modules')).toBe(true)
    expect(isIgnoredDir('target')).toBe(true)
    expect(isIgnoredDir('__pycache__')).toBe(true)
  })

  it('steps over anything dotted, which is how .git is handled', () => {
    expect(isIgnoredDir('.git')).toBe(true)
    expect(isIgnoredDir('.venv')).toBe(true)
  })

  it('has nothing against an ordinary directory', () => {
    expect(isIgnoredDir('src')).toBe(false)
    expect(isIgnoredDir('lib')).toBe(false)
  })
})

describe('isIgnoredPath', () => {
  it('asks about the directories between the root and the file', () => {
    expect(isIgnoredPath('proj/node_modules/pkg/index.js')).toBe(true)
    expect(isIgnoredPath('proj/.git/hooks/pre-commit.js')).toBe(true)
    expect(isIgnoredPath('proj/src/lib/db.ts')).toBe(false)
  })

  /** The reader's own pick is never second-guessed: dragging `dist` is asking for `dist`. */
  it('exempts the picked folder itself', () => {
    expect(isIgnoredPath('dist/bundle.js')).toBe(false)
    expect(isIgnoredPath('node_modules/pkg/index.js')).toBe(false)
  })

  it('never examines the file’s own name', () => {
    expect(isIgnoredPath('proj/src/.eslintrc.js')).toBe(false)
    expect(isIgnoredPath('a.ts')).toBe(false)
  })
})

describe('arrangeForOpen', () => {
  const named = (...names: string[]) => names.map((name) => ({ name }))

  it('drops the picked folder’s own segment, which every path shares', () => {
    expect(arrangeForOpen(named('proj/a.ts', 'proj/src/b.ts'))).toEqual(named('a.ts', 'src/b.ts'))
  })

  it('drops each path’s own folder, so two folders at once both lose theirs', () => {
    expect(arrangeForOpen(named('a/src/one.ts', 'b/lib/two.ts'))).toEqual(
      named('src/one.ts', 'lib/two.ts'),
    )
    // A loose file beside a folder has no folder of its own to lose, and does not stop the folder
    // losing hers.
    expect(arrangeForOpen(named('b.ts', 'proj/src/a.ts'))).toEqual(named('b.ts', 'src/a.ts'))
    expect(arrangeForOpen(named('one.ts', 'two.ts'))).toEqual(named('one.ts', 'two.ts'))
  })

  it('keeps every root when dropping one would leave two files answering to one name', () => {
    // `openFiles` refreshes a tab whose name matches, so the roots are the only thing keeping these
    // two apart — a longer name beats one file silently overwriting the other.
    expect(arrangeForOpen(named('a/src/db.ts', 'b/src/db.ts'))).toEqual(
      named('a/src/db.ts', 'b/src/db.ts'),
    )
    // The collision a loose file causes counts the same way.
    expect(arrangeForOpen(named('db.ts', 'proj/db.ts'))).toEqual(named('db.ts', 'proj/db.ts'))
  })

  it('leaves the order alone — it is the order the tabs will appear in', () => {
    expect(
      arrangeForOpen(named('p/src/lib/deep.ts', 'p/top.ts', 'p/src/mid.ts', 'p/also.ts')),
    ).toEqual(named('src/lib/deep.ts', 'top.ts', 'src/mid.ts', 'also.ts'))
  })

  it('leaves out what lies under a directory it does not walk', () => {
    expect(
      arrangeForOpen(named('p/src/a.ts', 'p/node_modules/x/i.js', 'p/.git/h.js', 'p/dist/b.js')),
    ).toEqual(named('src/a.ts'))
  })

  it('carries whatever else rides on the entry, since the file is the point of it', () => {
    expect(arrangeForOpen([{ name: 'p/a.ts', size: 12 }])).toEqual([{ name: 'a.ts', size: 12 }])
  })
})

describe('fitToStrip', () => {
  const named = (...names: string[]) => names.map((name) => ({ name }))

  it('takes everything when there is room for it', () => {
    const picked = named('a.ts', 'src/b.ts')
    expect(fitToStrip(picked, 5)).toEqual(new Set(picked))
  })

  it('keeps the shallowest, which is where a project’s entry points are', () => {
    const picked = named('src/lib/deep.ts', 'top.ts', 'src/mid.ts', 'also.ts')
    expect([...fitToStrip(picked, 3)].map((entry) => entry.name)).toEqual([
      'also.ts',
      'top.ts',
      'src/mid.ts',
    ])
  })

  it('takes nothing when the strip is already full', () => {
    expect(fitToStrip(named('a.ts'), 0).size).toBe(0)
    expect(fitToStrip(named('a.ts'), -3).size).toBe(0)
  })
})
