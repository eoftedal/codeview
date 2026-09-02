import ts from 'typescript'
import { findTsNodeAtOffset } from './analyzer'
import { declarationAt, describeDeclaration, resolveDefinition, type Span } from './definitions'

/**
 * Backward provenance: given a value, where could it have come from?
 *
 * This is a *may*-analysis. It walks every path that could reach the value — both sides of a
 * ternary, every call site of a function, every assignment to a `let` — with no path sensitivity
 * and no alias analysis. It over-approximates, and where it cannot follow a value it says so
 * (`external`) rather than pretending the chain ended.
 *
 * The `noLib`/`noResolve` analyzer (see lib/analyzer.ts) makes the terminal condition principled
 * rather than heuristic: nothing outside the buffer resolves, so a name with no definition *is* an
 * external one. No hardcoded list of interesting globals is needed.
 */

/** The edge that led to a node — why it is in the trace. */
export type FlowStep =
  | 'initializer'
  | 'return'
  | 'argument'
  | 'property'
  | 'binding'
  | 'operand'
  | 'assignment'
  | 'declaration'

/**
 * How a branch of the walk ended.
 *
 * `literal` means the value originates inside this buffer — a constant, a function, a freshly
 * constructed object. The others all mean it entered from somewhere we cannot see.
 */
export type FlowOrigin =
  'literal' | 'import' | 'external' | 'entry' | 'callback' | 'cycle' | 'budget'

export interface FlowNode {
  id: number
  span: Span
  /** 1-based, matching the definition header's "line N". */
  line: number
  /** The edge that reached this node; null on the root. */
  step: FlowStep | null
  label: string
  /** The source at `span`, whitespace-collapsed and truncated, for the trace list. */
  excerpt: string
  /**
   * Set where this branch ends. A node may carry *both* an origin and children: an unresolvable
   * call originates outside the buffer, yet what was fed into it is still worth showing.
   */
  origin?: FlowOrigin
  children: number[]
  /** For a `cycle` terminal: the id of the node that already expanded this declaration. */
  seenAs?: number
}

export interface FlowTrace {
  nodes: FlowNode[]
  root: number
  /** Terminals that came from outside the buffer — imports, globals, uncalled parameters. */
  externalCount: number
  /** True when the walk hit its node or depth budget rather than finishing. */
  truncated: boolean
}

const MAX_NODES = 200
const MAX_DEPTH = 24
const EXCERPT_LIMIT = 72

const EXTERNAL_ORIGINS: ReadonlySet<FlowOrigin> = new Set<FlowOrigin>([
  'import',
  'external',
  'entry',
  'callback',
])

export function isExternalOrigin(origin: FlowOrigin | undefined): boolean {
  return origin !== undefined && EXTERNAL_ORIGINS.has(origin)
}

/** A trace step reduced to what the editor needs to decorate it. */
export interface FlowSpan {
  span: Span
  external: boolean
}

interface Walk {
  service: ts.LanguageService
  sf: ts.SourceFile
  fileName: string
  nodes: FlowNode[]
  /** Declaration start offset → the node that expanded it, so cycles and diamonds terminate. */
  expanded: Map<number, number>
  truncated: boolean
}

/* ------------------------------------------------------------------ small helpers */

function spanOf(node: ts.Node, sf: ts.SourceFile): Span {
  return { start: node.getStart(sf), end: node.getEnd() }
}

function excerptOf(sf: ts.SourceFile, span: Span): string {
  const text = sf.text.slice(span.start, span.end).replace(/\s+/g, ' ').trim()
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text
}

function addNode(walk: Walk, span: Span, step: FlowStep | null, label: string): FlowNode {
  const node: FlowNode = {
    id: walk.nodes.length,
    span,
    line: walk.sf.getLineAndCharacterOfPosition(span.start).line + 1,
    step,
    label,
    excerpt: excerptOf(walk.sf, span),
    children: [],
  }
  walk.nodes.push(node)
  return node
}

