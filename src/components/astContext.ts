import type { InjectionKey, Ref } from 'vue'
import type { AstTree } from '../lib/astTree'

/**
 * Shared state for the recursive tree rows. Passed by injection rather than by prop drilling, and
 * held as refs so the (large, shallow) tree is never deeply proxied.
 */
export interface AstContext {
  tree: Ref<AstTree>
  expanded: Ref<Set<number>>
  /** Ids to render while a filter is active; null means everything is visible. */
  visible: Ref<Set<number> | null>
  selectedId: Ref<number | null>
  definitionIds: Ref<Set<number>>
  toggle: (id: number) => void
  select: (id: number) => void
  hover: (id: number | null) => void
}

export const astContextKey: InjectionKey<AstContext> = Symbol('astContext')
