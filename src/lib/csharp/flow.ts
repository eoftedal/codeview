/**
 * Backward provenance for C#.
 *
 * Same walk, same `FlowNode`s, same steps, origins and budgets as lib/flow.ts, python/flow.ts and
 * java/flow.ts, over the C# binder — so the pane and the decorations cannot tell which language
 * answered, and the fixtures are written in the same indented `label: excerpt [origin]` shape.
 *
 * Four things differ from the Java walk, and each of them is a shape C# has and Java does not:
 *
 * - **A property read is not a call.** `id.Value` is a bare member access where Java writes
 *   `id.value()`, so the receiver-following rule that fixes the false-path problem applies to the
 *   access itself rather than only to a zero-argument invocation. It is also *simpler*: an
 *   auto-property has no body, so the property **is** the storage and there is no getter to
 *   recognise.
 * - **An argument is wrapped.** C# puts every argument inside an `argument` node, which may also
 *   carry a `name:` for a named argument — so nothing reads `arguments.namedChildren` directly.
 * - **An interpolated string is not a literal.** `$"… {id.Value} …"` carries its operands inside
 *   it, and that is most of what a taint review is looking at. This is the f-string rule
 *   python/flow.ts already states, in C#'s spelling.
 * - **A constructor may be primary.** `class Svc(IRepo repo)` and every positional record fill
 *   their members from a parameter list written on the type itself, so `constructorIndexFor` has
 *   one more shape to answer for — and an **object initializer**, `new W { Value = v }`, fills one
 *   without passing through a constructor at all.
 *
 * What it cannot do is stated. An **overload** is separated by arity alone. A value flowing *out*
 * through an `out` or `ref` parameter — `int.TryParse(s, out var n)` — is an edge this walk does
 * not have, so `n` reads as an entry point. A **partial class** is seen one half at a time. And a
 * **LINQ or callback** hop is the same unreachable the other three languages declare.
 */
import type { Node } from '@vscode/tree-sitter-wasm'
import type { Span } from '../definitions'
import type { FlowNode, FlowOrigin, FlowStep, FlowTrace } from '../flow'
import { isExternalOrigin } from '../flow'
import {
  argumentsIn,
  bindingAt,
  identifierAt,
  signatureSpan,
  typeScopeFor,
  type CSharpFile,
} from './definitions'
import { aliasedName, moduleFor } from './modules'
import {
  buildScopes,
  declaratorValue,
  declaratorsOf,
  primaryParameters,
  scopeAt,
  type Binding,
  type Scope,
  type ScopeTree,
} from './scopes'

const MAX_NODES = 200
const MAX_DEPTH = 24
const EXCERPT_LIMIT = 72

interface Located {
  binding: Binding
  file: CSharpFile
}

interface Walk {
  files: readonly CSharpFile[]
  scopes: (file: CSharpFile) => ScopeTree
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

function excerptOf(file: CSharpFile, span: Span): string {
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
  file: CSharpFile,
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
  for (let guard = 0; guard < 32; guard++) {
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
    // `o as string` and `o!` pass the value straight through.
    if (current.type === 'as_expression') {
      const left = current.childForFieldName('left')
      if (!left) return current
      current = left
      continue
    }
    if (current.type === 'postfix_unary_expression') {
      const inner = current.namedChildren.find((child): child is Node => child !== null)
      if (!inner) return current
      current = inner
      continue
    }
    // An argument wraps its expression, and a named argument puts the name in front of it.
    if (current.type === 'argument') {
      const name = current.childForFieldName('name')
      const inner = current.namedChildren.find(
        (child): child is Node => child !== null && child.id !== name?.id,
      )
      if (!inner) return current
      current = inner
      continue
    }
    return current
  }
  return current
}

const CONSTANTS = new Set([
  'string_literal',
  'verbatim_string_literal',
  'raw_string_literal',
  'character_literal',
  'integer_literal',
  'real_literal',
  'boolean_literal',
  'null_literal',
])

/**
 * A literal, and deliberately **not** an interpolated string: `$"…{id}…"` carries values inside it,
 * and calling it a constant is how a trace loses the value at the exact point a query is built.
 */
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
    case 'conditional_expression':
      return [node.childForFieldName('consequence'), node.childForFieldName('alternative')].filter(
        (child): child is Node => child !== null,
      )
    case 'prefix_unary_expression':
      return named
    case 'interpolated_string_expression':
      // Every `{…}` hole, and nothing else — the literal text between them says nothing. An
      // interpolation carries no field for its expression; its braces are named nodes of their
      // own, so the expression is the child that is not one.
      return named
        .filter((child) => child.type === 'interpolation')
        .map(
          (child) =>
            child.namedChildren.find(
              (inner): inner is Node => inner !== null && inner.type !== 'interpolation_brace',
            ) ?? child,
        )
    case 'initializer_expression':
    case 'implicit_array_creation_expression':
    case 'array_creation_expression':
    case 'tuple_expression':
    case 'switch_expression':
      return named
    default:
      return []
  }
}

