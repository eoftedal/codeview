import type { InjectionKey, Ref } from 'vue'
import type { FlowTarget, FlowTrace } from '../lib/flow'

/**
 * Shared state for the recursive trace rows. Injected rather than prop-drilled, and held as refs so
 * the trace graph is never deeply proxied — the same constraint the AST tree has.
 */
export interface TraceContext {
  trace: Ref<FlowTrace>
  /** The tab on screen, so a row can say when its step is somewhere else. */
  activeFile: Ref<string>
  expanded: Ref<Set<number>>
  selectedId: Ref<number | null>
  toggle: (id: number) => void
  select: (id: number) => void
  hover: (target: FlowTarget | null) => void
}

export const traceContextKey: InjectionKey<TraceContext> = Symbol('traceContext')