/** Strip the wrappers that pass a value through unchanged. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression
      continue
    }
    return current
  }
}

function isConstant(expr: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(expr) ||
    ts.isNumericLiteral(expr) ||
    ts.isBigIntLiteral(expr) ||
    ts.isRegularExpressionLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr) && expr.text === 'undefined')
  )
}

function isImportPart(node: ts.Node): boolean {
  return (
    ts.isImportSpecifier(node) ||
    ts.isImportClause(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportDeclaration(node) ||
    ts.isImportEqualsDeclaration(node)
  )
}

/** Sub-expressions that each contribute part of a composite value. */
function operandsOf(expr: ts.Expression): ts.Expression[] {
  if (ts.isBinaryExpression(expr)) return [expr.left, expr.right]
  if (ts.isConditionalExpression(expr)) return [expr.whenTrue, expr.whenFalse]
  if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) return [expr.operand]
  if (ts.isTemplateExpression(expr)) return expr.templateSpans.map((span) => span.expression)
  if (ts.isArrayLiteralExpression(expr)) return [...expr.elements]
  if (ts.isSpreadElement(expr)) return [expr.expression]
  if (ts.isObjectLiteralExpression(expr)) {
    const out: ts.Expression[] = []
    for (const property of expr.properties) {
      if (ts.isPropertyAssignment(property)) out.push(property.initializer)
      else if (ts.isShorthandPropertyAssignment(property)) out.push(property.name)
      else if (ts.isSpreadAssignment(property)) out.push(property.expression)
    }
    return out
  }
  return []
}

/** Where to ask TypeScript about an expression: a property access resolves through its name. */
function lookupPosition(expr: ts.Expression, sf: ts.SourceFile): number {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.getStart(sf)
  return expr.getStart(sf)
}

/**
 * The name whose references are this function's call sites.
 *
 * Null means there is nothing to search for — an inline callback has no name, so its parameters are
 * filled in by whatever invokes it, which is not in this buffer.
 */
function calleeName(fn: ts.Node): ts.Identifier | null {
  if (ts.isConstructorDeclaration(fn)) {
    const cls = fn.parent
    return ts.isClassLike(cls) && cls.name && ts.isIdentifier(cls.name) ? cls.name : null
  }

  const own = (fn as { name?: ts.Node }).name
  if (own && ts.isIdentifier(own)) return own

  // An arrow or function expression borrows the name it was assigned to.
  const parent = fn.parent
  if (!parent) return null
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.initializer === fn &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name
  }
  return null
}

/** The call a reference to a callee name belongs to, if it is one. */
function callAt(sf: ts.SourceFile, position: number): ts.CallExpression | ts.NewExpression | null {
  const node = findTsNodeAtOffset(sf, position)
  const parent = node.parent
  if (!parent) return null

  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) {
    return parent
  }
  // `obj.m(x)` — the reference is the property name, so the call is one level further out.
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const grand = parent.parent
    if (
      grand &&
      (ts.isCallExpression(grand) || ts.isNewExpression(grand)) &&
      grand.expression === parent
    ) {
      return grand
    }
  }
  return null
}

function functionOf(decl: ts.Node): ts.SignatureDeclaration | null {
  if (ts.isFunctionLike(decl)) return decl
  if (
    (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) &&
    decl.initializer &&
    ts.isFunctionLike(decl.initializer)
  ) {
    return decl.initializer
  }
  return null
}