/* ------------------------------------------------------------------ resolution */

/** Follow a `using` alias to the declaration it names, so the same type compares equal across
 *  tabs. */
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

  const wanted = aliasedName(hit.binding.declNode) ?? hit.binding.name
  const bindings = walk.scopes(target).root.bindings.get(wanted)
  if (!bindings || bindings.length === 0) return hit
  return follow({ binding: bindings[bindings.length - 1]!, file: target }, walk, seen)
}

function fileOf(walk: Walk, definedIn: string | undefined, fallback: CSharpFile): CSharpFile {
  if (!definedIn) return fallback
  return walk.files.find((candidate) => candidate.name === definedIn) ?? fallback
}

function hitAt(walk: Walk, file: CSharpFile, offset: number) {
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
  file: CSharpFile
  callee: string
  /** How many leading parameters the call site does not write. Always 0 in C# — a receiver is not
   *  a parameter the way Python's `self` is — but kept so the shape matches. */
  shift: number
}

/** The identifier a call names, through the member access that may sit in front of it. */
function calleeName(call: Node): Node | null {
  if (call.type === 'invocation_expression') {
    const callee = call.childForFieldName('function')
    if (!callee) return null
    if (callee.type === 'identifier') return callee
    if (callee.type === 'member_access_expression') return callee.childForFieldName('name')
    if (callee.type === 'generic_name') {
      return callee.namedChildren.find((child) => child?.type === 'identifier') ?? null
    }
    return null
  }
  if (call.type === 'object_creation_expression') {
    const type = call.childForFieldName('type')
    if (type?.type === 'identifier') return type
    if (type?.type === 'generic_name') {
      return type.namedChildren.find((child) => child?.type === 'identifier') ?? null
    }
    return null
  }
  return null
}

