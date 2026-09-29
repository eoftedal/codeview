/**
 * C and C++'s answer to lib/definitions.ts: an offset in, a declaration to highlight out.
 *
 * The same `DefinitionResult`, the same `DefinitionReason` values and the same "min of the body and
 * the end of the first line" signature clip as the other three resolvers, because the pane, the
 * decorations and the AST header are shared and none of them should be able to tell which language
 * answered.
 *
 * The limits are C's own and are stated rather than papered over. **A macro is not expanded**, so a
 * name that only exists after preprocessing resolves to nothing. **Both arms of an `#ifdef` are
 * live**, since nothing here evaluates one. An **overload** is separated by arity alone. A
 * **member on a receiver whose type is not written down** cannot be named. And the linker rule
 * below — any open tab's file scope — is what `static` over-approximates. Each degrades to a
 * narrower true answer or to nothing, never to a guess.
 */
import type { Node } from '@vscode/tree-sitter-wasm'
import type { DefinitionReason, DefinitionResult, Span } from '../definitions'
import { includesOf, moduleFor } from './modules'
import {
  baseTypeNames,
  buildScopes,
  declaratorName,
  enclosingType,
  lookup,
  lookupCall,
  ownMemberOf,
  scopeForNode,
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
 * A declaration's span, as the editor should highlight it.
 *
 * A preprocessor directive's extent **includes the newline that ends it** — that is how the grammar
 * delimits one — so highlighting it raw runs the decoration past the end of the line and onto the
 * start of the next. Every span that becomes an answer is trimmed for that reason.
 */
function declSpan(node: Node, text: string): Span {
  return trimEnd(text, spanOf(node))
}

/**
 * The first line of a declaration: from its start to whichever comes first, the body or the end of
 * that line. The line clip keeps a multi-line parameter list or a long base-class list from
 * dragging the whole signature into the highlight.
 */
export function signatureSpan(node: Node, text: string): Span {
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
      return { primary: declSpan(decl, text), reason: 'parameter' }

    case 'property':
      return {
        primary: declSpan(decl, text),
        // Where the object holding it is declared — the struct, union, class or enum header.
        secondary: binding.owner ? signatureSpan(binding.owner, text) : undefined,
        reason: 'property',
      }

    case 'binding':
      // A range-for target or a `catch` parameter: point at it and dim the header it came out of.
      return {
        primary: declSpan(decl, text),
        secondary: decl.type === 'for_range_loop' ? signatureSpan(decl, text) : undefined,
        reason: 'binding',
      }

    default:
      return { primary: declSpan(decl, text), reason: binding.reason }
  }
}

/* ------------------------------------------------------------------ the caret */

/**
 * The identifier to resolve, given wherever the cursor or an AST row landed.
 *
 * A caret sits *between* characters, so a cursor parked at the end of a word is one past the
 * identifier it visually belongs to. Look left before falling back to the enclosing declaration's
 * name. C spells a type's name `type_identifier` and a struct member's `field_identifier`, so all
 * three count.
 */
const NAMES = new Set(['identifier', 'type_identifier', 'field_identifier', 'namespace_identifier'])

export function identifierAt(root: Node, offset: number): Node | null {
  const here = root.descendantForIndex(offset)
  if (here && NAMES.has(here.type)) return here

  if (offset > 0) {
    const left = root.descendantForIndex(offset - 1)
    if (left && NAMES.has(left.type)) return left
  }

  const named = here?.childForFieldName('name') ?? declaratorName(here ?? null)
  return named && NAMES.has(named.type) ? named : null
}

/* ------------------------------------------------------------------ members */

/** True when the identifier is the `.x` or `->x` half of a field access. `field_expression` covers
 *  both operators, which is why there is only one case here. */
function isMemberName(identifier: Node): boolean {
  const parent = identifier.parent
  if (parent?.type !== 'field_expression') return false
  return parent.childForFieldName('field')?.id === identifier.id
}

export interface CFile {
  name: string
  root: Node
  text: string
}

type Scopes = (file: CFile) => ScopeTree

interface Context {
  files: readonly CFile[]
  scopes: Scopes
}

interface MemberHit {
  binding: Binding
  /** Which tab the declaration is in. Carried always, because a span is an offset into *that*
   *  file — presenting it against the active file's text is how a highlight lands on nonsense. */
  file: CFile
  /** What to highlight here when the declaration is elsewhere: the `#include` that pulled it in,
   *  a base-class reference, the receiver's own declaration, or the clicked identifier. Set at the
   *  *first* crossing only, so a chain two base classes deep still anchors on the active file. */
  anchor?: Node
}

/** How many arguments a call at this identifier supplies, or null when it is not a call. */
function argumentCount(identifier: Node): number | null {
  // `f(x)` puts the identifier directly under the call; `o.m(x)` puts it under a field expression.
  const access = identifier.parent?.type === 'field_expression' ? identifier.parent : identifier
  const call = access.parent
  if (call?.type !== 'call_expression') return null
  if (call.childForFieldName('function')?.id !== access.id) return null
  const args = call.childForFieldName('arguments')
  return args ? args.namedChildren.filter((child) => child !== null).length : 0
}

