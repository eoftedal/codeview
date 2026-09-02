import ts from 'typescript'
import { findTsNodeAtOffset } from './analyzer'

export interface Span {
  start: number
  end: number
}

export type DefinitionReason =
  'variable' | 'parameter' | 'function' | 'class' | 'property' | 'import' | 'binding' | 'other'

export interface DefinitionResult {
  /** The declaration itself. */
  primary: Span
  /** For a property, where the object holding it was created. */
  secondary?: Span
  reason: DefinitionReason
  /** e.g. "parameter `name`" — shown in the AST pane header. */
  label: string
  /** 1-based, for the header's "line N". */
  line: number
}

/** Trim trailing whitespace so a clipped signature doesn't highlight the gap before the brace. */
function trimEnd(sf: ts.SourceFile, span: Span): Span {
  const text = sf.text
  let end = span.end
  while (end > span.start && /\s/.test(text[end - 1]!)) end--
  return { start: span.start, end }
}

function endOfLine(sf: ts.SourceFile, pos: number): number {
  const { line } = sf.getLineAndCharacterOfPosition(pos)
  const starts = sf.getLineStarts()
  return line + 1 < starts.length ? starts[line + 1]! - 1 : sf.getEnd()
}

/** Where a declaration's body begins — the point past which the signature ends. */
function bodyStart(decl: ts.Node, sf: ts.SourceFile): number {
  if (ts.isFunctionLike(decl)) {
    // isFunctionLike widens to SignatureDeclaration, which covers bodiless call signatures too.
    const body = (decl as ts.FunctionLikeDeclaration).body
    if (body) return body.getStart(sf)
  }
  if (ts.isClassLike(decl) || ts.isInterfaceDeclaration(decl)) {
    const brace = decl.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.OpenBraceToken)
    if (brace) return brace.getStart(sf)
  }
  return decl.getEnd()
}

/**
 * The first line of a declaration: from its start to whichever comes first, the body or the end of
 * that line. The line clip is what keeps a multi-line parameter list from dragging the whole
 * signature into the highlight.
 */
function signatureSpan(decl: ts.Node, sf: ts.SourceFile): Span {
  const start = decl.getStart(sf)
  return trimEnd(sf, { start, end: Math.min(bodyStart(decl, sf), endOfLine(sf, start)) })
}

/** A `const x = …` declaration reads better with its keyword, but only when it stands alone. */
function variableSpan(decl: ts.VariableDeclaration, sf: ts.SourceFile): Span {
  const list = decl.parent
  const start =
    ts.isVariableDeclarationList(list) && list.declarations.length === 1
      ? list.getStart(sf)
      : decl.getStart(sf)
  return { start, end: decl.getEnd() }
}

/** Walk out of an object literal to the expression that created it. */
function creationSpan(objectLiteral: ts.Node, sf: ts.SourceFile): Span {
  const parent = objectLiteral.parent
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === objectLiteral) {
    return variableSpan(parent, sf)
  }
  if (parent && (ts.isNewExpression(parent) || ts.isCallExpression(parent))) {
    return { start: parent.getStart(sf), end: parent.getEnd() }
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return { start: parent.getStart(sf), end: parent.getEnd() }
  }
  return { start: objectLiteral.getStart(sf), end: objectLiteral.getEnd() }
}

/** The declaration a definition hit belongs to — TS points at the name, we want the whole thing. */
function declarationFor(node: ts.Node): ts.Node {
  let current: ts.Node = node
  while (current.parent) {
    const parent = current.parent
    const isNameOf =
      (ts.isDeclarationStatement(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isEnumMember(parent)) &&
      (parent as { name?: ts.Node }).name === current
    if (!isNameOf) break
    current = parent
  }
  return current
}

function spanForDeclaration(
  decl: ts.Node,
  sf: ts.SourceFile,
): { primary: Span; secondary?: Span; reason: DefinitionReason } {
  if (ts.isParameter(decl)) {
    return { primary: { start: decl.getStart(sf), end: decl.getEnd() }, reason: 'parameter' }
  }
  if (ts.isBindingElement(decl)) {
    // A destructured binding: point at the element, and dim in whatever it was destructured from.
    const container = ts.findAncestor(
      decl,
      (n): n is ts.ParameterDeclaration | ts.VariableDeclaration =>
        ts.isParameter(n) || ts.isVariableDeclaration(n),
    )
    return {
      primary: { start: decl.getStart(sf), end: decl.getEnd() },
      secondary: container
        ? ts.isVariableDeclaration(container)
          ? variableSpan(container, sf)
          : { start: container.getStart(sf), end: container.getEnd() }
        : undefined,
      reason: ts.isParameter(decl.parent.parent) ? 'parameter' : 'binding',
    }
  }
  if (ts.isVariableDeclaration(decl)) {
    // `const f = () => …` is a function as far as the reader is concerned.
    if (decl.initializer && ts.isFunctionLike(decl.initializer)) {
      const start = variableSpan(decl, sf).start
      return {
        primary: trimEnd(sf, {
          start,
          end: Math.min(bodyStart(decl.initializer, sf), endOfLine(sf, start)),
        }),
        reason: 'function',
      }
    }
    return { primary: variableSpan(decl, sf), reason: 'variable' }
  }
  if (ts.isFunctionLike(decl)) {
    return { primary: signatureSpan(decl, sf), reason: 'function' }
  }
  if (ts.isClassLike(decl) || ts.isInterfaceDeclaration(decl)) {
    return { primary: signatureSpan(decl, sf), reason: 'class' }
  }
  if (
    ts.isPropertyAssignment(decl) ||
    ts.isShorthandPropertyAssignment(decl) ||
    ts.isPropertySignature(decl) ||
    ts.isPropertyDeclaration(decl)
  ) {
    const objectLiteral = decl.parent
    return {
      primary: { start: decl.getStart(sf), end: decl.getEnd() },
      secondary: objectLiteral ? creationSpan(objectLiteral, sf) : undefined,
      reason: 'property',
    }
  }
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
    const declaration = ts.findAncestor(decl, ts.isImportDeclaration)
    const target = declaration ?? decl
    return { primary: { start: target.getStart(sf), end: target.getEnd() }, reason: 'import' }
  }
  return { primary: { start: decl.getStart(sf), end: decl.getEnd() }, reason: 'other' }
}

