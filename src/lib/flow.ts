import ts from 'typescript'
import { fileLabel, findTsNodeAtOffset } from './analyzer'
import {
  declarationAt,
  describeDeclaration,
  isImportPart,
  resolveDefinition,
  type Span,
} from './definitions'

/**
 * Backward provenance: given a value, where could it have come from?
 *
 * This is a *may*-analysis. It walks every path that could reach the value — both sides of a
 * ternary, every call site of a function, every assignment to a `let` — with no path sensitivity
 * and no alias analysis. It over-approximates, and where it cannot follow a value it says so
 * (`external`) rather than pretending the chain ended.
 *
 * The walk crosses files. Every open tab is in the program, so an import of another tab resolves
 * and the walk follows it — into the callee's body, and back out through its call sites, wherever
 * they are. Each step records the file it is in, since a line number alone no longer says where.
 *
 * The `noLib` analyzer (see lib/analyzer.ts) keeps the terminal condition principled rather than
 * heuristic: nothing outside the open files resolves, so a name with no definition *is* an
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
 * `literal` means the value originates inside the open files — a constant, a function, a freshly
 * constructed object. The others all mean it entered from somewhere we cannot see.
 */
export type FlowOrigin =
  'literal' | 'import' | 'external' | 'entry' | 'callback' | 'cycle' | 'budget'

export interface FlowNode {
  id: number
  span: Span
  /** The tab this step is in — spans are offsets into that file, not into the active one. */
  file: string
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
  /** Terminals that came from outside the open files — imports, globals, uncalled parameters. */
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

/** A step's location: which file, and where in it. Spans mean nothing without the file now. */
export interface FlowTarget {
  span: Span
  file: string
}

interface Walk {
  service: ts.LanguageService
  program: ts.Program
  nodes: FlowNode[]
  /** `file:offset` of a declaration → the node that expanded it, so cycles and diamonds
   *  terminate. Keyed by file as well as offset: two tabs share every offset. */
  expanded: Map<string, number>
  truncated: boolean
}

/* ------------------------------------------------------------------ small helpers */

function spanOf(node: ts.Node): Span {
  const sf = node.getSourceFile()
  return { start: node.getStart(sf), end: node.getEnd() }
}

/** Identity of a declaration across the whole program. */
function keyOf(node: ts.Node): string {
  const sf = node.getSourceFile()
  return `${sf.fileName}:${node.getStart(sf)}`
}

function excerptOf(sf: ts.SourceFile, span: Span): string {
  const text = sf.text.slice(span.start, span.end).replace(/\s+/g, ' ').trim()
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text
}

function addNode(
  walk: Walk,
  sf: ts.SourceFile,
  span: Span,
  step: FlowStep | null,
  label: string,
): FlowNode {
  const node: FlowNode = {
    id: walk.nodes.length,
    span,
    file: fileLabel(sf.fileName),
    line: sf.getLineAndCharacterOfPosition(span.start).line + 1,
    step,
    label,
    excerpt: excerptOf(sf, span),
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

  const sf = decl.getSourceFile()
  const declared = decl.name.getStart(sf)
  // References come back from the whole program, so an exported `let` written from another tab is
  // found the same way one written here is.
  const refs = walk.service.getReferencesAtPosition(sf.fileName, declared) ?? []
  const out: ts.Expression[] = []
  for (const ref of refs) {
    if (!ref.isWriteAccess) continue
    const refSf = walk.program.getSourceFile(ref.fileName)
    if (!refSf) continue
    if (refSf === sf && ref.textSpan.start === declared) continue // the declaration itself

    const node = findTsNodeAtOffset(refSf, ref.textSpan.start)
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

  const sf = fn.getSourceFile()
  // The interesting call sites of an exported function are in the files that import it, and
  // find-all-references crosses the import for us.
  const refs = walk.service.getReferencesAtPosition(sf.fileName, name.getStart(sf)) ?? []
  const sources: ArgumentSource[] = []
  const seen = new Set<string>()

  const take = (expr: ts.Expression): void => {
    // The default initializer is one node however many call sites omit the argument.
    const key = keyOf(expr)
    if (seen.has(key)) return
    seen.add(key)
    sources.push({ expr, callee: name.text })
  }

  for (const ref of refs) {
    const refSf = walk.program.getSourceFile(ref.fileName)
    if (!refSf) continue
    const call = callAt(refSf, ref.textSpan.start)
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
  const node = addNode(walk, expr.getSourceFile(), spanOf(expr), step, label)
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
    const sf = expr.getSourceFile()
    const hit = declarationAt(walk.service, sf, sf.fileName, lookupPosition(expr, sf))
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
  const sf = call.getSourceFile()
  const target = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression
  const hit = ts.isIdentifier(target)
    ? declarationAt(walk.service, sf, sf.fileName, target.getStart(sf))
    : null

  // An import that still resolves to nothing is an import of something not open here; one that
  // resolves lands on the callee itself, in whichever tab that is, and the walk goes on.
  if (!hit || isImportPart(hit.declaration)) {
    // The implementation is not among the open files, so the result originates outside them — but
    // what was fed in still matters, so keep walking the receiver and the arguments underneath.
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

  const key = keyOf(fn)
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
  const sf = decl.getSourceFile()
  const view = describeDeclaration(decl, sf, name)
  if (
    view.span.start === node.span.start &&
    view.span.end === node.span.end &&
    fileLabel(sf.fileName) === node.file
  ) {
    node.origin = origin
    return
  }
  const child = addNode(walk, sf, view.span, 'declaration', view.label)
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
  const key = keyOf(decl)
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
    // Declared but never given a value anywhere open.
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
    const sf = element.getSourceFile()
    const hit = declarationAt(walk.service, sf, sf.fileName, wanted.getStart(sf))
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
 * Trace the value at `offset` in `sf` back to its sources, following it into the other open files
 * wherever an import leads. Null when nothing at the offset resolves to a declaration — the same
 * condition under which there is no definition to highlight.
 */
export function traceOrigins(
  service: ts.LanguageService,
  sf: ts.SourceFile,
  fileName: string,
  offset: number,
): FlowTrace | null {
  const program = service.getProgram()
  const definition = resolveDefinition(service, sf, fileName, offset)
  const hit = declarationAt(service, sf, fileName, offset)
  if (!program || !definition || !hit) return null

  const walk: Walk = {
    service,
    program,
    nodes: [],
    expanded: new Map(),
    truncated: false,
  }

  // The root is always in the file being looked at: `resolveDefinition` reports an imported name
  // through its import statement, and the expansion below crosses it.
  const root = addNode(walk, sf, definition.primary, null, definition.label)
  expandDeclaration(walk, root, hit.declaration, hit.name, 0)

  return {
    nodes: walk.nodes,
    root: root.id,
    externalCount: walk.nodes.filter((node) => isExternalOrigin(node.origin)).length,
    truncated: walk.truncated,
  }
}
