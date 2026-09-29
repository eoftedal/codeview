/**
 * What a language has to provide to fill the two right-hand panes.
 *
 * This file imports nothing from `typescript`, and that is the point: everything crossing it is
 * plain data — spans are offsets, kinds are strings, a file is a name and a text. The TypeScript
 * path (lib/analyzer.ts and friends) is one implementation, reached through lib/tsBackend.ts;
 * lib/python/, lib/java/, lib/c/ and lib/csharp/ are the others. None knows the others exist, and
 * nothing above this line knows which answered.
 *
 * Cross-language resolution deliberately does not exist. `useAnalysis` partitions the open tabs by
 * language and hands each backend only its own, so a `.ts` file's import never sees `db.py` and
 * Python's `import db` never sees `db.ts`. There is no build system here to say what would bridge
 * them, and inventing one would mean guessing.
 */
import type { AstTree, BuildOptions } from './astTree'
import type { DefinitionResult } from './definitions'
import type { FlowTrace } from './flow'

/** One open file, as a backend sees it. `name` is also the path other files import it by. */
export interface BackendFile {
  name: string
  text: string
}

export interface AnalysisBackend {
  /**
   * Replace this backend's file set, and say which file is being looked at. Returns true when
   * anything but that pointer changed, so a caller can tell a real edit from a tab switch.
   */
  update(files: readonly BackendFile[], activeName: string): boolean
  /** Null only while an asynchronous grammar is still loading — see `ready`. */
  tree(options: BuildOptions): AstTree | null
  resolve(offset: number): DefinitionResult | null
  /**
   * Backward provenance, where the language has it.
   *
   * Deliberately **optional** rather than null-returning: `null` already means "nothing at this
   * offset resolved", and a pane needs to tell that apart from "this language has no trace at all"
   * so it can explain itself instead of looking broken.
   */
  trace?(offset: number): FlowTrace | null
  /**
   * Resolves once the backend can answer. Absent on a backend that is ready the moment it is
   * built, which is every synchronous one.
   */
  ready?(): Promise<void>
}
