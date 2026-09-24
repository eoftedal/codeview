/**
 * Java's answer to lib/definitions.ts: an offset in, a declaration to highlight out.
 *
 * Deliberately the same shape as the TypeScript and Python resolvers — the same `DefinitionResult`,
 * the same `DefinitionReason` values, the same "min of the body and the end of the first line"
 * signature clip — because the pane, the decorations and the AST header are shared and none of them
 * should be able to tell which language answered.
 *
 * The limits are Java's own, and they are stated rather than papered over. Without types, an
 * **overload** is separated by arity alone, a **member on an arbitrary receiver** (`foo.bar()` where
 * `foo` came from a method call) cannot be named, and a **supertype outside the open tabs** ends the
 * hierarchy walk. Each of those degrades to a narrower true answer or to nothing, never to a guess.
 */
import type { Node } from '@vscode/tree-sitter-wasm'
import type { DefinitionReason, DefinitionResult, Span } from '../definitions'
import { importedName, moduleFor } from './modules'
import {
  buildScopes,
  enclosingType,
  lookup,
  lookupCall,
  ownMemberOf,
  scopeForNode,
  superTypeNames,
  type Binding,
  type Scope,
  type ScopeTree,
} from './scopes'

/* ------------------------------------------------------------------ spans */

function trimEnd(text: string, span: Span): Span {
  let end = span.end
  while (end > span.start && /\s/.test(text[end - 1]!)) end--
  return { start: span.start, end }
}

function endOfLine(text: string, pos: number): number {
  const next = text.indexOf('\n', pos)
  return next < 0 ? text.length : next
}

function spanOf(node: Node): Span {
  return { start: node.startIndex, end: node.endIndex }
}

/**
 * The first line of a declaration: from its start to whichever comes first, the body or the end of
 * that line. The line clip keeps a multi-line parameter list or a long `implements` list from
 * dragging the whole signature into the highlight.
 */
function signatureSpan(node: Node, text: string): Span {
  const body = node.childForFieldName('body')
  const end = Math.min(body ? body.startIndex : node.endIndex, endOfLine(text, node.startIndex))
  return trimEnd(text, { start: node.startIndex, end })
}

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
        primary: spanOf(decl),
        // Where the object holding it is declared — the type's own header.
        secondary: binding.owner ? signatureSpan(binding.owner, text) : undefined,
        reason: 'property',
      }

    case 'binding':
      // A `catch` parameter, a try-with-resources, a for-each target: point at the declaration and
      // dim the header it came out of, clipped to its own line.
      return {
        primary: spanOf(decl),
        secondary: decl.type === 'enhanced_for_statement' ? signatureSpan(decl, text) : undefined,
        reason: 'binding',
      }

    default:
      return { primary: spanOf(decl), reason: binding.reason }
  }
}

/* ------------------------------------------------------------------ the caret */

/**
 * The identifier to resolve, given wherever the cursor or an AST row landed.
 *
 * A caret sits *between* characters, so a cursor parked at the end of a word is one past the
 * identifier it visually belongs to. Look left before falling back to the enclosing declaration's
 * name. Java spells a type's name `type_identifier`, so both count.
 */
const NAMES = new Set(['identifier', 'type_identifier'])

export function identifierAt(root: Node, offset: number): Node | null {
  const here = root.descendantForIndex(offset)
  if (here && NAMES.has(here.type)) return here

  if (offset > 0) {
    const left = root.descendantForIndex(offset - 1)
    if (left && NAMES.has(left.type)) return left
  }

  const named = here?.childForFieldName('name')
  return named && NAMES.has(named.type) ? named : null
}

/* ------------------------------------------------------------------ members */

/** True when the identifier is the `.x` half of `o.x` or the method of `o.m()`. */
function isMemberName(identifier: Node): boolean {
  const parent = identifier.parent
  if (!parent) return false
  if (parent.type === 'field_access') {
    return parent.childForFieldName('field')?.id === identifier.id
  }
  if (parent.type === 'method_invocation') {
    return (
      parent.childForFieldName('name')?.id === identifier.id &&
      parent.childForFieldName('object') !== null
    )
  }
  return false
}

export interface JavaFile {
  name: string
  root: Node
  text: string
}

type Scopes = (file: JavaFile) => ScopeTree

interface Context {
  files: readonly JavaFile[]
  scopes: Scopes
}

interface MemberHit {
  binding: Binding
  /** Which tab the declaration is in. Carried always, because a span is an offset into *that*
   *  file — presenting it against the active file's text is how a highlight lands on nonsense. */
  file: JavaFile
  /**
   * What to highlight in the file on screen when the declaration is not in it.
   *
   * Java needs more than one answer here. An import statement is the obvious one, but a type in the
   * **same package** has no import — and that is the common shape in a pasted pair of files. So the
   * nearest thing on screen is instead the `Base` in an `extends` clause, or the declaration of the
   * receiver whose written-down type named the class. Set at the *first* crossing only: a chain
   * two supertypes deep must still anchor on something in the active file.
   */
  anchor?: Node
}

