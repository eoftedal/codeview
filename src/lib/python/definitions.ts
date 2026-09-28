/**
 * Python's answer to lib/definitions.ts: an offset in, a declaration to highlight out.
 *
 * Deliberately the same shape as the TypeScript one — the same `DefinitionResult`, the same
 * `DefinitionReason` values, the same "min of the body and the end of the first line" signature
 * clip — because the pane, the decorations and the AST header are shared and none of them should
 * be able to tell which language answered.
 *
 * What differs is where the answer comes from. TypeScript asks a language service that knows types;
 * this asks a scope binder that knows names. Everything that follows from having no types is a
 * stated limit rather than a guess — see `attributeFor` below and the README's Python section.
 */
import type { Node } from '@vscode/tree-sitter-wasm'
import type { DefinitionReason, DefinitionResult, Span } from '../definitions'
import { importedName, moduleFor, submoduleFor } from './modules'
import {
  baseNames,
  buildScopes,
  enclosingClass,
  lookup,
  ownAttributeOf,
  scopeForNode,
  type Binding,
  type Scope,
  type ScopeTree,
} from './scopes'

/* ------------------------------------------------------------------ spans */

/** Trim trailing whitespace so a clipped signature doesn't highlight the gap before the colon. */
function trimEnd(text: string, span: Span): Span {
  let end = span.end
  while (end > span.start && /\s/.test(text[end - 1]!)) end--
  return { start: span.start, end }
}

function endOfLine(text: string, pos: number): number {
  const next = text.indexOf('\n', pos)
  return next < 0 ? text.length : next
}

/**
 * The first line of a declaration: from its start to whichever comes first, the body or the end of
 * that line. The line clip keeps a multi-line parameter list from dragging the whole signature in,
 * exactly as it does for TypeScript.
 */
export function signatureSpan(node: Node, text: string): Span {
  const body = node.childForFieldName('body')
  const end = Math.min(body ? body.startIndex : node.endIndex, endOfLine(text, node.startIndex))
  return trimEnd(text, { start: node.startIndex, end })
}

function spanOf(node: Node): Span {
  return { start: node.startIndex, end: node.endIndex }
}

/** The statement a binding's declaration sits in — what to dim under a destructured name. */
function statementOf(node: Node): Node {
  let current: Node = node
  while (current.parent && current.parent.type === 'expression_statement') current = current.parent
  return current
}

/**
 * How a binding is presented: the range worth highlighting, what to dim underneath, and what to
 * call it.
 */
function present(
  binding: Binding,
  text: string,
): { primary: Span; secondary?: Span; reason: DefinitionReason } {
  const decl = binding.declNode

  switch (binding.reason) {
    case 'function':
    case 'class':
      return { primary: signatureSpan(decl, text), reason: binding.reason }

    case 'parameter':
      return { primary: spanOf(decl), reason: 'parameter' }

    case 'import':
      return { primary: spanOf(decl), reason: 'import' }

    case 'property':
      return {
        primary: spanOf(statementOf(decl)),
        // Where the object holding it was made — the class's own header.
        secondary: binding.owner ? signatureSpan(binding.owner, text) : undefined,
        reason: 'property',
      }

    case 'binding':
      // A destructured name, a `for` target, a `with`/`except` alias: point at the name, and dim
      // the header it was pulled out of. A `for` or `with` header is clipped to its own line, or
      // the whole suite would light up.
      return {
        primary: spanOf(binding.nameNode),
        secondary:
          decl.type === 'for_statement' || decl.type === 'for_in_clause'
            ? signatureSpan(decl, text)
            : spanOf(statementOf(decl)),
        reason: 'binding',
      }

    default:
      return { primary: spanOf(statementOf(decl)), reason: binding.reason }
  }
}

/**
 * How a binding is worded and where it sits — the same answer the definition header gives, so a
 * trace's terminal names a declaration exactly as the pane above it would. The TypeScript side's
 * `describeDeclaration` plays this role for `flow.ts`.
 */
export function describePythonBinding(
  binding: Binding,
  text: string,
): { span: Span; reason: DefinitionReason; label: string } {
  const { primary, reason } = present(binding, text)
  return { span: primary, reason, label: `${reason} \`${binding.name}\`` }
}

/* ------------------------------------------------------------------ the caret */

/**
 * The identifier to resolve, given wherever the cursor or an AST row landed.
 *
 * A caret sits *between* characters, so a cursor parked at the end of a word — where clicking a
 * word usually leaves it — is one past the identifier it visually belongs to. Look left before
 * falling back to the enclosing declaration's name. The same rule as `identifierAt` in
 * lib/definitions.ts and `findNodeAtOffset` in lib/astTree.ts; any new offset→node lookup needs it.
 */
