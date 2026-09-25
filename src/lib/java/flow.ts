/**
 * Backward provenance for Java.
 *
 * Same walk, same `FlowNode`s, same budgets as lib/flow.ts and python/flow.ts, over the Java binder.
 * Two things differ from the Python one and both cost work:
 *
 * - **Reassignment is not a declaration.** Python's binder records every `x = …` as a binding, so
 *   the walk got them free. Java writes `x = …` as an `assignment_expression` that declares
 *   nothing, so `writesFor` scans the declaration's enclosing scope and resolves each candidate
 *   back to the same binding.
 * - **A receiver carries a written-down type.** `Db db = new Db()` says what `db` is on the line,
 *   which is why `db.run()` follows into `Db.run` where Python's equivalent could not.
 *
 * What it still cannot do is stated: an **overload** is separated by arity alone, and a receiver
 * whose type is not written down locally (a method's return value, a field of an external type)
 * leaves its members unresolvable — the walk then shows where the receiver came from rather than
 * guessing which declaration was meant.
 */
import type { Node } from '@vscode/tree-sitter-wasm'
import type { Span } from '../definitions'
import type { FlowNode, FlowOrigin, FlowStep, FlowTrace } from '../flow'
import { isExternalOrigin } from '../flow'
import { bindingAt, type JavaFile } from './definitions'
import { importedName, moduleFor } from './modules'
import { buildScopes, scopeAt, type Binding, type Scope, type ScopeTree } from './scopes'

const MAX_NODES = 200
const MAX_DEPTH = 24
const EXCERPT_LIMIT = 72

interface Located {
  binding: Binding
  file: JavaFile
}

interface Walk {
  files: readonly JavaFile[]
  scopes: (file: JavaFile) => ScopeTree
  nodes: FlowNode[]
  expanded: Map<string, number>
  truncated: boolean
}

/* ------------------------------------------------------------------ helpers */

function spanOf(node: Node): Span {
  return { start: node.startIndex, end: node.endIndex }
}

function keyOf(hit: Located): string {
  return `${hit.file.name}:${hit.binding.declNode.startIndex}:${hit.binding.nameNode.startIndex}`
}

function excerptOf(file: JavaFile, span: Span): string {
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
  file: JavaFile,
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
    if (current.type === 'parenthesized_expression') {
      const inner = current.namedChildren.find((child): child is Node => child !== null)
      if (!inner) return current
      current = inner
      continue
    }
    if (current.type === 'cast_expression') {
      const value = current.childForFieldName('value')
      if (!value) return current
      current = value
      continue
    }
    return current
  }
}

const CONSTANTS = new Set([
  'string_literal',
  'text_block',
  'character_literal',
  'decimal_integer_literal',
  'hex_integer_literal',
  'octal_integer_literal',
  'binary_integer_literal',
  'decimal_floating_point_literal',
  'hex_floating_point_literal',
  'true',
  'false',
  'null_literal',
])

function isConstant(node: Node): boolean {
  return CONSTANTS.has(node.type)
}

function operandsOf(node: Node): Node[] {
  const named = node.namedChildren.filter((child): child is Node => child !== null)
  switch (node.type) {
    case 'binary_expression':
      return [node.childForFieldName('left'), node.childForFieldName('right')].filter(
        (child): child is Node => child !== null,
      )
    case 'ternary_expression':
      return [node.childForFieldName('consequence'), node.childForFieldName('alternative')].filter(
        (child): child is Node => child !== null,
      )
    case 'unary_expression':
      return [node.childForFieldName('operand')].filter((child): child is Node => child !== null)
    case 'array_initializer':
      return named
    case 'switch_expression':
      return named
    default:
      return []
  }
}

/* ------------------------------------------------------------------ resolution */

/** Follow an import to the declaration it names, so the same type compares equal across tabs. */
function follow(hit: Located, walk: Walk, seen = new Set<string>()): Located {
  if (hit.binding.reason !== 'import') return hit
  const key = keyOf(hit)
  if (seen.has(key)) return hit
  seen.add(key)

  const path = moduleFor(
    hit.binding.declNode,
    walk.files.map((file) => file.name),
  )
  const target = walk.files.find((file) => file.name === path)
  if (!target) return hit

  const wanted = importedName(hit.binding.declNode) ?? hit.binding.name
  const bindings = walk.scopes(target).root.bindings.get(wanted)
  if (!bindings || bindings.length === 0) return hit
  return follow({ binding: bindings[bindings.length - 1]!, file: target }, walk, seen)
}