/** Walk a type and then its base classes for a member, following one into another tab. `seen`
 *  guards a cycle, which is illegal C++ but entirely writable mid-edit. */
function inHierarchy(
  owner: Scope,
  file: CFile,
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

  for (const base of baseTypeNames(owner)) {
    const found = typeNamed(base.text, file, tree, ctx, local)
    if (!found) continue
    const next = scopeForNode(found.tree, found.binding.declNode)
    if (!next) continue
    const crossing = found.file.name === file.name ? local : (local ?? found.anchor ?? base)
    const deeper = inHierarchy(next, found.file, found.tree, name, offset, ctx, crossing, seen)
    if (deeper) return deeper
  }
  return null
}

/** The tabs a file's `#include "…"` directives name, each with the directive that named it. */
function includedFiles(file: CFile, ctx: Context): { file: CFile; directive: Node }[] {
  const names = ctx.files.map((candidate) => candidate.name)
  const found: { file: CFile; directive: Node }[] = []
  for (const directive of includesOf(file.root)) {
    const path = moduleFor(directive, names)
    const target = path && ctx.files.find((candidate) => candidate.name === path)
    if (target) found.push({ file: target, directive })
  }
  return found
}

function unitDeclaration(tree: ScopeTree, name: string, reason: DefinitionReason): Binding | null {
  return tree.root.bindings.get(name)?.find((binding) => binding.reason === reason) ?? null
}

/**
 * The type a name refers to — declared here, pulled in by an `#include "…"`, or (the linker's own
 * rule, approximated) declared at the file scope of any open tab.
 */
function typeNamed(
  name: string,
  file: CFile,
  tree: ScopeTree,
  ctx: Context,
  local: Node | undefined,
): { binding: Binding; file: CFile; tree: ScopeTree; anchor: Node | undefined } | null {
  const here = unitDeclaration(tree, name, 'class')
  if (here) return { binding: here, file, tree, anchor: local }

  for (const included of includedFiles(file, ctx)) {
    const includedTree = ctx.scopes(included.file)
    const declared = unitDeclaration(includedTree, name, 'class')
    if (declared) {
      return {
        binding: declared,
        file: included.file,
        tree: includedTree,
        anchor: local ?? included.directive,
      }
    }
  }

  for (const candidate of ctx.files) {
    if (candidate.name === file.name) continue
    const candidateTree = ctx.scopes(candidate)
    const declared = unitDeclaration(candidateTree, name, 'class')
    if (declared) return { binding: declared, file: candidate, tree: candidateTree, anchor: local }
  }
  return null
}

/**
 * A name declared at the file scope of an included tab, or failing that of any open tab — how a
 * call to a function defined in another translation unit resolves.
 */
function globalNamed(
  name: string,
  file: CFile,
  ctx: Context,
  count: number | null,
): MemberHit | null {
  const wanted = (tree: ScopeTree): Binding | null => {
    const bindings = tree.root.bindings.get(name)
    if (!bindings || bindings.length === 0) return null
    const byArity =
      count === null
        ? bindings
        : bindings.filter((binding) => binding.arity === undefined || binding.arity === count)
    const candidates = byArity.length > 0 ? byArity : bindings
    // A definition says more than a prototype, so prefer one where both are open.
    return (
      candidates.find((binding) => binding.declNode.type === 'function_definition') ??
      candidates[0]!
    )
  }

  for (const included of includedFiles(file, ctx)) {
    const found = wanted(ctx.scopes(included.file))
    if (found) return { binding: found, file: included.file, anchor: included.directive }
  }
  for (const candidate of ctx.files) {
    if (candidate.name === file.name) continue
    const found = wanted(ctx.scopes(candidate))
    if (found) return { binding: found, file: candidate }
  }
  return null
}

/**
 * The type a declaration writes down. C is explicit about this, which is what lets `b.len` resolve:
 * `struct Buf b;` says so on the line.
 */
function declaredTypeName(binding: Binding): string | null {
  const declared = binding.declNode.childForFieldName('type')
  if (!declared) return null
  if (declared.type === 'type_identifier') return declared.text
  // `struct Buf b;` names the struct inline rather than through a typedef.
  if (
    declared.type === 'struct_specifier' ||
    declared.type === 'union_specifier' ||
    declared.type === 'class_specifier' ||
    declared.type === 'enum_specifier'
  ) {
    return declared.childForFieldName('name')?.text ?? null
  }
  if (declared.type === 'qualified_identifier') {
    return declared.childForFieldName('name')?.text ?? null
  }
  if (declared.type === 'template_type') {
    return declared.childForFieldName('name')?.text ?? null
  }
  // `auto` writes the type on the initializer instead, and `auto` is how most modern C++ spells a
  // local — without this an `auto` receiver is opaque.
  if (declared.type === 'placeholder_type_specifier') return constructedTypeName(binding.declNode)
  return null
}

