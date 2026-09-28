/**
 * A trace as text, for pasting into the chat or an agent's task.
 *
 * The pane is where a trace is *read* — collapsible, clickable, highlighted in the editor. None of
 * that survives a copy, and what a model needs is different anyway: **every step has to name its
 * file and its line**, where the pane leaves the file off a step in the tab on screen because the
 * editor beside it already says which that is. Pasted somewhere else there is no editor, so a bare
 * line number would point into whichever file the reader happens to be talking about.
 *
 * The shape is a **markdown nested list**, and that is a choice for two readers at once. A model is
 * shown the same citation shape `DEFAULT_ROLE` asks it to produce — `name (file line N)` — so a
 * pasted trace reads like the answers it is being asked for; and the chat transcript renders it as
 * the tree it is, where plain indentation would be collapsed into one paragraph by
 * `markdown.ts`'s paragraph rule.
 *
 * The caveats travel with it. A trace is a may-analysis, and a model handed one without that line
 * will report a path the code never takes as a finding — the same reason the pane states it in its
 * footer and the README states it twice.
 *
 * Pure: a `FlowTrace` in, a string out, with no reference to what is on screen.
 */

import type { FlowOrigin, FlowTrace } from './flow'

/**
 * What a terminal means, spelled out. Deliberately not `TraceRow.vue`'s `ORIGIN_TEXT`, which is
 * two words for a column beside the row that explains them: here the words are all there is, and
 * they are read by someone — or something — that never saw the pane.
 */
const ORIGIN: Record<FlowOrigin, string> = {
  literal: 'defined here',
  import: 'imported from a module that is not open',
  external: 'from outside the open files',
  entry: 'a parameter of a function nothing open calls',
  callback: 'a parameter supplied by whoever calls back',
  cycle: 'already traced above',
  budget: 'the walk stopped at its budget here',
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The whole trace, however much of it is folded away on screen: what is copied is the analysis,
 * not the view of it.
 */
export function traceToText(trace: FlowTrace): string {
  const root = trace.nodes[trace.root]!
  const files = new Set(trace.nodes.map((node) => node.file)).size
  const external =
    trace.externalCount > 0
      ? count(
          trace.externalCount,
          'origin outside the open files',
          'origins outside the open files',
        )
      : 'no origin outside the open files'

  const lines: string[] = []
  const walk = (id: number, depth: number): void => {
    const node = trace.nodes[id]!
    const origin = node.origin ? ` — ${ORIGIN[node.origin]}` : ''
    const said = node.excerpt ? `${node.label}: ${node.excerpt}` : node.label
    lines.push(`${'  '.repeat(depth)}- ${said} (${node.file} line ${node.line})${origin}`)
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(trace.root, 0)

  return [
    `Backward trace of ${root.label}, from ${root.file} line ${root.line} — ${count(trace.nodes.length, 'step')}, ${count(files, 'file')}, ${external}.`,
    '',
    ...lines,
    '',
    // Three sentences, each earning its space. The first says how to read the indentation, which
    // is the only thing carrying the shape of the path. The second is the limit, without which a
    // may-analysis reads as a claim about what the code does.
    //
    // The third is about this text rather than about the trace, and it exists because of what a
    // model does with a rich artefact: an excerpt per step, with files and line numbers, is
    // *enough to write a plausible answer from* — so one that could open the files often does not
    // bother, and reviews the trace instead of the code. Saying the excerpts are excerpts is the
    // cheapest lever on that. It is true on both paths: a model holding the listing has the file
    // in front of it, and a model with `read_file` can go and get it.
    'Each step is where the value above it came from. This is a may-analysis: every path that could reach the value is shown, with no aliasing and no path sensitivity, so a path here is one the code could take rather than one it does. The lines quoted here are single-line excerpts and not the code: check every step against the file it names before you rely on it, and do not report a finding from this text alone.',
    ...(trace.truncated
      ? ['', 'The walk stopped at its budget before it finished, so this trace is incomplete.']
      : []),
  ].join('\n')
}

/**
 * What the pane's **Analyze this trace** button asks. Deliberately this bare: what "analyze" means
 * is the brief's to say, and the brief is the reader's — a hunter, a rewritten role, or the shipped
 * taint reviewer. A question that named what to look for would compete with it, the same way an
 * orchestrator brief naming its own review beat the reader's task in `agents.ts`.
 */
export const ANALYZE_TASK = 'Analyze this trace.'

/**
 * The task, the files and the trace as one question — what the button sends, and what the
 * transcript then shows. The reader sees exactly what was asked.
 *
 * The files ride the question as `@` tags rather than as an argument beside it, and that is the
 * whole of how **Analyze this trace** narrows a conversation now. It costs a line of the question
 * and buys three things: what narrowed the conversation is visible *in* the conversation, it is
 * editable before the question is sent — drop a tag, add a tab the trace never reached — and the
 * pane needs no second channel for something the text can carry. `mentions.ts` resolves them, and
 * resolves them against the open tabs, which is also why the `@PathVariable` in the trace below is
 * read as the annotation it is and not as a file.
 */
export function traceQuestion(trace: FlowTrace): string {
  const tags = tracedFiles(trace).map((name) => `@${name}`)
  return `${[ANALYZE_TASK, ...tags].join(' ')}\n\n${traceToText(trace)}`
}

/**
 * The files the trace names, in the order it first names them — the root's first.
 *
 * This is what the analysis chat is opened over, and the order matters as much as the membership:
 * the code budget is spent in the order given, so what a tight one clips is the far end of the
 * path rather than the value the reader asked about. It is exactly the set `traceToText` cites,
 * which is the invariant worth keeping — a chat given a file the text never mentions has paid for
 * it, and one missing a file the text cites cannot check the citation.
 */
export function tracedFiles(trace: FlowTrace): string[] {
  const named: string[] = []
  const take = (name: string | undefined): void => {
    if (name && !named.includes(name)) named.push(name)
  }
  const walk = (id: number): void => {
    const node = trace.nodes[id]!
    take(node.file)
    // A wrapper the value passed straight through — `new ProductId(id)` with the record in
    // another tab — may leave no row in the file that declares it, and a model cannot judge the
    // path without that source. See `FlowNode.definedIn`.
    take(node.definedIn)
    for (const child of node.children) walk(child)
  }
  walk(trace.root)
  return named
}

/*
 * What a narrowed conversation says about itself is no longer here: a trace narrows one the same
 * way a typed `@` does, so the sentence belongs with the tags — `describeScope` in `mentions.ts`.
 */