function fileOf(walk: Walk, definedIn: string | undefined, fallback: JavaFile): JavaFile {
  if (!definedIn) return fallback
  return walk.files.find((candidate) => candidate.name === definedIn) ?? fallback
}

function hitAt(walk: Walk, file: JavaFile, offset: number) {
  return bindingAt(walk.scopes(file), file, offset, { files: walk.files, scopes: walk.scopes })
}

/** Every node of a type in a subtree, in source order. */
function nodesOfType(root: Node, type: string): Node[] {
  const found: Node[] = []
  const visit = (node: Node) => {
    if (node.type === type) found.push(node)
    for (const child of node.namedChildren) if (child) visit(child)
  }
  visit(root)
  return found
}

/* ------------------------------------------------------------------ call sites */

interface CallSite {
  call: Node
  file: JavaFile
  callee: string
  /** How many leading parameters the call site does not write. Always 0 in Java — a receiver is
   *  not a parameter the way Python's `self` is — but kept so the shape matches. */
  shift: number
}

function calleeName(call: Node): Node | null {
  if (call.type === 'method_invocation') return call.childForFieldName('name')
  if (call.type === 'object_creation_expression') {
    const type = call.childForFieldName('type')
    return type?.type === 'type_identifier' ? type : null
  }
  return null
}

/**
 * Every call of a method, across all open tabs.
 *
 * There is no reference index, so this scans. A receiver whose type is written down resolves
 * exactly; one that is not — a chained call, a field of a type we cannot see — is accepted on the
 * method name alone, but only where that name is declared once across the open tabs. Dropping it
 * instead would *under*-approximate, and a trace that silently misses a path is the one failure
 * this tool refuses.
 */
function callSitesOf(walk: Walk, target: Located): CallSite[] {
  const wanted = keyOf(target)
  const name = target.binding.name
  const sites: CallSite[] = []
  const unambiguous = declarationsNamed(walk, name) === 1
  // A constructor is called by writing the type's name, never its own.
  const constructorOf = isConstructor(target) ? name : null

  for (const file of walk.files) {
    for (const type of ['method_invocation', 'object_creation_expression']) {
      for (const call of nodesOfType(file.root, type)) {
        const identifier = calleeName(call)
        if (!identifier || identifier.text !== name) continue

        if (type === 'object_creation_expression') {
          if (constructorOf) sites.push({ call, file, callee: name, shift: 0 })
          continue
        }

        const hit = hitAt(walk, file, identifier.startIndex)
        const resolved =
          hit && !hit.viaObject
            ? follow({ binding: hit.binding, file: fileOf(walk, hit.definedIn, file) }, walk)
            : null
        if ((resolved && keyOf(resolved) === wanted) || (!resolved && unambiguous)) {
          sites.push({ call, file, callee: name, shift: 0 })
        }
      }
    }
  }
  return sites
}

function argumentsIn(call: Node): number {
  const args = call.childForFieldName('arguments')
  return args ? args.namedChildren.filter((child) => child !== null).length : 0
}

/**
 * A record component, which is a parameter of the canonical constructor as much as it is a field.
 * `record ProductId(String value)` declares both, and neither is written down anywhere to walk to.
 */
function recordComponent(binding: Binding): { record: Node; index: number } | null {
  const declaration = binding.declNode
  if (declaration.type !== 'formal_parameter') return null
  const list = declaration.parent
  if (list?.type !== 'formal_parameters') return null
  const record = list.parent
  if (record?.type !== 'record_declaration') return null
  const index = list.namedChildren
    .filter((child): child is Node => child !== null)
    .findIndex((child) => child.id === declaration.id)
  return index >= 0 ? { record, index } : null
}

/**
 * Every `new R(…)` across the open tabs, matched on the type's name.
 *
 * A type name is far more distinctive than a method name, so this over-approximates much less than
 * the equivalent rule for methods — and under-approximating would lose the only edge a record
 * component has, since its value arrives through the canonical constructor and nowhere else.
 */
function constructionsOf(walk: Walk, record: Node): CallSite[] {
  const name = record.childForFieldName('name')?.text
  if (!name) return []
  const sites: CallSite[] = []
  for (const file of walk.files) {
    for (const call of nodesOfType(file.root, 'object_creation_expression')) {
      if (call.childForFieldName('type')?.text !== name) continue
      sites.push({ call, file, callee: name, shift: 0 })
    }
  }
  return sites
}

/** A constructor declares a method whose name is its own type's. */
function isConstructor(target: Located): boolean {
  return target.binding.declNode.type === 'constructor_declaration'
}

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