/** The type a declaration's initializer constructs — `auto w = Widget(…)`, `new Widget(…)`. */
function constructedTypeName(declaration: Node): string | null {
  for (const child of declaration.namedChildren) {
    if (child?.type !== 'init_declarator') continue
    const value = child.childForFieldName('value')
    if (!value) continue
    if (value.type === 'call_expression') {
      const callee = value.childForFieldName('function')
      if (callee?.type === 'identifier' || callee?.type === 'type_identifier') return callee.text
    }
    if (value.type === 'new_expression') {
      const type = value.childForFieldName('type')
      if (type?.type === 'type_identifier') return type.text
    }
  }
  return null
}

/**
 * A member, resolved **syntactically** in the shapes that can be read off names alone: a bare name
 * inside its own class, `this->x`, and `o.x` / `p->x` on a receiver whose declared type names a
 * struct or class in an open tab. Anything else falls back to where the receiver came from.
 */
function memberFor(
  tree: ScopeTree,
  file: CFile,
  identifier: Node,
  offset: number,
  ctx: Context,
): MemberHit | null {
  const receiver = identifier.parent?.childForFieldName('argument')
  if (!receiver) return null

  const walk = (owner: Scope, where: CFile, whereTree: ScopeTree, anchor?: Node) =>
    inHierarchy(owner, where, whereTree, identifier.text, offset, ctx, anchor, new Set())

  if (receiver.type === 'this') {
    const owner = enclosingType(tree, offset)
    return owner ? walk(owner, file, tree) : null
  }

  if (receiver.type === 'identifier' || receiver.type === 'type_identifier') {
    // `Type::member` and `Type.member` — the receiver itself is on screen, so it stands for a
    // declaration in another tab.
    const asType = typeNamed(receiver.text, file, tree, ctx, undefined)
    if (asType) {
      const owner = scopeForNode(asType.tree, asType.binding.declNode)
      if (owner) {
        const anchor = asType.file.name === file.name ? asType.anchor : (asType.anchor ?? receiver)
        return walk(owner, asType.file, asType.tree, anchor)
      }
    }
    // `local.member` — follow the *declared* type of the local, which C writes down.
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

/* ------------------------------------------------------------------ the answer */

export interface CHit {
  binding: Binding
  viaObject: boolean
  file: CFile
  definedIn?: string
  anchor?: Node
}

export function bindingAt(tree: ScopeTree, file: CFile, offset: number, ctx: Context): CHit | null {
  const identifier = identifierAt(file.root, offset)
  if (!identifier) return null

  // Every question from here on is asked at the identifier, not at the caret — a caret at the end
  // of the last name in a block is exactly that block's `endIndex`, outside every scope it is in.
  const at = identifier.startIndex

  if (isMemberName(identifier)) {
    const member = memberFor(tree, file, identifier, at, ctx)
    if (member) return { ...member, viaObject: false, definedIn: member.file.name }

    const receiver = identifier.parent?.childForFieldName('argument')
    if (receiver && (receiver.type === 'identifier' || receiver.type === 'type_identifier')) {
      const bound = lookup(tree, receiver.text, receiver.startIndex)
      if (bound) return { binding: bound, viaObject: true, file }
    }
    return null
  }

  const count = argumentCount(identifier)
  const bound =
    count === null
      ? lookup(tree, identifier.text, at)
      : lookupCall(tree, identifier.text, at, count)
  if (bound) return { binding: bound, viaObject: false, file }

  // A bare name inside a C++ class may be a base class's member.
  const owner = enclosingType(tree, offset)
  if (owner) {
    const inherited = inHierarchy(owner, file, tree, identifier.text, at, ctx, undefined, new Set())
    if (inherited) return { ...inherited, viaObject: false, definedIn: inherited.file.name }
  }

  // Declared in another translation unit: through an `#include`, or through the linker rule.
  const global = globalNamed(identifier.text, file, ctx, count)
  if (global) {
    return {
      ...global,
      viaObject: false,
      definedIn: global.file.name,
      // An `#include` names it on screen; with nothing but the linker rule behind the answer, the
      // identifier the reader clicked is the honest thing to highlight.
      anchor: global.anchor ?? identifier,
    }
  }
  return null
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

export function resolveCDefinition(
  active: CFile,
  files: readonly CFile[],
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

  if (hit.file.name !== active.name) {
    // The declaration has no range here. Highlight whatever named it on screen — the `#include`, a
    // base-class reference, the receiver's own declaration — and let `definedIn` say where it
    // really lives. Without an anchor there is nothing honest to point at, and the TypeScript
    // resolver answers null in the same case.
    if (!hit.anchor) return null
    const primary = declSpan(hit.anchor, active.text)
    return {
      primary,
      reason: hit.binding.reason,
      label: `${hit.binding.reason} \`${hit.binding.name}\``,
      line: lineOf(active.text, primary.start),
      definedIn: hit.definedIn,
    }
  }

  const { primary, secondary, reason } = present(hit.binding, active.text)
  return {
    primary,
    secondary,
    reason,
    label: `${reason} \`${hit.binding.name}\``,
    line: lineOf(active.text, primary.start),
  }
}