/** Return expressions belonging to `fn` itself — not to any function nested inside it. */
function returnsOf(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = (fn as ts.FunctionLikeDeclaration).body
  if (!body) return []
  if (!ts.isBlock(body)) return [body]

  const out: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node)) {
      if (node.expression) out.push(node.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return out
}

/** Later assignments to a `let`/`var`. A `const` can only ever be its initializer. */
function writesFor(walk: Walk, decl: ts.VariableDeclaration): ts.Expression[] {
  const list = decl.parent
  if (!ts.isVariableDeclarationList(list)) return []
  if (list.flags & ts.NodeFlags.Const) return []
  if (!ts.isIdentifier(decl.name)) return []

  const declared = decl.name.getStart(walk.sf)
  const refs = walk.service.getReferencesAtPosition(walk.fileName, declared) ?? []
  const out: ts.Expression[] = []
  for (const ref of refs) {
    if (ref.fileName !== walk.fileName || !ref.isWriteAccess) continue
    if (ref.textSpan.start === declared) continue // the declaration itself

    const node = findTsNodeAtOffset(walk.sf, ref.textSpan.start)
    const parent = node.parent
    if (
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      out.push(parent.right)
    }
  }
  return out
}

interface ArgumentSource {
  expr: ts.Expression
  callee: string
}

/**
 * The backward interprocedural edge: what gets passed to this parameter.
 *
 * Finds the enclosing function's call sites through its name's references, then takes the argument
 * at the parameter's index. A call site that omits the argument falls back to the parameter's own
 * default, which is how `connect()` reaches `settings = config`.
 */
function argumentsFor(walk: Walk, param: ts.ParameterDeclaration): ArgumentSource[] {
  const fn = param.parent
  const index = fn.parameters.indexOf(param)
  const name = calleeName(fn)
  if (!name || index < 0) return []

  const refs = walk.service.getReferencesAtPosition(walk.fileName, name.getStart(walk.sf)) ?? []
  const sources: ArgumentSource[] = []
  const seen = new Set<number>()

  const take = (expr: ts.Expression): void => {
    const start = expr.getStart(walk.sf)
    // The default initializer is one node however many call sites omit the argument.
    if (seen.has(start)) return
    seen.add(start)
    sources.push({ expr, callee: name.text })
  }

  for (const ref of refs) {
    if (ref.fileName !== walk.fileName) continue
    const call = callAt(walk.sf, ref.textSpan.start)
    if (!call) continue

    const args = call.arguments ?? ([] as unknown as ts.NodeArray<ts.Expression>)
    if (param.dotDotDotToken) {
      for (const arg of Array.from(args).slice(index)) take(arg)
      continue
    }
    const arg = args[index] ?? param.initializer
    if (arg) take(arg)
  }
  return sources
}

/** Narrow a destructured source to the one property the binding element pulls out. */
function narrowToProperty(expr: ts.Expression, element: ts.BindingElement): ts.Expression {
  const target = unwrap(expr)
  if (!ts.isObjectLiteralExpression(target)) return expr

  const wanted = element.propertyName ?? element.name
  if (!ts.isIdentifier(wanted) && !ts.isStringLiteral(wanted)) return expr
  const key = wanted.text

  for (const property of target.properties) {
    const name = property.name
    if (!name || (!ts.isIdentifier(name) && !ts.isStringLiteral(name))) continue
    if (name.text !== key) continue
    if (ts.isPropertyAssignment(property)) return property.initializer
    if (ts.isShorthandPropertyAssignment(property)) return property.name
  }
  return expr
}

/* ------------------------------------------------------------------ the walk */

function traceValue(
  walk: Walk,
  expr: ts.Expression,
  step: FlowStep,
  label: string,
  depth: number,
): number {
  const node = addNode(walk, spanOf(expr, walk.sf), step, label)
  expand(walk, node, expr, depth)
  return node.id
}

function expand(walk: Walk, node: FlowNode, expression: ts.Expression, depth: number): void {
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

  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
    expandCall(walk, node, expr, depth)
    return
  }

  if (ts.isElementAccessExpression(expr)) {
    // No index-level provenance — fall back to where the container came from.
    node.children.push(traceValue(walk, expr.expression, 'property', 'element of', depth + 1))
    return
  }

  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
    const hit = declarationAt(walk.service, walk.sf, walk.fileName, lookupPosition(expr, walk.sf))
    if (!hit) {
      node.origin = 'external'
      return
    }

    // The property had no declaration of its own, so what came back describes the object, not this
    // expression — `req` rather than `req.params.id`. That is a real hop: give it its own node
    // instead of collapsing, or the chain appears to dead-end at the property access.
    if (hit.viaObject && ts.isPropertyAccessExpression(expr)) {
      node.children.push(
        traceValue(
          walk,
          expr.expression,
          'property',
          `\`.${expr.name.text}\` read from`,
          depth + 1,
        ),
      )
      return
    }

    expandDeclaration(walk, node, hit.declaration, hit.name, depth)
    return
  }

  // A function or class written right here — the value originates in this buffer.
  if (ts.isFunctionLike(expr) || ts.isClassLike(expr)) {
    node.origin = 'literal'
    return
  }

  const operands = operandsOf(expr)
  if (operands.length > 0) {
    for (const operand of operands) {
      node.children.push(traceValue(walk, operand, 'operand', 'contributes', depth + 1))
    }
    return
  }

  node.origin = 'external'
}