/* ------------------------------------------------------------------ arguments */

function parametersOf(declaration: Node): Node[] {
  const parameters = declaration.childForFieldName('parameters')
  return (parameters?.namedChildren ?? []).filter((child): child is Node => child !== null)
}

function parameterNameOf(node: Node): string | null {
  if (node.type === 'identifier') return node.text
  return (
    node.childForFieldName('name')?.text ??
    node.namedChildren.find((child) => child?.type === 'identifier')?.text ??
    null
  )
}

function argumentFor(site: CallSite, parameterIndex: number): Node | null {
  const list = site.call.childForFieldName('arguments')
  if (!list) return null
  const args = list.namedChildren.filter((child): child is Node => child !== null)
  return args[parameterIndex - site.shift] ?? null
}

function methodOf(parameter: Node): Node | null {
  for (let current: Node | null = parameter; current; current = current.parent) {
    if (
      current.type === 'method_declaration' ||
      current.type === 'constructor_declaration' ||
      current.type === 'lambda_expression'
    ) {
      return current
    }
  }
  return null
}

/* ------------------------------------------------------------------ the walk */

function traceValue(
  walk: Walk,
  file: JavaFile,
  expression: Node,
  step: FlowStep,
  label: string,
  depth: number,
): number {
  const node = addNode(walk, file, spanOf(expression), step, label)
  expand(walk, node, file, expression, depth)
  return node.id
}