/** The receiver a call is made on, or null for a bare call. */
function receiverOf(call: Node): Node | null {
  const callee = call.childForFieldName('function')
  if (callee?.type !== 'member_access_expression') return null
  return callee.childForFieldName('expression')
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
  // A constructor is called by writing the type's name, which is also its own.
  const isCtor = isConstructor(target)

  for (const file of walk.files) {
    for (const type of ['invocation_expression', 'object_creation_expression']) {
      for (const call of nodesOfType(file.root, type)) {
        const identifier = calleeName(call)
        if (!identifier || identifier.text !== name) continue

        if (type === 'object_creation_expression') {
          if (isCtor) sites.push({ call, file, callee: name, shift: 0 })
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

/**
 * The field a method or accessor just hands back — `string GetValue() { return _value; }`, and its
 * expression-bodied spelling `=> _value`. Recognising it turns the call into a read of that field
 * on the receiver, which is what keeps the walk on this object rather than on the type.
 *
 * An auto-property needs none of this: it *is* the storage, which is why it never reaches here.
 */
function accessorField(declaration: Node): string | null {
  const body = declaration.childForFieldName('body')
  if (!body) return null

  if (body.type === 'arrow_expression_clause') {
    const value = body.namedChildren.find((child): child is Node => child !== null)
    return value ? readName(value) : null
  }
  if (body.type !== 'block') return null
  const statements = body.namedChildren.filter((child): child is Node => child !== null)
  if (statements.length !== 1 || statements[0]!.type !== 'return_statement') return null
  const value = statements[0]!.namedChildren.find((child): child is Node => child !== null)
  return value ? readName(value) : null
}

/** The member name an expression reads: `_value`, or `this._value`. */
function readName(value: Node): string | null {
  if (value.type === 'identifier') return value.text
  if (value.type === 'member_access_expression') {
    const receiver = value.childForFieldName('expression')
    if (receiver?.type === 'this') return value.childForFieldName('name')?.text ?? null
  }
  return null
}

/**
 * Which argument of `new T(…)` ends up in member `name`.
 *
 * C# says so in four ways, and all four are common. A **positional record** and a **primary
 * constructor** say it by position: the parameter list written on the type itself *is* where the
 * member comes from. An **ordinary constructor** says it in its body, `this.X = p` — in a block or
 * behind an `=>`. And where none of them answers, a parameter of the same name is how a constructor
 * is written when it is not written by hand at all.
 */
function constructorIndexFor(
  walk: Walk,
  call: Node,
  file: CSharpFile,
  name: string,
): number | null {
  const typeName = calleeName(call)?.text
  if (!typeName) return null
  const found = typeScopeFor(typeName, file, walk.files, walk.scopes)
  if (!found) return null
  const declaration = found.scope.node

  // A positional record or a primary constructor: by position, on the type's own parameter list.
  const positional = primaryParameters(declaration)
  if (positional.length > 0) {
    const index = positional.findIndex(
      (parameter) => parameter.childForFieldName('name')?.text === name,
    )
    if (index >= 0) return index
  }

  for (const constructor of nodesOfType(declaration, 'constructor_declaration')) {
    const parameters = parametersOf(constructor)
    for (const assignment of nodesOfType(constructor, 'assignment_expression')) {
      const left = assignment.childForFieldName('left')
      const field =
        left?.type === 'member_access_expression' &&
        left.childForFieldName('expression')?.type === 'this'
          ? left.childForFieldName('name')
          : left?.type === 'identifier'
            ? left
            : null
      if (field?.text !== name) continue
      const right = assignment.childForFieldName('right')
      if (right?.type !== 'identifier') continue
      const index = parameters.findIndex((parameter) => parameterNameOf(parameter) === right.text)
      if (index >= 0) return index
    }
    const byName = parameters.findIndex((parameter) => parameterNameOf(parameter) === name)
    if (byName >= 0) return byName
  }
  return null
}

/**
 * The value an object initializer puts in a member — `new Wrapper { Value = v }`.
 *
 * C#'s own way of filling a property without a constructor, and the walk has to read it or the
 * value disappears between the assignment and the read.
 */
function initializerValueFor(call: Node, name: string): Node | null {
  const initializer = call.childForFieldName('initializer')
  if (initializer?.type !== 'initializer_expression') return null
  for (const entry of initializer.namedChildren) {
    if (entry?.type !== 'assignment_expression') continue
    if (entry.childForFieldName('left')?.text !== name) continue
    return entry.childForFieldName('right')
  }
  return null
}

/**
 * The constructor a construction actually runs, where the type declares one.
 *
 * It earns a row of its own because of what lives in it: a constructor is where a value is
 * validated, normalised or rejected, and a trace that steps over it reads as though the value
 * arrived untouched — the difference between a finding and a sanitiser. A type that declares no
 * constructor has nothing to show and gets no row, which is the common case for a positional
 * record.
 *
 * Which one, when there are several, is the same syntactic guess `lookupCall` makes for an
 * overload: arity, then the first declared.
 */
function constructorSite(target: Located, call: Node): Node | null {
  const declaration = target.binding.declNode
  const body = declaration.childForFieldName('body') ?? declaration
  // Only this type's own constructors: a nested type declares its own, and they are not these.
  const declared = (body.namedChildren ?? []).filter(
    (child): child is Node => child !== null && child.type === 'constructor_declaration',
  )
  if (declared.length === 0) return null

  const arity = argumentsIn(call)
  const fits = declared.find((constructor) => parametersOf(constructor).length === arity)
  if (fits) return fits

  // Nothing declared takes this many arguments, but the type's **primary** constructor might —
  // and a primary constructor has no body of its own to show, so the honest answer is no row
  // rather than the first declared one. Without this, `new ProductId(id)` on a record that also
  // declares a two-argument constructor is reported as passing through that constructor, which it
  // never runs.
  if (primaryParameters(declaration).length === arity) return null
  return declared[0]!
}

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
  if (node.type === 'identifier' || node.type === 'implicit_parameter') return node.text
  return node.childForFieldName('name')?.text ?? null
}

/** The expression a call supplies at `index`, through the `argument` node that wraps it. */
function argumentFor(site: CallSite, parameterIndex: number): Node | null {
  const list = site.call.childForFieldName('arguments')
  if (!list) return null
  const args = list.namedChildren.filter((child): child is Node => child !== null)
  const found = args[parameterIndex - site.shift]
  return found ? unwrap(found) : null
}

/** Every argument a call supplies, unwrapped, in order. */
function argumentsOf(call: Node): Node[] {
  const list = call.childForFieldName('arguments')
  return (list?.namedChildren ?? [])
    .filter((child): child is Node => child !== null)
    .map((child) => unwrap(child))
}

function methodOf(parameter: Node): Node | null {
  for (let current: Node | null = parameter; current; current = current.parent) {
    if (
      current.type === 'method_declaration' ||
      current.type === 'constructor_declaration' ||
      current.type === 'local_function_statement' ||
      current.type === 'lambda_expression'
    ) {
      return current
    }
    // A primary constructor's parameters belong to the type declaration itself.
    if (
      (current.type === 'record_declaration' ||
        current.type === 'record_struct_declaration' ||
        current.type === 'class_declaration' ||
        current.type === 'struct_declaration') &&
      primaryParameters(current).some((candidate) => candidate.id === parameter.id)
    ) {
      return current
    }
  }
  return null
}

/* ------------------------------------------------------------------ the walk */

/**
 * The member a branch is still looking for.
 *
 * Reading `id.Value` asks about one member of **this** object. Expanding the member on its own
 * instead reaches every construction of the type — including ones the value never came from, which
 * is a path that *cannot happen* rather than merely a noisy one. So the member's name rides the
 * receiver's own chain and is consumed by the construction that actually made it.
 */
type Seeking = string | undefined

function traceValue(
  walk: Walk,
  file: CSharpFile,
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
  file: CSharpFile,
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

  if (expr.type === 'invocation_expression' || expr.type === 'object_creation_expression') {
    expandCall(walk, node, file, expr, depth, seeking)
    return
  }

  if (expr.type === 'element_access_expression') {
    const array = expr.childForFieldName('expression')
    if (array) {
      node.children.push(traceValue(walk, file, array, 'property', 'element of', depth + 1))
      return
    }
  }

  // `o?.Name` — the same read, written defensively.
  if (expr.type === 'conditional_access_expression') {
    const receiver = expr.childForFieldName('condition')
    const binding = expr.namedChildren.find((child) => child?.type === 'member_binding_expression')
    const name = binding?.childForFieldName('name')
    if (receiver && name) {
      node.children.push(
        traceValue(
          walk,
          file,
          receiver,
          'property',
          `\`.${name.text}\` read from`,
          depth + 1,
          name.text,
        ),
      )
      return
    }
  }

  if (expr.type === 'member_access_expression') {
    expandMemberRead(walk, node, file, expr, depth)
    return
  }

  if (expr.type === 'identifier') {
    const hit = hitAt(walk, file, expr.startIndex)
    if (!hit) {
      node.origin = 'external'
      return
    }
    expandBinding(
      walk,
      node,
      follow({ binding: hit.binding, file: fileOf(walk, hit.definedIn, file) }, walk),
      depth,
      seeking,
    )
    return
  }

  if (expr.type === 'lambda_expression' || expr.type === 'anonymous_method_expression') {
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

/**
 * Reading a member follows the **receiver**, and that is a correctness rule rather than a tuning
 * one — see the `Seeking` note above. `this.X` and `base.X` are the exception: there is no receiver
 * to follow, the object is the one being written, so the member itself is expanded.
 */
function expandMemberRead(
  walk: Walk,
  node: FlowNode,
  file: CSharpFile,
  expr: Node,
  depth: number,
): void {
  const receiver = expr.childForFieldName('expression')
  const name = expr.childForFieldName('name')

  if (receiver && name && receiver.type !== 'this' && receiver.type !== 'base') {
    node.children.push(
      traceValue(
        walk,
        file,
        receiver,
        'property',
        `\`.${name.text}\` read from`,
        depth + 1,
        name.text,
      ),
    )
    return
  }

  const hit = name ? hitAt(walk, file, name.startIndex) : null
  if (!hit) {
    node.origin = 'external'
    return
  }
  expandBinding(
    walk,
    node,
    follow({ binding: hit.binding, file: fileOf(walk, hit.definedIn, file) }, walk),
    depth,
  )
}

function expandCall(
  walk: Walk,
  node: FlowNode,
  file: CSharpFile,
  call: Node,
  depth: number,
  seeking?: Seeking,
): void {
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

  // `new Db(…)` builds the object right here — unless this branch is still looking for one of its
  // members, in which case the object is a wrapper and the value went in through this call.
  if (call.type === 'object_creation_expression') {
    expandConstruction(walk, node, file, call, target, depth, seeking)
    return
  }

  const receiver = receiverOf(call)

  // A hand-written getter — `string GetValue() { return _value; }` or `=> _value` — is a read of
  // that member spelled as a call. The value belongs to *this* object, so follow the receiver and
  // carry the member's name rather than expanding the member and reaching every construction.
  const read =
    target.binding.reason === 'function' && argumentsIn(call) === 0
      ? accessorField(target.binding.declNode)
      : null

  if (read && receiver) {
    node.children.push(
      traceValue(walk, file, receiver, 'property', `\`.${read}\` read from`, depth + 1, read),
    )
    return
  }

  if (target.binding.reason !== 'function') {
    node.origin = 'external'
    expandOpaqueCall(walk, node, file, call, depth)
    return
  }

  expandReturns(walk, node, target, depth)
}

function expandConstruction(
  walk: Walk,
  node: FlowNode,
  file: CSharpFile,
  call: Node,
  target: Located,
  depth: number,
  seeking?: Seeking,
): void {
  const name = calleeName(call)?.text ?? 'it'
  // The tab the type is declared in, whether or not anything below lands a row there — see
  // `FlowNode.definedIn`.
  if (target.file.name !== node.file) node.definedIn = target.file.name

  // Which arguments the object was made of. Seeking one member answers precisely — that member is
  // filled by one argument, and the others are somebody else's value. With nothing sought, or
  // nothing that answers it, everything fed in is kept: a wrapper is its contents, and the object
  // being *made* here says nothing about where what is inside it came from.
  let precise = false
  const args: Node[] = []
  if (seeking) {
    // An object initializer fills a member without a constructor, so it is asked first.
    const initialised = initializerValueFor(call, seeking)
    if (initialised) {
      args.push(initialised)
      precise = true
    } else {
      const index = constructorIndexFor(walk, call, file, seeking)
      const argument =
        index === null ? null : argumentFor({ call, file, callee: '', shift: 0 }, index)
      if (argument) {
        args.push(argument)
        precise = true
      }
    }
  }
  if (!precise) {
    for (const argument of argumentsOf(call)) {
      if (!isConstant(argument)) args.push(argument)
    }
    // An object initializer's values are fed in just as arguments are.
    const initializer = call.childForFieldName('initializer')
    for (const entry of initializer?.namedChildren ?? []) {
      if (entry?.type !== 'assignment_expression') continue
      const right = entry.childForFieldName('right')
      if (right && !isConstant(unwrap(right))) args.push(right)
    }
  }

  // Nothing went in that is worth following: the object really is made right here.
  if (args.length === 0) {
    node.origin = 'literal'
    return
  }

  // The constructor the value passes through, where the type declares one. The arguments hang
  // under it, so the path reads the way it runs.
  const constructor = constructorSite(target, call)
  const host = constructor
    ? addNode(
        walk,
        target.file,
        signatureSpan(constructor, target.file.text),
        'declaration',
        `constructed by \`${name}\``,
      )
    : node
  if (constructor) node.children.push(host.id)

  for (const argument of args) {
    host.children.push(
      traceValue(
        walk,
        file,
        argument,
        'argument',
        `passed to \`${name}\``,
        depth + 1,
        precise ? undefined : seeking,
      ),
    )
  }
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

/** Every value a method returns, not descending into a lambda or a nested type inside it. An
 *  expression body — `=> _repo.Load(id)` — is a return with no statement around it. */
function returnsOf(declaration: Node): Node[] {
  const found: Node[] = []
  const body = declaration.childForFieldName('body')
  if (!body) return found

  if (body.type === 'arrow_expression_clause') {
    const value = body.namedChildren.find((child): child is Node => child !== null)
    return value ? [value] : []
  }
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
  file: CSharpFile,
  call: Node,
  depth: number,
): void {
  const parts: Node[] = []
  const receiver = receiverOf(call)
  if (receiver) parts.push(receiver)
  parts.push(...argumentsOf(call))

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

  if (binding.reason === 'import') {
    terminateAtBinding(walk, node, hit, 'import')
    return
  }
  if (binding.reason === 'parameter') {
    expandParameter(walk, node, hit, depth, seeking)
    return
  }
  // A positional record's component is a parameter in all but spelling: it has no assignment to
  // walk to, and its value comes from the construction's argument list.
  if (binding.reason === 'property' && binding.declNode.type === 'parameter') {
    expandParameter(walk, node, hit, depth, seeking)
    return
  }
  if (binding.reason === 'function' || binding.reason === 'class') {
    terminateAtBinding(walk, node, hit, 'literal')
    return
  }

  const writes = writesFor(walk, hit)
  if (writes.length > 0) {
    for (const [index, write] of writes.entries()) {
      const step: FlowStep = index === 0 ? 'initializer' : 'assignment'
      const label = index === 0 ? 'initialised from' : 'reassigned'
      node.children.push(traceValue(walk, file, write, step, label, depth + 1, seeking))
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
 * C#'s `x = …` declares nothing, so unlike Python this cannot come from the binder — the
 * declaration's own initializer plus a scan for assignments that resolve back to the same binding.
 * A property's expression body (`=> _value`) counts as a write of the property, which is what makes
 * a computed property traceable at all.
 */
function writesFor(walk: Walk, hit: Located): Node[] {
  const { binding, file } = hit
  const values: Node[] = []

  for (const declarator of declaratorsOf(binding.declNode)) {
    if (declarator.childForFieldName('name')?.text !== binding.name) continue
    const value = declaratorValue(declarator)
    if (value) values.push(value)
  }

  // A property with an expression body or an expression-bodied getter hands back one value.
  if (binding.declNode.type === 'property_declaration') {
    const body = binding.declNode.childForFieldName('value')
    const inner = body?.namedChildren.find((child): child is Node => child !== null)
    if (inner) values.push(inner)
    for (const accessor of binding.declNode.childForFieldName('accessors')?.namedChildren ?? []) {
      if (accessor?.type !== 'accessor_declaration') continue
      for (const value of returnsOf(accessor)) values.push(value)
    }
  }

  const container = containerOf(binding.declNode) ?? file.root
  for (const assignment of nodesOfType(container, 'assignment_expression')) {
    const left = assignment.childForFieldName('left')
    if (!left) continue
    const named =
      left.type === 'identifier'
        ? left
        : left.type === 'member_access_expression'
          ? left.childForFieldName('name')
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

/** The member or type body a declaration lives in — where its assignments can be. */
function containerOf(declaration: Node): Node | null {
  for (let current: Node | null = declaration; current; current = current.parent) {
    if (
      current.type === 'method_declaration' ||
      current.type === 'constructor_declaration' ||
      current.type === 'local_function_statement' ||
      current.type === 'class_declaration' ||
      current.type === 'struct_declaration' ||
      current.type === 'record_declaration'
    ) {
      return current
    }
  }
  return null
}

function sourceOfBinder(declaration: Node): { expr: Node; step: FlowStep; label: string } | null {
  if (declaration.type === 'foreach_statement') {
    const value = declaration.childForFieldName('right')
    return value ? { expr: value, step: 'binding', label: 'an element of' } : null
  }
  if (declaration.type === 'declaration_pattern') {
    const parent = declaration.parent
    const value = parent?.childForFieldName('expression')
    return value ? { expr: value, step: 'binding', label: 'matched from' } : null
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
  const declaration = methodOf(binding.declNode)
  if (!declaration) {
    terminateAtBinding(walk, node, hit, 'external')
    return
  }

  // A primary constructor's parameter list belongs to the type, and its call sites are the
  // constructions of that type.
  const primary = primaryParameters(declaration)
  const isPrimary = primary.some((candidate) => candidate.id === binding.declNode.id)

  const owner = isPrimary
    ? typeBinding(walk, declaration, file)
    : ownerBinding(walk, declaration, file)
  const sites = owner ? constructionsOrCalls(walk, owner, isPrimary) : []
  const index = (isPrimary ? primary : parametersOf(declaration)).findIndex(
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
    seeking,
  )
}

/** Where a declaration's arguments come from: every construction of the type for a primary
 *  constructor, every call for an ordinary method. */
function constructionsOrCalls(walk: Walk, owner: Located, isPrimary: boolean): CallSite[] {
  if (!isPrimary) return callSitesOf(walk, owner)
  const name = owner.binding.name
  const sites: CallSite[] = []
  for (const file of walk.files) {
    for (const call of nodesOfType(file.root, 'object_creation_expression')) {
      if (calleeName(call)?.text !== name) continue
      sites.push({ call, file, callee: name, shift: 0 })
    }
  }
  return sites
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
  seeking?: Seeking,
): void {
  const supplied: { expr: Node; file: CSharpFile; callee: string }[] = []
  for (const site of sites) {
    const argument = index < 0 ? null : argumentFor(site, index)
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
        seeking,
      ),
    )
  }
}

function ownerBinding(walk: Walk, declaration: Node, file: CSharpFile): Located | null {
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

/** The binding for a type declaration itself — how a primary constructor finds its constructions. */
function typeBinding(walk: Walk, declaration: Node, file: CSharpFile): Located | null {
  const name = declaration.childForFieldName('name')
  if (!name) return null
  const found = walk
    .scopes(file)
    .root.bindings.get(name.text)
    ?.find((candidate) => candidate.declNode.startIndex === declaration.startIndex)
  return found ? { binding: found, file } : null
}

/* ------------------------------------------------------------------ entry point */

export function traceCSharpOrigins(
  active: CSharpFile,
  files: readonly CSharpFile[],
  offset: number,
): FlowTrace | null {
  const built = new Map<string, ScopeTree>()
  const scopes = (file: CSharpFile): ScopeTree => {
    const existing = built.get(file.name)
    if (existing) return existing
    const made = buildScopes(file.root)
    built.set(file.name, made)
    return made
  }

  const walk: Walk = { files, scopes, nodes: [], expanded: new Map(), truncated: false }
  const hit = bindingAt(scopes(active), active, offset, { files, scopes })
  if (!hit) return null

  // Tracing *at* `id.Value` asks where that value came from, not where the member is declared — and
  // expanding the declaration would reach every object of the type rather than this one. Root on
  // the expression and let the receiver rule below follow it. The same trap traceJavaOrigins and
  // tracePythonOrigins document.
  const identifier = identifierAt(active.root, offset)
  const access = identifier?.parent
  const isMemberRead =
    !!access &&
    access.type === 'member_access_expression' &&
    access.childForFieldName('name')?.id === identifier.id &&
    access.childForFieldName('expression') !== null

  if (isMemberRead && access) {
    // An invocation around the access is what the value actually is — `repo.Load(id)`, not `Load`.
    const call =
      access.parent?.type === 'invocation_expression' &&
      access.parent.childForFieldName('function')?.id === access.id
        ? access.parent
        : access
    const root = addNode(
      walk,
      active,
      spanOf(call),
      null,
      `${hit.binding.reason} \`${hit.binding.name}\``,
    )
    expand(walk, root, active, call, 0)
    return {
      nodes: walk.nodes,
      root: root.id,
      externalCount: walk.nodes.filter((node) => isExternalOrigin(node.origin)).length,
      truncated: walk.truncated,
    }
  }

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
