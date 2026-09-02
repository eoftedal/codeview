import type { InjectionKey, Ref } from 'vue'
import type { Span } from '../lib/definitions'
import type { FlowTrace } from '../lib/flow'

/**
 * Shared state for the recursive trace rows. Injected rather than prop-drilled, and held as refs so
 * the trace graph is never deeply proxied — the same constraint the AST tree has.
 */
export interface TraceContext {
  trace: Ref<FlowTrace>
  expanded: Ref<Set<number>>
  selectedId: Ref<number | null>
  toggle: (id: number) => void
  select: (id: number) => void
  hover: (span: Span | null) => void
}

export const traceContextKey: InjectionKey<TraceContext> = Symbol('traceContext')