function expand(walk: Walk, node: FlowNode, file: JavaFile, expression: Node, depth: number): void {
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

  if (expr.type === 'method_invocation' || expr.type === 'object_creation_expression') {
    expandCall(walk, node, file, expr, depth)
    return
  }

  if (expr.type === 'array_access') {
    const array = expr.childForFieldName('array')
    if (array) {
      node.children.push(traceValue(walk, file, array, 'property', 'element of', depth + 1))
      return
    }
  }

  if (expr.type === 'identifier' || expr.type === 'field_access') {
    const hit = hitAt(walk, file, lookupOffset(expr))
    if (!hit) {
      node.origin = 'external'
      return
    }

    if (hit.viaObject && expr.type === 'field_access') {
      const object = expr.childForFieldName('object')
      const field = expr.childForFieldName('field')
      if (object && field) {
        node.children.push(
          traceValue(walk, file, object, 'property', `\`.${field.text}\` read from`, depth + 1),
        )
        return
      }
    }

    expandBinding(
      walk,
      node,
      follow({ binding: hit.binding, file: fileOf(walk, hit.definedIn, file) }, walk),
      depth,
    )
    return
  }

  if (expr.type === 'lambda_expression' || expr.type === 'array_initializer') {
    if (expr.type === 'lambda_expression') {
      node.origin = 'literal'
      return
    }
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

function lookupOffset(expr: Node): number {
  if (expr.type !== 'field_access') return expr.startIndex
  return expr.childForFieldName('field')?.startIndex ?? expr.startIndex
}

function expandCall(walk: Walk, node: FlowNode, file: JavaFile, call: Node, depth: number): void {
  const identifier = calleeName(call)
  const hit = identifier ? hitAt(walk, file, identifier.startIndex) : null

  if (!hit || hit.viaObject) {
    node.origin = 'external'
    expandOpaqueCall(walk, node, file, call, depth)
    return
  }

  const target = follow({ binding: hit.binding, file: fileOf(walk, hit.definedIn, file) }, walk)

  if (target.binding.reason === 'import') {
    node.origin = 'import'
    expandOpaqueCall(walk, node, file, call, depth)
    return
  }

  // `new Db(...)` builds the object right here.
  if (call.type === 'object_creation_expression') {
    node.origin = 'literal'
    return
  }

  // A record generates an accessor per component, so `id.value()` calls a method that is nowhere
  // written down — the name resolves to the component itself. Reading it is what the call does.
  if (target.binding.reason === 'property' && argumentsIn(call) === 0) {
    expandBinding(walk, node, target, depth)
    return
  }

  if (target.binding.reason !== 'function') {
    node.origin = 'external'
    expandOpaqueCall(walk, node, file, call, depth)
    return
  }

  expandReturns(walk, node, target, depth)
}

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

/** Every value a method returns, not descending into a lambda or a nested type inside it. */
function returnsOf(declaration: Node): Node[] {
  const found: Node[] = []
  const body = declaration.childForFieldName('body')
  if (!body) return found

  if (declaration.type === 'lambda_expression' && body.type !== 'block') return [body]

  const visit = (node: Node) => {
    if (node.type === 'lambda_expression' || node.type === 'class_declaration') return
    if (node.type === 'return_statement') {
      for (const child of node.namedChildren) if (child) found.push(child)
      return
    }
    for (const child of node.namedChildren) if (child) visit(child)
  }
  visit(body)
  return found
}

function expandOpaqueCall(
  walk: Walk,
  node: FlowNode,
  file: JavaFile,
  call: Node,
  depth: number,
): void {
  const parts: Node[] = []
  const receiver = call.childForFieldName('object')
  if (receiver) parts.push(receiver)
  for (const argument of call.childForFieldName('arguments')?.namedChildren ?? []) {
    if (argument) parts.push(argument)
  }

  for (const part of parts) {
    if (isConstant(unwrap(part))) continue
    node.children.push(traceValue(walk, file, part, 'operand', 'flows into the call', depth + 1))
  }
}

function terminateAtBinding(walk: Walk, node: FlowNode, hit: Located, origin: FlowOrigin): void {
  const span = spanOf(hit.binding.declNode)
  if (node.file === hit.file.name && node.span.start === span.start) {
    node.origin = origin
    return
  }
  const child = addNode(
    walk,
    hit.file,
    span,
    'declaration',
    `${hit.binding.reason} \`${hit.binding.name}\``,
  )
  child.origin = origin
  node.children.push(child.id)
}

function expandBinding(walk: Walk, node: FlowNode, hit: Located, depth: number): void {
  const key = keyOf(hit)
  const seen = walk.expanded.get(key)
  if (seen !== undefined) {
    node.origin = 'cycle'
    node.seenAs = seen
    return
  }
  walk.expanded.set(key, node.id)

  const { binding, file } = hit

  if (binding.reason === 'import') {
    terminateAtBinding(walk, node, hit, 'import')
    return
  }
  if (binding.reason === 'parameter') {
    expandParameter(walk, node, hit, depth)
    return
  }
  if (binding.reason === 'function' || binding.reason === 'class') {
    terminateAtBinding(walk, node, hit, 'literal')
    return
  }

  // A record component has no assignment to find: it *is* the canonical constructor's parameter,
  // so its value comes from every `new R(…)` at that position.
  const component = recordComponent(binding)
  if (component) {
    supplyFrom(walk, node, hit, constructionsOf(walk, component.record), component.index, depth)
    return
  }

  const writes = writesFor(walk, hit)
  if (writes.length > 0) {
    for (const [index, write] of writes.entries()) {
      const step: FlowStep = index === 0 ? 'initializer' : 'assignment'
      const label = index === 0 ? 'initialised from' : 'reassigned'
      node.children.push(traceValue(walk, file, write, step, label, depth + 1))
    }
    return
  }

  const source = sourceOfBinder(binding.declNode)
  if (source) {
    node.children.push(traceValue(walk, file, source.expr, source.step, source.label, depth + 1))
    return
  }

  terminateAtBinding(walk, node, hit, 'external')
}

/**
 * Every value written to this name.
 *
 * Java's `x = …` declares nothing, so unlike Python this cannot come from the binder — the
 * declaration's own initializer plus a scan for assignments that resolve back to the same binding.
 */
function writesFor(walk: Walk, hit: Located): Node[] {
  const { binding, file } = hit
  const values: Node[] = []

  // The initializer written on the declaration itself.
  for (const declarator of binding.declNode.namedChildren) {
    if (declarator?.type !== 'variable_declarator') continue
    if (declarator.childForFieldName('name')?.text !== binding.name) continue
    const value = declarator.childForFieldName('value')
    if (value) values.push(value)
  }

  // Assignments anywhere in the scope that holds it.
  const container = containerOf(binding.declNode) ?? file.root
  for (const assignment of nodesOfType(container, 'assignment_expression')) {
    const left = assignment.childForFieldName('left')
    if (!left) continue
    const named =
      left.type === 'identifier'
        ? left
        : left.type === 'field_access'
          ? left.childForFieldName('field')
          : null
    if (named?.text !== binding.name) continue
    const resolved = hitAt(walk, file, named.startIndex)
    if (!resolved || resolved.viaObject) continue
    if (resolved.binding.nameNode.startIndex !== binding.nameNode.startIndex) continue
    const right = assignment.childForFieldName('right')
    if (right) values.push(right)
  }
  return values
}

/** The method or type body a declaration lives in — where its assignments can be. */
function containerOf(declaration: Node): Node | null {
  for (let current: Node | null = declaration; current; current = current.parent) {
    if (
      current.type === 'method_declaration' ||
      current.type === 'constructor_declaration' ||
      current.type === 'class_declaration'
    ) {
      return current
    }
  }
  return null
}

function sourceOfBinder(declaration: Node): { expr: Node; step: FlowStep; label: string } | null {
  if (declaration.type === 'enhanced_for_statement') {
    const value = declaration.childForFieldName('value')
    return value ? { expr: value, step: 'binding', label: 'an element of' } : null
  }
  if (declaration.type === 'resource') {
    const value = declaration.childForFieldName('value')
    return value ? { expr: value, step: 'binding', label: 'entered from' } : null
  }
  return null
}

function expandParameter(walk: Walk, node: FlowNode, hit: Located, depth: number): void {
  const { binding, file } = hit
  const declaration = methodOf(binding.declNode)
  if (!declaration) {
    terminateAtBinding(walk, node, hit, 'external')
    return
  }

  const owner = ownerBinding(walk, declaration, file)
  const sites = owner ? callSitesOf(walk, owner) : []
  const index = parametersOf(declaration).findIndex(
    (parameter) => parameterNameOf(parameter) === binding.name,
  )

  supplyFrom(
    walk,
    node,
    hit,
    sites,
    index,
    depth,
    declaration.type === 'lambda_expression' ? 'callback' : 'entry',
  )
}

/**
 * Hand a declaration the arguments its call sites supply at `index`. Shared by an ordinary
 * parameter and by a record component, which is one in all but spelling.
 */
function supplyFrom(
  walk: Walk,
  node: FlowNode,
  hit: Located,
  sites: readonly CallSite[],
  index: number,
  depth: number,
  empty: FlowOrigin = 'entry',
): void {
  const supplied: { expr: Node; file: JavaFile; callee: string }[] = []
  for (const site of sites) {
    const argument = argumentFor(site, index)
    if (argument) supplied.push({ expr: argument, file: site.file, callee: site.callee })
  }

  if (supplied.length === 0) {
    terminateAtBinding(walk, node, hit, empty)
    return
  }

  // The walk leaves for the call sites from here, so this declaration gets no row of its own.
  const span = spanOf(hit.binding.declNode)
  if (!(node.file === hit.file.name && node.span.start === span.start)) {
    node.via = { span, file: hit.file.name }
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
      ),
    )
  }
}