export function identifierAt(root: Node, offset: number): Node | null {
  const here = root.descendantForIndex(offset)
  if (here?.type === 'identifier') return here

  if (offset > 0) {
    const left = root.descendantForIndex(offset - 1)
    if (left?.type === 'identifier') return left
  }

  // Clicking a declaration row in the AST tree should resolve via its name.
  const named = here?.childForFieldName('name')
  return named?.type === 'identifier' ? named : null
}

/* ------------------------------------------------------------------ attributes */

/** True when `identifier` is the `.x` half of an `o.x`, rather than the `o`. */
function isAttributeName(identifier: Node): boolean {
  const parent = identifier.parent
  return parent?.type === 'attribute' && parent.childForFieldName('attribute')?.id === identifier.id
}

/**
 * An attribute, resolved **syntactically** in the only shapes that can be read off names alone:
 * `self.x` inside a class, `C.x` where `C` is a class in an open tab, and a method reached either
 * way — each looked up on the class and then on its bases.
 *
 * Everything else returns null on purpose. `obj.method()` where `obj` came from a function's return
 * value needs a type to resolve, and inventing one would mean pointing at a plausible declaration
 * that may not be the right one — worse, in a tool people use to follow untrusted data, than
 * saying nothing.
 */
/** The open tab an import statement names, if any. */
export function moduleOf(
  statement: Node,
  from: PythonFile,
  files: readonly PythonFile[],
): PythonFile | null {
  const path = moduleFor(
    statement,
    from.name,
    files.map((file) => file.name),
  )
  return files.find((file) => file.name === path) ?? null
}

interface AttributeHit {
  binding: Binding
  /** Set when the declaration is in another tab. */
  definedIn?: string
  /** The import in *this* file standing for it — the base class that brought it in. */
  local?: Binding
}

/** A file's scopes, parsed once per resolve. */
type Scopes = (file: PythonFile) => ScopeTree

/**
 * Walk a class and then its bases for an attribute, following a base into another tab when an
 * import brought it in. `seen` guards against a cycle in the hierarchy, which is illegal Python but
 * entirely writable.
 */
function inHierarchy(
  owner: Scope,
  file: PythonFile,
  tree: ScopeTree,
  name: string,
  offset: number,
  ctx: { files: readonly PythonFile[]; scopes: Scopes },
  local: Binding | undefined,
  seen: Set<string>,
): AttributeHit | null {
  const key = `${file.name}:${owner.node.startIndex}`
  if (seen.has(key)) return null
  seen.add(key)

  const own = ownAttributeOf(owner, name, offset)
  if (own) return { binding: own, definedIn: local ? file.name : undefined, local }

  for (const base of baseNames(owner)) {
    const bound = lookup(tree, base.text, base.startIndex)
    if (!bound) continue

    // A base declared right here.
    if (bound.reason === 'class') {
      const next = scopeForNode(tree, bound.declNode)
      if (!next) continue
      const found = inHierarchy(next, file, tree, name, offset, ctx, local, seen)
      if (found) return found
      continue
    }

    // A base imported from another tab. The import is what stands for it on screen, so it becomes
    // the local stand-in unless an outer hop already claimed that role.
    if (bound.reason === 'import') {
      const target = moduleOf(bound.declNode, file, ctx.files)
      if (!target) continue
      const wanted = importedName(bound.declNode, bound.name)
      const targetTree = ctx.scopes(target)
      const declared = targetTree.root.bindings.get(wanted)
      const klass = declared?.find((candidate) => candidate.reason === 'class')
      if (!klass) continue
      const next = scopeForNode(targetTree, klass.declNode)
      if (!next) continue
      const found = inHierarchy(next, target, targetTree, name, offset, ctx, local ?? bound, seen)
      if (found) return found
    }
  }
  return null
}

function attributeFor(
  tree: ScopeTree,
  file: PythonFile,
  identifier: Node,
  offset: number,
  ctx: { files: readonly PythonFile[]; scopes: Scopes },
): AttributeHit | null {
  const access = identifier.parent
  const object = access?.childForFieldName('object')
  if (!object) return null

  const walk = (owner: Scope) =>
    inHierarchy(owner, file, tree, identifier.text, offset, ctx, undefined, new Set())

  if (object.type === 'identifier' && object.text === 'self') {
    const owner = enclosingClass(tree, offset)
    return owner ? walk(owner) : null
  }

  if (object.type === 'identifier') {
    const bound = lookup(tree, object.text, object.startIndex)
    if (bound?.reason === 'class') {
      const owner = scopeForNode(tree, bound.declNode)
      if (owner) return walk(owner)
    }
  }
  return null
}

/* ------------------------------------------------------------------ the answer */