/** How many arguments a call at this identifier supplies, or null when it is not a call. */
function argumentCount(identifier: Node): number | null {
  const parent = identifier.parent
  if (parent?.type !== 'method_invocation') return null
  if (parent.childForFieldName('name')?.id !== identifier.id) return null
  const args = parent.childForFieldName('arguments')
  return args ? args.namedChildren.filter((child) => child !== null).length : 0
}

/**
 * Walk a type and then its supertypes for a member, following one into another tab where an import
 * or a same-package tab declares it. `seen` guards a cycle, which is illegal Java but writable
 * mid-edit.
 */
function inHierarchy(
  owner: Scope,
  file: JavaFile,
  tree: ScopeTree,
  name: string,
  offset: number,
  ctx: Context,
  local: Node | undefined,
  seen: Set<string>,
): MemberHit | null {
  const key = `${file.name}:${owner.node.startIndex}`
  if (seen.has(key)) return null
  seen.add(key)

  const own = ownMemberOf(owner, name, offset)
  if (own) return { binding: own, file, anchor: local }

  for (const superType of superTypeNames(owner)) {
    const found = typeNamed(superType.text, file, tree, ctx, local)
    if (!found) continue
    const next = scopeForNode(found.tree, found.binding.declNode)
    if (!next) continue
    // Crossing into another tab: the supertype reference we followed is what stands for it here,
    // unless an outer hop already claimed that role.
    const crossing = found.file.name === file.name ? local : (local ?? found.anchor ?? superType)
    const deeper = inHierarchy(next, found.file, found.tree, name, offset, ctx, crossing, seen)
    if (deeper) return deeper
  }
  return null
}

/**
 * The type a name refers to — declared here, brought in by an import, or (the common case in a
 * pasted example) declared at the top level of another open tab, which is Java's same-package rule
 * approximated.
 */
function typeNamed(
  name: string,
  file: JavaFile,
  tree: ScopeTree,
  ctx: Context,
  local: Node | undefined,
): { binding: Binding; file: JavaFile; tree: ScopeTree; anchor: Node | undefined } | null {
  const here = tree.root.bindings.get(name)?.find((binding) => binding.reason === 'class')
  if (here) return { binding: here, file, tree, anchor: local }

  const imported = tree.root.bindings.get(name)?.find((binding) => binding.reason === 'import')
  if (imported) {
    const path = moduleFor(
      imported.declNode,
      ctx.files.map((candidate) => candidate.name),
    )
    const target = ctx.files.find((candidate) => candidate.name === path)
    if (target) {
      const targetTree = ctx.scopes(target)
      const declared = targetTree.root.bindings
        .get(importedName(imported.declNode) ?? name)
        ?.find((binding) => binding.reason === 'class')
      if (declared) {
        return {
          binding: declared,
          file: target,
          tree: targetTree,
          anchor: local ?? imported.declNode,
        }
      }
    }
  }

  // Same package: no import, the type simply sits in another tab.
  for (const candidate of ctx.files) {
    if (candidate.name === file.name) continue
    const candidateTree = ctx.scopes(candidate)
    const declared = candidateTree.root.bindings
      .get(name)
      ?.find((binding) => binding.reason === 'class')
    if (declared) return { binding: declared, file: candidate, tree: candidateTree, anchor: local }
  }
  return null
}

/**
 * A member, resolved **syntactically** in the shapes that can be read off names alone: `this.x`, a
 * bare name inside its own type, `Type.x` where `Type` is a type in an open tab, and a member on a
 * local whose declared type names one. Anything else falls back to where the receiver came from.
 */
function memberFor(
  tree: ScopeTree,
  file: JavaFile,
  identifier: Node,
  offset: number,
  ctx: Context,
): MemberHit | null {
  const access = identifier.parent
  const receiver = access?.childForFieldName('object') ?? access?.childForFieldName('scope') ?? null
  if (!receiver) return null

  const walk = (owner: Scope, where: JavaFile, whereTree: ScopeTree, anchor?: Node) =>
    inHierarchy(owner, where, whereTree, identifier.text, offset, ctx, anchor, new Set())

  if (receiver.type === 'this') {
    const owner = enclosingType(tree, offset)
    return owner ? walk(owner, file, tree) : null
  }

  if (receiver.type === 'identifier' || receiver.type === 'type_identifier') {
    // `Type.member` — a static member, or a nested type. The receiver itself is on screen, so it
    // is what stands for a declaration in another tab.
    const asType = typeNamed(receiver.text, file, tree, ctx, undefined)
    if (asType) {
      const owner = scopeForNode(asType.tree, asType.binding.declNode)
      if (owner) {
        const anchor = asType.file.name === file.name ? asType.anchor : (asType.anchor ?? receiver)
        return walk(owner, asType.file, asType.tree, anchor)
      }
    }
    // `local.member` — follow the *declared* type of the local, which Java writes down. That
    // declaration is on screen, so it anchors the answer.
    const bound = lookup(tree, receiver.text, receiver.startIndex)
    const declared = bound && declaredTypeName(bound)
    if (declared && bound) {
      const found = typeNamed(declared, file, tree, ctx, undefined)
      if (found) {
        const owner = scopeForNode(found.tree, found.binding.declNode)
        if (owner) {
          const anchor =
            found.file.name === file.name ? found.anchor : (found.anchor ?? bound.declNode)
          return walk(owner, found.file, found.tree, anchor)
        }
      }
    }
  }
  return null
}

