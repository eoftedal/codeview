import { describe, expect, it } from 'vitest'
import { createCBackend } from '../src/lib/c/backend'
import { createCSharpBackend } from '../src/lib/csharp/backend'
import { createJavaBackend } from '../src/lib/java/backend'
import { createPythonBackend } from '../src/lib/python/backend'
import { createTsBackend } from '../src/lib/tsBackend'

/**
 * `AnalysisBackend.trace` is **optional rather than null-returning**, because a pane has to tell
 * "nothing resolved at this offset" apart from "this language has no trace" to explain itself. That
 * distinction is only worth anything if a backend actually omits it, which until C and C++ none did.
 */
describe('which backends offer a backward trace', () => {
  it('offers one on every language whose values it can honestly follow', () => {
    expect(typeof createTsBackend(() => 'ts').trace).toBe('function')
    expect(typeof createPythonBackend().trace).toBe('function')
    expect(typeof createJavaBackend().trace).toBe('function')
    expect(typeof createCSharpBackend().trace).toBe('function')
  })

  it('omits it entirely for C and C++, rather than returning null', () => {
    // Returning null would read as "nothing here", and the pane would offer a Trace button that
    // never answers. See src/lib/c/backend.ts for why the language declines one.
    expect(createCBackend().trace).toBeUndefined()
    expect('trace' in createCBackend()).toBe(false)
  })

  it('still answers the two questions every language owes', () => {
    const backend = createCBackend()
    expect(typeof backend.tree).toBe('function')
    expect(typeof backend.resolve).toBe('function')
    // Null until the grammar has loaded, which is what `ready` is for.
    expect(backend.tree({})).toBeNull()
    expect(typeof backend.ready).toBe('function')
  })
})