export interface PythonHit {
  binding: Binding
  /** The tab holding the declaration, when it is not the one on screen. */
  definedIn?: string
  /** The import in this file standing in for a declaration in another one — the only thing the
   *  editor can highlight. */
  local?: Binding
  /**
   * True when the attribute had no declaration of its own and the object expression answered
   * instead — `request`, not `request.args`. The same fallback lib/definitions.ts makes for a
   * property on a value TypeScript cannot type, and it means the answer describes a *different*
   * expression, which a caller walking a chain would need to know.
   */
  viaObject: boolean
}

/** The binding an offset resolves to, or null when nothing open declares it. */
export function bindingAt(
  tree: ScopeTree,
  file: PythonFile,
  offset: number,
  ctx: { files: readonly PythonFile[]; scopes: Scopes },
): PythonHit | null {
  const root = file.root
  const identifier = identifierAt(root, offset)
  if (!identifier) return null

  // Every question from here on is asked at the identifier, not at the caret. A caret sits between
  // characters, so one parked at the end of the last name in a `def` is exactly that `def`'s
  // `endIndex` — outside it — and every scope lookup would miss the scope the name is plainly in.
  const at = identifier.startIndex

  if (isAttributeName(identifier)) {
    const attribute = attributeFor(tree, file, identifier, at, ctx)
    if (attribute) return { ...attribute, viaObject: false }

    // Fall back to where the object came from, which for a parameter is the parameter.
    const object = identifier.parent?.childForFieldName('object')
    if (object?.type === 'identifier') {
      const bound = lookup(tree, object.text, object.startIndex)
      if (bound) return { binding: bound, viaObject: true }
    }
    return null
  }

  const bound = lookup(tree, identifier.text, at)
  return bound ? { binding: bound, viaObject: false } : null
}

/** 1-based, matching the definition header's "line N". */
function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/** One open Python tab, parsed. `name` is its module path. */
export interface PythonFile {
  name: string
  root: Node
  text: string
}

/**
 * Where an import leads, when it leads into another open tab.
 *
 * The answer keeps the shape the TypeScript side gives: the span stays on *this* file's import
 * statement, because that is the only thing the editor can highlight, and `definedIn` says which
 * tab holds the real declaration. That is the intended answer rather than a gap — see CLAUDE.md.
 */
function across(
  statement: Node,
  local: string,
  from: PythonFile,
  files: readonly PythonFile[],
): string | null {
  const names = files.map((file) => file.name)

  // `from pkg.mod import x` — the module, then `x` in its module scope.
  if (statement.type === 'import_from_statement') {
    const wanted = importedName(statement, local)
    const path = moduleFor(statement, from.name, names)
    const target = files.find((file) => file.name === path)
    if (target) {
      const scopes = buildScopes(target.root)
      if (scopes.root.bindings.has(wanted)) return target.name
    }
    // `from . import s`, where `s` is a submodule rather than a name in the package.
    const submodule = submoduleFor(statement, wanted, from.name, names)
    if (submodule) return submodule
    return null
  }

  // `import db` / `import pkg.mod as m` — the binding *is* the module.
  const path = moduleFor(statement, from.name, names)
  return path && files.some((file) => file.name === path) ? path : null
}

export function resolvePythonDefinition(
  active: PythonFile,
  files: readonly PythonFile[],
  offset: number,
): DefinitionResult | null {
  // Each file's scopes are built at most once per resolve, however many bases the walk crosses.
  const built = new Map<string, ScopeTree>()
  const scopes: Scopes = (file) => {
    const existing = built.get(file.name)
    if (existing) return existing
    const made = buildScopes(file.root)
    built.set(file.name, made)
    return made
  }

  const tree = scopes(active)
  const hit = bindingAt(tree, active, offset, { files, scopes })
  if (!hit) return null

  // A declaration in another tab has no range here. The import that brought its class in is the
  // nearest thing on screen, so that is what gets highlighted — the same answer this tool has
  // always given for an imported name — while the label still names what was actually asked about.
  if (hit.local) {
    const primary = spanOf(statementOf(hit.local.declNode))
    return {
      primary,
      reason: hit.binding.reason,
      label: `${hit.binding.reason} \`${hit.binding.name}\``,
      line: lineOf(active.text, primary.start),
      definedIn: hit.definedIn,
    }
  }

  const { primary, secondary, reason } = present(hit.binding, active.text)
  const definedIn =
    reason === 'import'
      ? (across(hit.binding.declNode, hit.binding.name, active, files) ?? undefined)
      : undefined

  return {
    primary,
    secondary,
    reason,
    label: `${reason} \`${hit.binding.name}\``,
    line: lineOf(active.text, primary.start),
    definedIn,
  }
}