/**
 * The type a declaration writes down. Java is explicit about this, which is what lets `db.run()`
 * resolve where Python's could not — `Db db = new Db()` says so on the line.
 */
function declaredTypeName(binding: Binding): string | null {
  const declared =
    binding.declNode.childForFieldName('type') ??
    binding.declNode.namedChildren.find((child) => child?.type === 'type_identifier')
  if (!declared) return null
  if (declared.type === 'type_identifier') return declared.text
  // `List<Db>` and friends: take the head, which is the type being named.
  if (declared.type === 'generic_type') {
    return declared.namedChildren.find((child) => child?.type === 'type_identifier')?.text ?? null
  }
  return null
}

/* ------------------------------------------------------------------ the answer */

export interface JavaHit {
  binding: Binding
  viaObject: boolean
  /** The tab the declaration is in. */
  file: JavaFile
  definedIn?: string
  /** What to highlight here when the declaration is elsewhere. */
  anchor?: Node
}

export function bindingAt(
  tree: ScopeTree,
  file: JavaFile,
  offset: number,
  ctx: Context,
): JavaHit | null {
  const identifier = identifierAt(file.root, offset)
  if (!identifier) return null

  // Every question from here on is asked at the identifier, not at the caret — a caret at the end
  // of the last name in a block is exactly that block's `endIndex`, outside every scope it is in.
  const at = identifier.startIndex

  if (isMemberName(identifier)) {
    const member = memberFor(tree, file, identifier, at, ctx)
    if (member) {
      return { ...member, viaObject: false, definedIn: member.file.name }
    }

    const receiver = identifier.parent?.childForFieldName('object')
    if (receiver && (receiver.type === 'identifier' || receiver.type === 'type_identifier')) {
      const bound = lookup(tree, receiver.text, receiver.startIndex)
      if (bound) return { binding: bound, viaObject: true, file }
    }
    return null
  }

  // A bare name inside a type may be one of its own members, which `lookup` already walks to —
  // but a supertype's member needs the hierarchy walk.
  const count = argumentCount(identifier)
  const bound =
    count === null
      ? lookup(tree, identifier.text, at)
      : lookupCall(tree, identifier.text, at, count)
  if (bound) return { binding: bound, viaObject: false, file }

  const owner = enclosingType(tree, offset)
  if (owner) {
    const inherited = inHierarchy(owner, file, tree, identifier.text, at, ctx, undefined, new Set())
    if (inherited) {
      return { ...inherited, viaObject: false, definedIn: inherited.file.name }
    }
  }

  // A type named without an import, declared in another tab — Java's same-package rule.
  const asType = typeNamed(identifier.text, file, tree, ctx, undefined)
  if (asType && asType.file.name !== file.name) {
    return {
      binding: asType.binding,
      viaObject: false,
      file: asType.file,
      definedIn: asType.file.name,
      // A same-package type needs no import, so nothing else on screen names it — but the
      // identifier the reader clicked does, and it is the honest thing to highlight.
      anchor: asType.anchor ?? identifier,
    }
  }
  return null
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

export function resolveJavaDefinition(
  active: JavaFile,
  files: readonly JavaFile[],
  offset: number,
): DefinitionResult | null {
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

  // A declaration in another tab has no range here. The import that brought its type in is the
  // nearest thing on screen — and where there is no import at all (same package), there is nothing
  // to point at, so the answer is the declaration's own file with no local span.
  if (hit.file.name !== active.name) {
    // The declaration has no range here. Highlight whatever named it on screen — the import, the
    // `extends` clause, or the receiver's own declaration — and let `definedIn` say where it
    // really lives. Without an anchor there is genuinely nothing to point at, and saying nothing
    // beats highlighting the wrong span; the TypeScript resolver answers null in the same case.
    if (!hit.anchor) return null
    const primary = spanOf(hit.anchor)
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
      ? (moduleFor(
          hit.binding.declNode,
          files.map((file) => file.name),
        ) ?? undefined)
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