function ownerBinding(walk: Walk, declaration: Node, file: JavaFile): Located | null {
  const name = declaration.childForFieldName('name')
  if (!name) return null
  const tree = walk.scopes(file)
  for (
    let current: Scope | null = scopeAt(tree, name.startIndex);
    current;
    current = current.parent
  ) {
    const found = current.bindings
      .get(name.text)
      ?.find((candidate) => candidate.declNode.startIndex === declaration.startIndex)
    if (found) return { binding: found, file }
    const member = current.members
      .get(name.text)
      ?.find((candidate) => candidate.declNode.startIndex === declaration.startIndex)
    if (member) return { binding: member, file }
  }
  return null
}

/* ------------------------------------------------------------------ entry point */

export function traceJavaOrigins(
  active: JavaFile,
  files: readonly JavaFile[],
  offset: number,
): FlowTrace | null {
  const built = new Map<string, ScopeTree>()
  const scopes = (file: JavaFile): ScopeTree => {
    const existing = built.get(file.name)
    if (existing) return existing
    const made = buildScopes(file.root)
    built.set(file.name, made)
    return made
  }

  const walk: Walk = { files, scopes, nodes: [], expanded: new Map(), truncated: false }
  const hit = bindingAt(scopes(active), active, offset, { files, scopes })
  if (!hit) return null

  // The root is always in the file on screen: a declaration elsewhere is shown through whatever
  // named it here — an import, an `extends` clause, the receiver's declaration — while the label
  // still names what was asked about, and the expansion below crosses into the other tab.
  const shown = hit.file.name === active.name ? hit.binding.declNode : hit.anchor
  if (!shown) return null
  const root = addNode(
    walk,
    active,
    spanOf(shown),
    null,
    `${hit.binding.reason} \`${hit.binding.name}\``,
  )

  expandBinding(
    walk,
    root,
    follow({ binding: hit.binding, file: fileOf(walk, hit.definedIn, active) }, walk),
    0,
  )

  return {
    nodes: walk.nodes,
    root: root.id,
    externalCount: walk.nodes.filter((node) => isExternalOrigin(node.origin)).length,
    truncated: walk.truncated,
  }
}