function expandCall(
  walk: Walk,
  node: FlowNode,
  call: ts.CallExpression | ts.NewExpression,
  depth: number,
): void {
  const target = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression
  const hit = ts.isIdentifier(target)
    ? declarationAt(walk.service, walk.sf, walk.fileName, target.getStart(walk.sf))
    : null

  if (!hit || isImportPart(hit.declaration)) {
    // The implementation is not in this buffer, so the result originates outside it — but what was
    // fed in still matters, so keep walking the receiver and the arguments underneath.
    node.origin = hit ? 'import' : 'external'
    expandOpaqueCall(walk, node, call, depth)
    return
  }

  // The callee name resolved only through its receiver, so this is some method we cannot see.
  if (hit.viaObject) {
    node.origin = 'external'
    expandOpaqueCall(walk, node, call, depth)
    return
  }

  // `new Box(...)` builds the object right here; its fields are traced by asking about them.
  if (ts.isClassLike(hit.declaration)) {
    node.origin = 'literal'
    return
  }

  const fn = functionOf(hit.declaration)
  if (!fn) {
    node.origin = 'external'
    expandOpaqueCall(walk, node, call, depth)
    return
  }

  const key = fn.getStart(walk.sf)
  const seen = walk.expanded.get(key)
  if (seen !== undefined) {
    node.origin = 'cycle'
    node.seenAs = seen
    return
  }
  walk.expanded.set(key, node.id)

  const returns = returnsOf(fn)
  if (returns.length === 0) {
    node.origin = 'external'
    return
  }
  for (const value of returns) {
    node.children.push(traceValue(walk, value, 'return', `returned by \`${hit.name}\``, depth + 1))
  }
}

/**
 * A call we cannot see inside. Everything fed in could contribute to what comes out — the receiver
 * included, so `untrusted.trim()` still leads back to `untrusted`. Over-approximate on purpose.
 */
function expandOpaqueCall(
  walk: Walk,
  node: FlowNode,
  call: ts.CallExpression | ts.NewExpression,
  depth: number,
): void {
  const parts: ts.Expression[] = []
  if (ts.isPropertyAccessExpression(call.expression)) parts.push(call.expression.expression)
  for (const arg of call.arguments ?? []) parts.push(arg)

  for (const part of parts) {
    if (isConstant(unwrap(part))) continue
    node.children.push(traceValue(walk, part, 'operand', 'flows into the call', depth + 1))
  }
}

/**
 * End a branch at a declaration.
 *
 * The node being expanded normally holds a *use* of the name — `req` inside `req.params.id` — so
 * the declaration gets its own final row. A trace that starts at a declaration should finish at
 * one, pointing at where the value enters rather than at the last place it happened to be read.
 * When the node already is the declaration (the root, say) there is nothing to add.
 */
function terminateAtDeclaration(
  walk: Walk,
  node: FlowNode,
  decl: ts.Node,
  name: string,
  origin: FlowOrigin,
): void {
  const view = describeDeclaration(decl, walk.sf, name)
  if (view.span.start === node.span.start && view.span.end === node.span.end) {
    node.origin = origin
    return
  }
  const child = addNode(walk, view.span, 'declaration', view.label)
  child.origin = origin
  node.children.push(child.id)
}

function expandDeclaration(
  walk: Walk,
  node: FlowNode,
  decl: ts.Node,
  name: string,
  depth: number,
): void {
  const key = decl.getStart(walk.sf)
  const seen = walk.expanded.get(key)
  if (seen !== undefined) {
    node.origin = 'cycle'
    node.seenAs = seen
    return
  }
  walk.expanded.set(key, node.id)

  if (isImportPart(decl)) {
    terminateAtDeclaration(walk, node, decl, name, 'import')
    return
  }

  if (ts.isParameter(decl)) {
    expandParameter(walk, node, decl, name, depth)
    return
  }

  if (ts.isBindingElement(decl)) {
    expandBindingElement(walk, node, decl, name, depth)
    return
  }

  if (ts.isVariableDeclaration(decl)) {
    if (decl.initializer) {
      node.children.push(
        traceValue(walk, decl.initializer, 'initializer', 'initialised from', depth + 1),
      )
    }
    for (const write of writesFor(walk, decl)) {
      node.children.push(traceValue(walk, write, 'assignment', `reassigned`, depth + 1))
    }
    // Declared but never given a value in this buffer.
    if (node.children.length === 0) terminateAtDeclaration(walk, node, decl, name, 'external')
    return
  }

  if (
    ts.isPropertyAssignment(decl) ||
    ts.isPropertyDeclaration(decl) ||
    ts.isEnumMember(decl) ||
    ts.isShorthandPropertyAssignment(decl)
  ) {
    const initializer = ts.isShorthandPropertyAssignment(decl) ? decl.name : decl.initializer
    if (initializer) {
      node.children.push(
        traceValue(walk, initializer, 'property', `property \`${name}\``, depth + 1),
      )
      return
    }
    terminateAtDeclaration(walk, node, decl, name, 'external')
    return
  }

  // A function or class declaration: the value is defined right here.
  terminateAtDeclaration(walk, node, decl, name, 'literal')
}

