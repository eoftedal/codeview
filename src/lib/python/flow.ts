/**
 * Backward provenance for Python: given a value, where could it have come from?
 *
 * The same *may*-analysis lib/flow.ts performs for TypeScript, and deliberately the same shape —
 * the same `FlowNode`, the same steps and origins, the same budgets — so the trace pane, the
 * decorations and every reading habit carry across. What differs is where the answers come from.
 * TypeScript asks a language service; this asks the scope binder in `scopes.ts`, which means:
 *
 * - **Reassignments cost nothing.** The binder already records every binding of a name in a scope,
 *   so `x = 1; x = 2` is two bindings and the walk simply takes both. `flow.ts` needs a reference
 *   query for this.
 * - **Call sites cost a scan.** There is no reference index, so `callSitesOf` walks every open
 *   file's `call` nodes and resolves each callee. Viewer-sized files make that cheap, and it runs
 *   only on an explicit trace — never on cursor movement.
 * - **A name that resolves to nothing is external**, exactly as `noLib` makes it on the other side.
 *   Builtins, `flask`, `os` — none of them resolve, so none of them pretend to.
 *
 * What it cannot do is stated rather than guessed: no aliasing, no path sensitivity, and an
 * attribute is followed only where `definitions.ts` can name it syntactically.
 */
import type { Node } from '@vscode/tree-sitter-wasm'
import type { Span } from '../definitions'
import type { FlowNode, FlowOrigin, FlowStep, FlowTrace } from '../flow'
import { isExternalOrigin } from '../flow'
import {
  bindingAt,
  describePythonBinding,
  identifierAt,
  moduleOf,
  signatureSpan,
  type PythonFile,
} from './definitions'
import { importedName } from './modules'
import {
  buildScopes,
  lookup,
  ownAttributeOf,
  scopeAt,
  scopeForNode,
  type Binding,
  type Scope,
  type ScopeTree,
} from './scopes'

// The same figures lib/flow.ts uses. A trace that behaves differently depending on the language it
// is reading would be a worse tool than one that stops in the same place.
const MAX_NODES = 200
const MAX_DEPTH = 24
const EXCERPT_LIMIT = 72

/** A binding together with the file it lives in — spans mean nothing without one. */
interface Located {
  binding: Binding
  file: PythonFile
}

interface Walk {
  files: readonly PythonFile[]
  scopes: (file: PythonFile) => ScopeTree
  nodes: FlowNode[]
  /** `file:offset` of a declaration → the node that expanded it, so cycles and diamonds
   *  terminate. Keyed by file as well as offset: two tabs share every offset. */
  expanded: Map<string, number>
  truncated: boolean
}

/* ------------------------------------------------------------------ small helpers */

function spanOf(node: Node): Span {
  return { start: node.startIndex, end: node.endIndex }
}

function keyOf(hit: Located): string {
  return `${hit.file.name}:${hit.binding.declNode.startIndex}:${hit.binding.nameNode.startIndex}`
}