export interface DeclarationView {
  span: Span
  reason: DefinitionReason
  /** e.g. "parameter `req`" — the same wording the definition header uses. */
  label: string
}

/**
 * How a declaration should be presented: the range worth highlighting and what to call it. Shared
 * so a trace ending at a declaration names it exactly the way the definition header would.
 */
export function describeDeclaration(
  decl: ts.Node,
  sf: ts.SourceFile,
  name: string,
): DeclarationView {
  const { primary, reason } = spanForDeclaration(decl, sf)
  return { span: primary, reason, label: `${reason} \`${name}\`` }
}

function asIdentifier(node: ts.Node): ts.Node | null {
  return ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node : null
}

/**
 * The identifier to ask TS about, given wherever the cursor or an AST row landed.
 *
 * A caret sits *between* characters, so a cursor parked at the end of a word — where clicking a
 * word usually leaves it — is one past the identifier it visually belongs to. Look left before
 * falling back to the enclosing declaration's name.
 */
function identifierAt(sf: ts.SourceFile, offset: number): ts.Node | null {
  const node = findTsNodeAtOffset(sf, offset)
  const here = asIdentifier(node)
  if (here) return here

  if (offset > 0) {
    const left = asIdentifier(findTsNodeAtOffset(sf, offset - 1))
    if (left) return left
  }

  // Clicking a declaration row in the AST tree should resolve via its name.
  const named = node as { name?: ts.Node }
  if (named.name && ts.isIdentifier(named.name as ts.Node)) return named.name as ts.Node
  return null
}

export interface DeclarationHit {
  /** The declaration itself — the whole thing, not just the name TS pointed at. */
  declaration: ts.Node
  /** The name TypeScript resolved, for labelling. */
  name: string
  /**
   * True when the property had no declaration of its own and the object expression answered
   * instead. The declaration then describes a *different* expression — `req` rather than
   * `req.params.id` — which callers walking a chain need to know so they can show the hop.
   */
  viaObject: boolean
}

/**
 * The declaration an offset resolves to, or null when nothing in this buffer declares it.
 *
 * Shared by the definition highlight and the flow walker, so the caret rule and the property
 * fallback live in exactly one place. A null here is meaningful rather than a failure: with `noLib`
 * and `noResolve` nothing outside the buffer resolves, so an unresolvable name *is* an external one.
 */
export function declarationAt(
  service: ts.LanguageService,
  sf: ts.SourceFile,
  fileName: string,
  offset: number,
): DeclarationHit | null {
  const identifier = identifierAt(sf, offset)
  if (!identifier) return null

  let definitions = service.getDefinitionAtPosition(fileName, identifier.getStart(sf))
  let viaObject = false

  // A property on a value TS can't type (an untyped JS parameter, say) has no definition of its
  // own. Fall back to where the object came from — which, for a parameter, is the parameter.
  if (
    (!definitions || definitions.length === 0) &&
    ts.isIdentifier(identifier) &&
    ts.isPropertyAccessExpression(identifier.parent) &&
    identifier.parent.name === identifier
  ) {
    definitions = service.getDefinitionAtPosition(
      fileName,
      identifier.parent.expression.getStart(sf),
    )
    viaObject = true
  }
  if (!definitions || definitions.length === 0) return null

  // `new Box()` reports both the class and its constructor; the class is the useful one.
  const info =
    definitions.find((d) => d.kind !== ts.ScriptElementKind.constructorImplementationElement) ??
    definitions[0]!
  if (info.fileName !== fileName) return null

  return {
    declaration: declarationFor(findTsNodeAtOffset(sf, info.textSpan.start)),
    name: info.name,
    viaObject,
  }
}

export function resolveDefinition(
  service: ts.LanguageService,
  sf: ts.SourceFile,
  fileName: string,
  offset: number,
): DefinitionResult | null {
  const hit = declarationAt(service, sf, fileName, offset)
  if (!hit) return null

  const { primary, secondary, reason } = spanForDeclaration(hit.declaration, sf)

  return {
    primary,
    secondary,
    reason,
    label: `${reason} \`${hit.name}\``,
    line: sf.getLineAndCharacterOfPosition(primary.start).line + 1,
  }
}