function expandParameter(
  walk: Walk,
  node: FlowNode,
  param: ts.ParameterDeclaration,
  name: string,
  depth: number,
): void {
  const sources = argumentsFor(walk, param)
  if (sources.length === 0) {
    // A named function nobody calls here is an entry point; an unnamed one was handed to something
    // else to invoke — an express route handler, an array callback — so its caller fills this in.
    const origin: FlowOrigin = calleeName(param.parent) ? 'entry' : 'callback'
    terminateAtDeclaration(walk, node, param, name, origin)
    return
  }
  for (const source of sources) {
    node.children.push(
      traceValue(walk, source.expr, 'argument', `passed to \`${source.callee}\``, depth + 1),
    )
  }
}

function expandBindingElement(
  walk: Walk,
  node: FlowNode,
  element: ts.BindingElement,
  name: string,
  depth: number,
): void {
  // TypeScript resolves a destructured name straight to the property it came from, which narrows
  // far better than re-tracing the whole object. Verified against the compiler: `kind=property`.
  const wanted = element.propertyName ?? element.name
  if (ts.isIdentifier(wanted)) {
    const hit = declarationAt(walk.service, walk.sf, walk.fileName, wanted.getStart(walk.sf))
    if (hit && hit.declaration !== element) {
      expandDeclaration(walk, node, hit.declaration, hit.name, depth)
      return
    }
  }

  const container = ts.findAncestor(
    element,
    (n): n is ts.ParameterDeclaration | ts.VariableDeclaration =>
      ts.isParameter(n) || ts.isVariableDeclaration(n),
  )
  if (!container) {
    terminateAtDeclaration(walk, node, element, name, 'external')
    return
  }

  if (ts.isParameter(container)) {
    const sources = argumentsFor(walk, container)
    if (sources.length === 0) {
      const origin: FlowOrigin = calleeName(container.parent) ? 'entry' : 'callback'
      terminateAtDeclaration(walk, node, element, name, origin)
      return
    }
    for (const source of sources) {
      node.children.push(
        traceValue(
          walk,
          narrowToProperty(source.expr, element),
          'binding',
          `passed to \`${source.callee}\``,
          depth + 1,
        ),
      )
    }
    return
  }

  if (container.initializer) {
    node.children.push(
      traceValue(
        walk,
        narrowToProperty(container.initializer, element),
        'binding',
        'destructured from',
        depth + 1,
      ),
    )
    return
  }
  terminateAtDeclaration(walk, node, element, name, 'external')
}

/* ------------------------------------------------------------------ entry point */

/**
 * Trace the value at `offset` back to its sources. Null when nothing at the offset resolves to a
 * declaration in this buffer — the same condition under which there is no definition to highlight.
 */
export function traceOrigins(
  service: ts.LanguageService,
  sf: ts.SourceFile,
  fileName: string,
  offset: number,
): FlowTrace | null {
  const definition = resolveDefinition(service, sf, fileName, offset)
  const hit = declarationAt(service, sf, fileName, offset)
  if (!definition || !hit) return null

  const walk: Walk = {
    service,
    sf,
    fileName,
    nodes: [],
    expanded: new Map(),
    truncated: false,
  }

  const root = addNode(walk, definition.primary, null, definition.label)
  expandDeclaration(walk, root, hit.declaration, hit.name, 0)

  return {
    nodes: walk.nodes,
    root: root.id,
    externalCount: walk.nodes.filter((node) => isExternalOrigin(node.origin)).length,
    truncated: walk.truncated,
  }
}