function excerptOf(file: PythonFile, span: Span): string {
  const text = file.text.slice(span.start, span.end).replace(/\s+/g, ' ').trim()
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

function addNode(
  walk: Walk,
  file: PythonFile,
  span: Span,
  step: FlowStep | null,
  label: string,
): FlowNode {
  const node: FlowNode = {
    id: walk.nodes.length,
    span,
    file: file.name,
    line: lineOf(file.text, span.start),
    step,
    label,
    excerpt: excerptOf(file, span),
    children: [],
  }
  walk.nodes.push(node)
  return node
}

/** Strip the wrappers that pass a value through unchanged. */
function unwrap(node: Node): Node {
  let current = node
  for (;;) {
    if (current.type === 'parenthesized_expression' || current.type === 'await') {
      const inner = current.namedChildren.find((child): child is Node => child !== null)
      if (!inner) return current
      current = inner
      continue
    }
    return current
  }
}

const CONSTANTS = new Set([
  'string',
  'integer',
  'float',
  'true',
  'false',
  'none',
  'ellipsis',
  'concatenated_string',
])

/** A literal with no interpolation in it. An f-string carrying `{user}` is not a constant. */
function isConstant(node: Node): boolean {
  if (!CONSTANTS.has(node.type)) return false
  return interpolationsOf(node).length === 0
}

/** The expressions inside an f-string — the taint-carrying half of a formatted string. */
function interpolationsOf(node: Node): Node[] {
  const found: Node[] = []
  const walk = (current: Node) => {
    if (current.type === 'interpolation') {
      const expression = current.childForFieldName('expression')
      if (expression) found.push(expression)
      return
    }
    for (const child of current.namedChildren) if (child) walk(child)
  }
  if (node.type === 'string' || node.type === 'concatenated_string') walk(node)
  return found
}

/**
 * The parts a value was built from. Anything here contributes to the result, so the walk follows
 * every one — both sides of a ternary, every element of a list, every `{}` in an f-string.
 */
function operandsOf(node: Node): Node[] {
  const named = node.namedChildren.filter((child): child is Node => child !== null)
  switch (node.type) {
    case 'binary_operator':
    case 'boolean_operator':
      return [node.childForFieldName('left'), node.childForFieldName('right')].filter(
        (child): child is Node => child !== null,
      )
    case 'comparison_operator':
    case 'tuple':
    case 'list':
    case 'set':
    case 'expression_list':
      return named
    case 'conditional_expression':
      // `a if condition else b` — the condition decides, the other two are what arrive.
      return named.length === 3 ? [named[0]!, named[2]!] : named
    case 'unary_operator':
    case 'not_operator':
      return [node.childForFieldName('argument')].filter((child): child is Node => child !== null)
    case 'dictionary':
      return named.flatMap((entry) =>
        entry.type === 'pair'
          ? [entry.childForFieldName('value')].filter((child): child is Node => child !== null)
          : [entry],
      )
    case 'list_splat':
    case 'dictionary_splat':
      return named
    case 'string':
    case 'concatenated_string':
      return interpolationsOf(node)
    default:
      return []
  }
}

/* ------------------------------------------------------------------ resolution */

/**
 * Follow a binding through imports to the declaration it really names, so a name here and the same
 * declaration in another tab compare equal. Without this, every call site reached through an import
 * would look like a different function.
 */
function follow(hit: Located, walk: Walk, seen = new Set<string>()): Located {
  if (hit.binding.reason !== 'import') return hit
  const key = keyOf(hit)
  if (seen.has(key)) return hit
  seen.add(key)

  const target = moduleOf(hit.binding.declNode, hit.file, walk.files)
  if (!target) return hit

  const wanted = importedName(hit.binding.declNode, hit.binding.name)
  const bindings = walk.scopes(target).root.bindings.get(wanted)
  if (!bindings || bindings.length === 0) return hit
  return follow({ binding: bindings[bindings.length - 1]!, file: target }, walk, seen)
}

/** What an identifier in a given file resolves to, imports followed. */
function resolveIn(walk: Walk, file: PythonFile, identifier: Node): Located | null {
  const bound = lookup(walk.scopes(file), identifier.text, identifier.startIndex)
  return bound ? follow({ binding: bound, file }, walk) : null
}

/** Every `call` node in a file, in source order. */
function callsIn(root: Node): Node[] {
  const found: Node[] = []
  const visit = (node: Node) => {
    if (node.type === 'call') found.push(node)
    for (const child of node.namedChildren) if (child) visit(child)
  }
  visit(root)
  return found
}

/** The identifier naming what a call invokes — `f` in `f()`, `m` in `o.m()`. */
function calleeIdentifier(call: Node): Node | null {
  const callee = call.childForFieldName('function')
  if (!callee) return null
  if (callee.type === 'identifier') return callee
  if (callee.type === 'attribute') return callee.childForFieldName('attribute')
  return null
}

interface CallSite {
  call: Node
  file: PythonFile
  callee: string
  /**
   * How many leading parameters this call site does not write. `self` is implicit in both
   * `o.m(x)` and `C(x)`, so the arguments run one behind the parameters — and a constructor says
   * so nowhere in its syntax, which is why this is carried rather than re-derived from the call.
   */
  shift: number
}

/**
 * Every call of a function, across all open files.
 *
 * There is no reference index, so this scans. It is the one genuinely expensive operation in the
 * walk, which is why a trace runs on request and never on a cursor move — the same reason the
 * TypeScript side gives for its own reference queries.
 */
function callSitesOf(walk: Walk, target: Located): CallSite[] {
  const wanted = keyOf(target)
  const name = target.binding.name
  const sites: CallSite[] = []

  // A receiver this tool cannot name — `C().use(…)`, `self.conn.use(…)`, anything returned from a
  // call — leaves `o.use()` unresolvable. Dropping those would *under*-approximate, and a trace
  // that silently misses a path is the one failure this tool refuses; so where the name is declared
  // exactly once across the open tabs, an unresolvable receiver is accepted on the name alone. That
  // over-approximates, which is what a may-analysis is allowed to do. Where the name is declared
  // more than once it would be a guess between them, so only a resolvable receiver counts.
  const unambiguous = declarationsNamed(walk, name) === 1

  // Constructing a class *is* a call to its `__init__`, and nothing in the source says so — the
  // call site reads `Connection(host)`, never `__init__`. Without this every constructor parameter
  // terminates as an entry point, which is most of the interesting state in object-shaped code.
  const constructed = name === '__init__' ? enclosingClassName(walk, target) : null

  for (const file of walk.files) {
    for (const call of callsIn(file.root)) {
      const identifier = calleeIdentifier(call)
      if (identifier && constructed && identifier.text === constructed.name) {
        const resolved = resolveIn(walk, file, identifier)
        if (resolved && keyOf(resolved) === constructed.key) {
          sites.push({ call, file, callee: constructed.name, shift: 1 })
          continue
        }
      }
      if (!identifier || identifier.text !== name) continue

      if (identifier.parent?.type === 'attribute') {
        if (methodMatches(walk, file, identifier, target) || unambiguous) {
          sites.push({ call, file, callee: name, shift: 1 })
        }
        continue
      }
      const resolved = resolveIn(walk, file, identifier)
      if (resolved && keyOf(resolved) === wanted) {
        sites.push({ call, file, callee: name, shift: 0 })
      }
    }
  }
  return sites
}

/** The class a method belongs to, named and keyed so its constructions can be matched. */
function enclosingClassName(walk: Walk, target: Located): { name: string; key: string } | null {
  const tree = walk.scopes(target.file)
  const scope = scopeAt(tree, target.binding.nameNode.startIndex)
  for (let current: Scope | null = scope; current; current = current.parent) {
    if (current.kind !== 'class') continue
    const name = current.node.childForFieldName('name')
    if (!name) return null
    const outer = current.parent
    const binding = outer?.bindings
      .get(name.text)
      ?.find((candidate) => candidate.declNode.startIndex === current!.node.startIndex)
    return binding ? { name: name.text, key: keyOf({ binding, file: target.file }) } : null
  }
  return null
}

/** How many functions of this name the open tabs declare, at any depth. */
function declarationsNamed(walk: Walk, name: string): number {
  let count = 0
  for (const file of walk.files) {
    for (const scope of walk.scopes(file).all) {
      for (const binding of scope.bindings.get(name) ?? []) {
        if (binding.reason === 'function') count++
      }
    }
  }
  return count
}

/**
 * Whether `o.m()` names this method. Resolved through `bindingAt`, which knows the three syntactic
 * attribute shapes and the class hierarchy — so `self.helper()` inside the class and `C().helper()`
 * outside it both land, while `whatever.helper()` on an untypeable receiver does not.
 */
function methodMatches(walk: Walk, file: PythonFile, identifier: Node, target: Located): boolean {
  const hit = bindingAt(walk.scopes(file), file, identifier.startIndex, {
    files: walk.files,
    scopes: walk.scopes,
  })
  if (!hit || hit.viaObject) return false
  const where = hit.definedIn
    ? (walk.files.find((candidate) => candidate.name === hit.definedIn) ?? file)
    : file
  return keyOf(follow({ binding: hit.binding, file: where }, walk)) === keyOf(target)
}

/* ------------------------------------------------------------------ arguments */

/** The parameters of a function, in order. */
function parametersOf(declaration: Node): Node[] {
  const parameters = declaration.childForFieldName('parameters')
  return (parameters?.namedChildren ?? []).filter((child): child is Node => child !== null)
}

/** The name a parameter binds, whatever shape it takes. */
function parameterNameOf(node: Node): string | null {
  if (node.type === 'identifier') return node.text
  const named = node.childForFieldName('name')
  if (named) return named.text
  return node.namedChildren.find((child) => child?.type === 'identifier')?.text ?? null
}

/**
 * The argument a call supplies for a parameter — by keyword where one is named, by position
 * otherwise.
 *
 * A method called through a receiver has already consumed `self`, so the positional arguments run
 * one behind the parameters. Getting that shift wrong reports the wrong value for every argument of
 * every method, which is most of the interesting code.
 */
function argumentFor(site: CallSite, parameterIndex: number, name: string): Node | null {
  const list = site.call.childForFieldName('arguments')
  if (!list) return null
  const args = list.namedChildren.filter((child): child is Node => child !== null)

  for (const argument of args) {
    if (argument.type !== 'keyword_argument') continue
    if (argument.childForFieldName('name')?.text === name) {
      return argument.childForFieldName('value')
    }
  }

  const positional = args.filter((argument) => argument.type !== 'keyword_argument')
  const wanted = parameterIndex - site.shift
  if (wanted < 0) {
    // `self`. Through a receiver it is that receiver; in a construction it is the object being
    // made right there, which no argument stands for.
    return site.call.childForFieldName('function')?.childForFieldName('object') ?? null
  }
  return positional[wanted] ?? null
}

/** The `def` or `lambda` a parameter belongs to. */
function functionOf(parameter: Node): Node | null {
  for (let current: Node | null = parameter; current; current = current.parent) {
    if (current.type === 'function_definition' || current.type === 'lambda') return current
  }
  return null
}

/* ------------------------------------------------------------------ the walk */

/**
 * The attribute a branch is still looking for.
 *
 * When `obj.value` cannot be named — `obj` is an untyped parameter, which is most of Python — the
 * walk falls back to tracing `obj` itself. That used to end at `Wrapper(ident)` and call it a
 * literal, losing the taint exactly where a wrapper object carries it. Carrying the attribute's
 * name down that branch lets a construction of a class that *has* such an attribute connect back
 * to the argument that set it. It rides through argument, assignment and return hops unchanged, is
 * consumed by the first construction that can answer it, and where no branch can, nothing changes.
 */
type Seeking = string | undefined

function traceValue(
  walk: Walk,
  file: PythonFile,
  expression: Node,
  step: FlowStep,
  label: string,
  depth: number,
  seeking?: Seeking,
): number {
  const node = addNode(walk, file, spanOf(expression), step, label)
  expand(walk, node, file, expression, depth, seeking)
  return node.id
}

function expand(
  walk: Walk,
  node: FlowNode,
  file: PythonFile,
  expression: Node,
  depth: number,
  seeking?: Seeking,
): void {
  if (depth >= MAX_DEPTH || walk.nodes.length >= MAX_NODES) {
    node.origin = 'budget'
    walk.truncated = true
    return
  }

  const expr = unwrap(expression)

  if (isConstant(expr)) {
    node.origin = 'literal'
    return
  }

  if (expr.type === 'call') {
    expandCall(walk, node, file, expr, depth, seeking)
    return
  }

  if (expr.type === 'subscript') {
    // No index-level provenance — fall back to where the container came from.
    const object = expr.childForFieldName('value')
    if (object) {
      node.children.push(traceValue(walk, file, object, 'property', 'element of', depth + 1))
      return
    }
  }

  if (expr.type === 'identifier' || expr.type === 'attribute') {
    const hit = bindingAt(walk.scopes(file), file, lookupOffset(expr), {
      files: walk.files,
      scopes: walk.scopes,
    })
    if (!hit) {
      node.origin = 'external'
      return
    }

    // The attribute had no declaration of its own, so what came back describes the object rather
    // than this expression — `request` rather than `request.args`. That is a real hop: give it its
    // own row instead of collapsing, or the chain appears to dead-end at the attribute.
    if (hit.viaObject && expr.type === 'attribute') {
      const object = expr.childForFieldName('object')
      const attribute = expr.childForFieldName('attribute')
      if (object && attribute) {
        node.children.push(
          traceValue(
            walk,
            file,
            object,
            'property',
            `\`.${attribute.text}\` read from`,
            depth + 1,
            attribute.text,
          ),
        )
        return
      }
    }

    const where = hit.definedIn
      ? (walk.files.find((candidate) => candidate.name === hit.definedIn) ?? file)
      : file
    expandBinding(walk, node, follow({ binding: hit.binding, file: where }, walk), depth, seeking)
    return
  }

  // A function, a class or a comprehension written right here — the value originates in this file.
  if (
    expr.type === 'lambda' ||
    expr.type === 'function_definition' ||
    expr.type === 'class_definition'
  ) {
    node.origin = 'literal'
    return
  }

  const operands = operandsOf(expr)
  if (operands.length > 0) {
    for (const operand of operands) {
      node.children.push(traceValue(walk, file, operand, 'operand', 'contributes', depth + 1))
    }
    return
  }

  node.origin = 'external'
}

/** Where to ask about an expression: an attribute is asked about at its own name. */
function lookupOffset(expr: Node): number {
  if (expr.type !== 'attribute') return expr.startIndex
  return expr.childForFieldName('attribute')?.startIndex ?? expr.startIndex
}

function expandCall(
  walk: Walk,
  node: FlowNode,
  file: PythonFile,
  call: Node,
  depth: number,
  seeking?: Seeking,
): void {
  const identifier = calleeIdentifier(call)
  const hit = identifier
    ? bindingAt(walk.scopes(file), file, identifier.startIndex, {
        files: walk.files,
        scopes: walk.scopes,
      })
    : null

  // The callee name resolved only through its receiver, so this is a method we cannot see.
  if (!hit || hit.viaObject) {
    node.origin = 'external'
    expandOpaqueCall(walk, node, file, call, depth)
    return
  }

  // Follow the import *before* judging what was called: an import that lands in another open tab
  // resolves to the callee itself and the walk goes on, while one that lands nowhere is an import
  // of something not open here.
  const target = follow({ binding: hit.binding, file: fileOf(walk, hit.definedIn, file) }, walk)

  if (target.binding.reason === 'import') {
    node.origin = 'import'
    expandOpaqueCall(walk, node, file, call, depth)
    return
  }

  // Constructing a class makes a fresh object right here — but what is *in* it came from the
  // arguments, and a wrapper is its contents. Seeking one attribute answers precisely; with
  // nothing sought, or nothing that answers it, everything fed in is kept, which is the same
  // over-approximation `expandOpaqueCall` makes.
  if (target.binding.reason === 'class') {
    // The tab the class is defined in, whether or not anything below lands a row there — see
    // `FlowNode.definedIn`.
    if (target.file.name !== node.file) node.definedIn = target.file.name
    const initializer = initOf(walk, target)
    if (seeking) {
      const owner = scopeForNode(walk.scopes(target.file), target.binding.declNode)
      // The wrapper's own attributes only; one declared on a base class is not followed here.
      const attribute = owner && ownAttributeOf(owner, seeking, call.startIndex)
      if (attribute) {
        // Through the constructor's own row where the class defines one: `__init__` is where a
        // value is validated, normalised or rejected, and a trace that steps over it reads as
        // though the value arrived untouched.
        const host = constructorRow(walk, node, initializer, target, call)
        expandBinding(walk, host, { binding: attribute, file: target.file }, depth)
        return
      }
    }

    const args: Node[] = []
    for (const argument of call.childForFieldName('arguments')?.namedChildren ?? []) {
      if (!argument) continue
      const value =
        argument.type === 'keyword_argument' ? argument.childForFieldName('value') : argument
      if (value && !isConstant(unwrap(value))) args.push(value)
    }
    // Nothing went in that is worth following: the object really is made right here.
    if (args.length === 0) {
      node.origin = 'literal'
      return
    }

    const host = constructorRow(walk, node, initializer, target, call)
    const name = calleeIdentifier(call)?.text ?? target.binding.name
    for (const argument of args) {
      host.children.push(
        traceValue(walk, file, argument, 'argument', `passed to \`${name}\``, depth + 1, seeking),
      )
    }
    return
  }

  if (target.binding.reason !== 'function') {
    node.origin = 'external'
    expandOpaqueCall(walk, node, file, call, depth)
    return
  }

  expandReturns(walk, node, target, depth)
}

/** The tab a hit's `definedIn` names, falling back to the one asked in. */
function fileOf(walk: Walk, definedIn: string | undefined, fallback: PythonFile): PythonFile {
  if (!definedIn) return fallback
  return walk.files.find((candidate) => candidate.name === definedIn) ?? fallback
}

/** A call we can follow: its value is whatever the body returns. */
function expandReturns(walk: Walk, node: FlowNode, target: Located, depth: number): void {
  const key = keyOf(target)
  const seen = walk.expanded.get(key)
  if (seen !== undefined) {
    node.origin = 'cycle'
    node.seenAs = seen
    return
  }
  walk.expanded.set(key, node.id)

  const returns = returnsOf(target.binding.declNode)
  if (returns.length === 0) {
    terminateAtBinding(walk, node, target, 'external')
    return
  }
  for (const value of returns) {
    node.children.push(traceValue(walk, target.file, value, 'return', 'returned from', depth + 1))
  }
}

/** Every value a function returns, not descending into functions nested inside it. */
function returnsOf(declaration: Node): Node[] {
  const found: Node[] = []
  const body = declaration.childForFieldName('body')
  if (!body) return found

  const visit = (node: Node) => {
    if (node.type === 'function_definition' || node.type === 'lambda') return
    if (node.type === 'return_statement') {
      for (const child of node.namedChildren) if (child) found.push(child)
      return
    }
    for (const child of node.namedChildren) if (child) visit(child)
  }

  // A lambda's body *is* its value.
  if (declaration.type === 'lambda') return [body]
  visit(body)
  return found
}

/**
 * A call we cannot follow — a builtin, something imported from outside, a method on a value with no
 * name we can resolve. The result came from outside, but what was *fed into* it is still worth
 * showing: that is how `open(path)` and `subprocess.run(cmd)` stay legible.
 */
/**
 * The `__init__` a construction runs, where the class defines one of its own — the row the value
 * passes through on its way in. A class without one has nothing to show and gets no row.
 */
function initOf(walk: Walk, target: Located): Node | null {
  const owner = scopeForNode(walk.scopes(target.file), target.binding.declNode)
  const declaration = owner?.bindings.get('__init__')?.[0]?.declNode
  return declaration && declaration.type === 'function_definition' ? declaration : null
}

/** The row for that constructor, or the node itself where there is none to show. */
function constructorRow(
  walk: Walk,
  node: FlowNode,
  initializer: Node | null,
  target: Located,
  call: Node,
): FlowNode {
  if (!initializer) return node
  const name = calleeIdentifier(call)?.text ?? target.binding.name
  const row = addNode(
    walk,
    target.file,
    signatureSpan(initializer, target.file.text),
    'declaration',
    `constructed by \`${name}\``,
  )
  node.children.push(row.id)
  return row
}

function expandOpaqueCall(
  walk: Walk,
  node: FlowNode,
  file: PythonFile,
  call: Node,
  depth: number,
): void {
  const parts: Node[] = []
  const callee = call.childForFieldName('function')
  if (callee?.type === 'attribute') {
    const object = callee.childForFieldName('object')
    if (object) parts.push(object)
  }
  for (const argument of call.childForFieldName('arguments')?.namedChildren ?? []) {
    if (!argument) continue
    const value =
      argument.type === 'keyword_argument' ? argument.childForFieldName('value') : argument
    if (value) parts.push(value)
  }

  // A constant fed into an opaque call says nothing about where anything came from, and the same
  // rule on the TypeScript side is what keeps these lists readable.
  for (const part of parts) {
    if (isConstant(unwrap(part))) continue
    node.children.push(traceValue(walk, file, part, 'operand', 'flows into the call', depth + 1))
  }
}

function terminateAtBinding(walk: Walk, node: FlowNode, hit: Located, origin: FlowOrigin): void {
  const view = describePythonBinding(hit.binding, hit.file.text)
  if (node.file === hit.file.name && node.span.start === view.span.start) {
    node.origin = origin
    return
  }
  const child = addNode(walk, hit.file, view.span, 'declaration', view.label)
  child.origin = origin
  node.children.push(child.id)
}

function expandBinding(
  walk: Walk,
  node: FlowNode,
  hit: Located,
  depth: number,
  seeking?: Seeking,
): void {
  const key = keyOf(hit)
  const seen = walk.expanded.get(key)
  if (seen !== undefined) {
    node.origin = 'cycle'
    node.seenAs = seen
    return
  }
  walk.expanded.set(key, node.id)

  const { binding, file } = hit
  const declaration = binding.declNode

  if (binding.reason === 'import') {
    terminateAtBinding(walk, node, hit, 'import')
    return
  }

  if (binding.reason === 'parameter') {
    expandParameter(walk, node, hit, depth, seeking)
    return
  }

  if (binding.reason === 'function' || binding.reason === 'class') {
    terminateAtBinding(walk, node, hit, 'literal')
    return
  }

  // An assignment, an augmented assignment, a walrus, a `self.x = …`, a class-body name. Every
  // binding of this name in this scope contributes — the binder already collected them, so a
  // reassignment needs no reference query.
  const writes = writesFor(walk, hit)
  if (writes.length > 0) {
    for (const [index, write] of writes.entries()) {
      const step: FlowStep = index === 0 ? 'initializer' : 'assignment'
      const label = index === 0 ? 'initialised from' : 'reassigned'
      node.children.push(traceValue(walk, file, write, step, label, depth + 1, seeking))
    }
    return
  }

  // A `for` target, a `with … as`, an `except … as`: the value comes from what is being iterated,
  // entered or caught.
  const source = sourceOfBinder(declaration)
  if (source) {
    node.children.push(traceValue(walk, file, source.expr, source.step, source.label, depth + 1))
    return
  }

  terminateAtBinding(walk, node, hit, 'external')
}

/** Every value assigned to this name in its scope, in source order. */
function writesFor(walk: Walk, hit: Located): Node[] {
  const tree = walk.scopes(hit.file)
  const scope = owningScope(tree, hit.binding)
  const candidates =
    (hit.binding.reason === 'property'
      ? scope?.attributes.get(hit.binding.name)
      : scope?.bindings.get(hit.binding.name)) ?? []

  const values: Node[] = []
  for (const candidate of candidates) {
    const declaration = candidate.declNode
    if (declaration.type === 'assignment' || declaration.type === 'augmented_assignment') {
      const right = declaration.childForFieldName('right')
      if (right) values.push(right)
    } else if (declaration.type === 'named_expression') {
      const value = declaration.childForFieldName('value')
      if (value) values.push(value)
    }
  }
  return values
}

/** The scope that holds a binding — where its siblings for the same name live. */
function owningScope(tree: ScopeTree, binding: Binding): Scope | null {
  const scope = scopeAt(tree, binding.nameNode.startIndex)
  for (let current: Scope | null = scope; current; current = current.parent) {
    const own = current.bindings.get(binding.name) ?? current.attributes.get(binding.name)
    if (own?.some((candidate) => candidate.nameNode.startIndex === binding.nameNode.startIndex)) {
      return current
    }
  }
  return scope
}

/** Where a `for`, `with` or `except` target's value comes from. */
function sourceOfBinder(declaration: Node): { expr: Node; step: FlowStep; label: string } | null {
  if (declaration.type === 'for_statement' || declaration.type === 'for_in_clause') {
    const right = declaration.childForFieldName('right')
    return right ? { expr: right, step: 'binding', label: 'an element of' } : null
  }
  if (declaration.type === 'as_pattern') {
    const subject = declaration.namedChildren.find(
      (child): child is Node => child !== null && child.type !== 'as_pattern_target',
    )
    if (!subject) return null
    // `except ValueError as e` catches a value raised elsewhere; `with open(p) as f` enters one.
    const caught = declaration.parent?.type === 'except_clause'
    return caught ? null : { expr: subject, step: 'binding', label: 'entered from' }
  }
  return null
}

function expandParameter(
  walk: Walk,
  node: FlowNode,
  hit: Located,
  depth: number,
  seeking?: Seeking,
): void {
  const { binding, file } = hit
  const declaration = functionOf(binding.declNode)
  if (!declaration) {
    terminateAtBinding(walk, node, hit, 'external')
    return
  }

  const owner = ownerBinding(walk, declaration, file)
  const sites = owner ? callSitesOf(walk, owner) : []
  const parameters = parametersOf(declaration)
  const index = parameters.findIndex((parameter) => parameterNameOf(parameter) === binding.name)

  const supplied: { expr: Node; file: PythonFile; callee: string }[] = []
  for (const site of sites) {
    const argument = argumentFor(site, index, binding.name)
    if (argument) supplied.push({ expr: argument, file: site.file, callee: site.callee })
  }

  if (supplied.length === 0) {
    // A named function nobody calls here is an entry point; an unnamed one was handed to something
    // else to invoke — a route decorator, a `map` — so its caller fills this in.
    const origin: FlowOrigin = declaration.type === 'lambda' ? 'callback' : 'entry'
    terminateAtBinding(walk, node, hit, origin)
    return
  }

  // The walk leaves for the call sites from here, so this declaration gets no row of its own and no
  // child sits inside it. Record it for the editor, unless the node already is it.
  const view = describePythonBinding(binding, file.text)
  if (!(node.file === file.name && node.span.start === view.span.start)) {
    node.via = { span: view.span, file: file.name }
  }

  for (const source of supplied) {
    node.children.push(
      traceValue(
        walk,
        source.file,
        source.expr,
        'argument',
        `passed to \`${source.callee}\``,
        depth + 1,
        seeking,
      ),
    )
  }
}

/** The binding a `def` declares, so its call sites can be found. */
function ownerBinding(walk: Walk, declaration: Node, file: PythonFile): Located | null {
  const name = declaration.childForFieldName('name')
  if (!name) return null
  const tree = walk.scopes(file)
  const scope = scopeAt(tree, name.startIndex)
  for (let current: Scope | null = scope; current; current = current.parent) {
    const found = current.bindings
      .get(name.text)
      ?.find((candidate) => candidate.declNode.startIndex === declaration.startIndex)
    if (found) return { binding: found, file }
  }
  return null
}

/* ------------------------------------------------------------------ entry point */

/**
 * Trace the value at `offset` back to its sources, following it into the other open tabs wherever
 * an import leads. Null when nothing at the offset resolves — the same condition under which there
 * is no definition to highlight.
 */
export function tracePythonOrigins(
  active: PythonFile,
  files: readonly PythonFile[],
  offset: number,
): FlowTrace | null {
  const built = new Map<string, ScopeTree>()
  const scopes = (file: PythonFile): ScopeTree => {
    const existing = built.get(file.name)
    if (existing) return existing
    const made = buildScopes(file.root)
    built.set(file.name, made)
    return made
  }

  const walk: Walk = { files, scopes, nodes: [], expanded: new Map(), truncated: false }
  const hit = bindingAt(scopes(active), active, offset, { files, scopes })
  if (!hit) return null

  // The root is always in the file being looked at. A declaration in another tab has no range here,
  // so the row shows the local stand-in — the import that brought it in — while the label still
  // names what was asked about, and the expansion below crosses into the other file.
  const view = describePythonBinding(hit.local ?? hit.binding, active.text)
  const root = addNode(
    walk,
    active,
    view.span,
    null,
    `${hit.binding.reason} \`${hit.binding.name}\``,
  )

  const where = hit.definedIn
    ? (files.find((candidate) => candidate.name === hit.definedIn) ?? active)
    : active

  // Tracing *at* `obj.value` roots on `obj`'s declaration — the walk never passes through `expand`,
  // so the attribute being asked about would be lost before the first hop. Seed it here, or the
  // most natural place to put the cursor is the one place the wrapper walk does not happen.
  const identifier = identifierAt(active.root, offset)
  const seeking =
    hit.viaObject && identifier?.parent?.type === 'attribute' ? identifier.text : undefined

  expandBinding(walk, root, follow({ binding: hit.binding, file: where }, walk), 0, seeking)

  return {
    nodes: walk.nodes,
    root: root.id,
    externalCount: walk.nodes.filter((node) => isExternalOrigin(node.origin)).length,
    truncated: walk.truncated,
  }
}
