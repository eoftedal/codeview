/**
 * C#'s answer to lib/definitions.ts: an offset in, a declaration to highlight out.
 *
 * The same `DefinitionResult`, the same `DefinitionReason` values and the same signature clip as
 * the other three resolvers, because the pane, the decorations and the AST header are shared and
 * none of them should be able to tell which language answered.
 *
 * C#'s saving grace is Java's: **a receiver's type is written down**. `IRepo _repo;` and
 * `var pid = new ProductId(id)` both say what they are on the line, which is what lets
 * `_repo.Load(…)` resolve into another tab — the member resolution Python has to decline.
 *
 * The limits are C#'s own and are stated rather than papered over. An **overload** is separated by
 * arity alone. A **partial class** split across two tabs answers with whichever half declares the
 * member and cannot see the other's. An **extension method** is found only where its name is
 * unambiguous. A **member on a receiver whose type is not written down** cannot be named. Each
 * degrades to a narrower true answer or to nothing, never to a guess.
 */
import type { Node } from '@vscode/tree-sitter-wasm'
import type { DefinitionReason, DefinitionResult, Span } from '../definitions'
import { aliasedName, moduleFor } from './modules'
import {
  buildScopes,
  declaratorValue,
  declaratorsOf,
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
 * that line. The line clip keeps a multi-line parameter list or a long base list from dragging the
 * whole signature into the highlight — and in C#, an attribute above the declaration is part of the
 * node, so the clip is what keeps `[HttpGet("{id}")]` from becoming the whole highlight.
 */
export function signatureSpan(node: Node, text: string): Span {
  const body = node.childForFieldName('body') ?? node.childForFieldName('accessors')
  // An attribute list sits inside the declaration node and above its first line, so start the
  // signature after it — otherwise every annotated method highlights from its attribute.
  const start = attributesEnd(node) ?? node.startIndex
  const end = Math.min(body ? body.startIndex : node.endIndex, endOfLine(text, start))
  return trimEnd(text, { start, end })
}

/** Where a declaration's own text begins, past any attribute lists written above it. */
function attributesEnd(node: Node): number | null {
  let after: number | null = null
  for (const child of node.namedChildren) {
    if (child?.type !== 'attribute_list') break
    after = child.endIndex
  }
  if (after === null) return null
  // Skip the whitespace between the last attribute and the declaration itself.
  const next = node.namedChildren.find(
    (child) => child !== null && child.type !== 'attribute_list' && child.startIndex >= after!,
  )
  return next ? next.startIndex : after
}

/** A node's span without the punctuation it brackets — first named child to last. */
function innerSpan(node: Node): Span {
  const named = node.namedChildren.filter((child): child is Node => child !== null)
  const first = named[0]
  const last = named[named.length - 1]
  if (!first || !last) return spanOf(node)
  return { start: first.startIndex, end: last.endIndex }
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
        primary: decl.type === 'property_declaration' ? signatureSpan(decl, text) : spanOf(decl),
        // Where the object holding it is declared — the type's own header.
        secondary: binding.owner ? signatureSpan(binding.owner, text) : undefined,
        reason: 'property',
      }

    case 'binding':
      // A `foreach` target, a `catch` declaration, an `is T x` pattern.
      return {
        // A `catch_declaration` node includes its own parentheses, where Java's
        // `catch_formal_parameter` does not. The pane is shared, so the two are made to agree.
        primary: decl.type === 'catch_declaration' ? innerSpan(decl) : spanOf(decl),
        secondary: decl.type === 'foreach_statement' ? signatureSpan(decl, text) : undefined,
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
 * name. Unlike Java and C, C# spells every name — type, member, local — `identifier`.
 */
export function identifierAt(root: Node, offset: number): Node | null {
  const here = root.descendantForIndex(offset)
  if (here?.type === 'identifier') return here

  if (offset > 0) {
    const left = root.descendantForIndex(offset - 1)
    if (left?.type === 'identifier') return left
  }

  const named = here?.childForFieldName('name')
  return named?.type === 'identifier' ? named : null
}

/* ------------------------------------------------------------------ members */

/** True when the identifier is the `.X` half of `o.X` — which in C# is one node type whether the
 *  member is a field, a property or a method, since the invocation wraps the access. */
function isMemberName(identifier: Node): boolean {
  const parent = identifier.parent
  if (parent?.type !== 'member_access_expression') return false
  return parent.childForFieldName('name')?.id === identifier.id
}

export interface CSharpFile {
  name: string
  root: Node
  text: string
}

type Scopes = (file: CSharpFile) => ScopeTree

interface Context {
  files: readonly CSharpFile[]
  scopes: Scopes
}

interface MemberHit {
  binding: Binding
  /** Which tab the declaration is in. Carried always, because a span is an offset into *that*
   *  file — presenting it against the active file's text is how a highlight lands on nonsense. */
  file: CSharpFile
  /** What to highlight here when the declaration is elsewhere: a `using` alias, a base-type
   *  reference, the receiver's declaration, or the clicked identifier. Set at the *first* crossing
   *  only, so a chain two base types deep still anchors on something in the active file. */
  anchor?: Node
}

/** The `invocation_expression` an identifier is the callee of, through the member access that may
 *  sit between them. */
function invocationFor(identifier: Node): Node | null {
  const access =
    identifier.parent?.type === 'member_access_expression' ? identifier.parent : identifier
  const call = access.parent
  if (call?.type !== 'invocation_expression') return null
  return call.childForFieldName('function')?.id === access.id ? call : null
}

/** How many arguments a call at this identifier supplies, or null when it is not a call. */
function argumentCount(identifier: Node): number | null {
  const call = invocationFor(identifier)
  if (!call) return null
  return argumentsIn(call)
}

export function argumentsIn(call: Node): number {
  const list = call.childForFieldName('arguments')
  return (list?.namedChildren ?? []).filter((child) => child !== null).length
}

/** Walk a type and then its base types for a member, following one into another tab. `seen` guards
 *  a cycle, which is illegal C# but entirely writable mid-edit. */
function inHierarchy(
  owner: Scope,
  file: CSharpFile,
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
    const crossing = found.file.name === file.name ? local : (local ?? found.anchor ?? superType)
    const deeper = inHierarchy(next, found.file, found.tree, name, offset, ctx, crossing, seen)
    if (deeper) return deeper
  }
  return null
}

/**
 * The type a name refers to — declared here, aliased in by a `using X = …`, or (the common case,
 * since C# imports namespaces rather than types) declared at the top level of another open tab.
 */
function typeNamed(
  name: string,
  file: CSharpFile,
  tree: ScopeTree,
  ctx: Context,
  local: Node | undefined,
): { binding: Binding; file: CSharpFile; tree: ScopeTree; anchor: Node | undefined } | null {
  const here = tree.root.bindings.get(name)?.find((binding) => binding.reason === 'class')
  if (here) return { binding: here, file, tree, anchor: local }

  const aliased = tree.root.bindings.get(name)?.find((binding) => binding.reason === 'import')
  if (aliased) {
    const path = moduleFor(
      aliased.declNode,
      ctx.files.map((candidate) => candidate.name),
    )
    const target = ctx.files.find((candidate) => candidate.name === path)
    if (target) {
      const targetTree = ctx.scopes(target)
      const declared = targetTree.root.bindings
        .get(aliasedName(aliased.declNode) ?? name)
        ?.find((binding) => binding.reason === 'class')
      if (declared) {
        return {
          binding: declared,
          file: target,
          tree: targetTree,
          anchor: local ?? aliased.declNode,
        }
      }
    }
  }

  // The rule that does the work: a type simply sits in another tab. See modules.ts.
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
 * The type a declaration writes down.
 *
 * Two levels deeper than Java's: a field or local declaration wraps a `variable_declaration` that
 * carries the type, and only a parameter or a property writes it on the node itself.
 */
function declaredTypeName(binding: Binding): string | null {
  const holder =
    binding.declNode.namedChildren.find((child) => child?.type === 'variable_declaration') ??
    binding.declNode
  const declared = holder.childForFieldName('type')

  // `var` writes the type on the initializer instead, and `var` is how most modern C# spells a
  // local — without this a `var` receiver is opaque.
  if (!declared || declared.type === 'implicit_type') return constructedTypeName(binding.declNode)

  return headOfType(declared)
}

/** The type being named, looking through the wrappers that decorate one. */
function headOfType(node: Node): string | null {
  if (node.type === 'identifier') return node.text
  // `List<Item>`, `Item[]`, `string?`, `Shop.Data.Item` — take the head in each case.
  if (node.type === 'generic_name') {
    return node.namedChildren.find((child) => child?.type === 'identifier')?.text ?? null
  }
  if (node.type === 'nullable_type' || node.type === 'array_type') {
    const inner = node.childForFieldName('type')
    return inner ? headOfType(inner) : null
  }
  if (node.type === 'qualified_name') {
    const inner = node.childForFieldName('name')
    return inner ? headOfType(inner) : null
  }
  return null
}

/** The type a declaration's initializer constructs — `var w = new Wrapper(…)`. */
function constructedTypeName(declaration: Node): string | null {
  for (const declarator of declaratorsOf(declaration)) {
    const value = declaratorValue(declarator)
    if (value?.type !== 'object_creation_expression') continue
    const type = value.childForFieldName('type')
    if (type) return headOfType(type)
  }
  return null
}

/**
 * A member, resolved **syntactically** in the shapes that can be read off names alone: `this.X`, a
 * bare name inside its own type, `Type.X` where `Type` is a type in an open tab, and a member on a
 * local or field whose declared type names one. Anything else falls back to where the receiver
 * came from.
 */
function memberFor(
  tree: ScopeTree,
  file: CSharpFile,
  identifier: Node,
  offset: number,
  ctx: Context,
): MemberHit | null {
  const receiver = identifier.parent?.childForFieldName('expression')
  if (!receiver) return null

  const walk = (owner: Scope, where: CSharpFile, whereTree: ScopeTree, anchor?: Node) =>
    inHierarchy(owner, where, whereTree, identifier.text, offset, ctx, anchor, new Set())

  // `this` and `base` are anonymous nodes in this grammar, but the field still returns them.
  if (receiver.type === 'this' || receiver.type === 'base') {
    const owner = enclosingType(tree, offset)
    return owner ? walk(owner, file, tree) : null
  }

  if (receiver.type === 'identifier') {
    // `Type.Member` — a static member, or a nested type. The receiver is on screen, so it is what
    // stands for a declaration in another tab.
    const asType = typeNamed(receiver.text, file, tree, ctx, undefined)
    if (asType) {
      const owner = scopeForNode(asType.tree, asType.binding.declNode)
      if (owner) {
        const anchor = asType.file.name === file.name ? asType.anchor : (asType.anchor ?? receiver)
        const found = walk(owner, asType.file, asType.tree, anchor)
        if (found) return found
      }
    }
    // `local.Member` — follow the *declared* type of the local, which C# writes down.
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
 * The scope of a type named from `file`, for a caller that has a name and needs the declaration —
 * the flow walk, resolving what `new ProductId(…)` constructs.
 */
export function typeScopeFor(
  name: string,
  file: CSharpFile,
  files: readonly CSharpFile[],
  scopes: Scopes,
): { scope: Scope; file: CSharpFile } | null {
  const found = typeNamed(name, file, scopes(file), { files, scopes }, undefined)
  if (!found) return null
  const scope = scopeForNode(found.tree, found.binding.declNode)
  return scope ? { scope, file: found.file } : null
}

/* ------------------------------------------------------------------ the answer */

export interface CSharpHit {
  binding: Binding
  viaObject: boolean
  /** The tab the declaration is in. */
  file: CSharpFile
  definedIn?: string
  /** What to highlight here when the declaration is elsewhere. */
  anchor?: Node
}

export function bindingAt(
  tree: ScopeTree,
  file: CSharpFile,
  offset: number,
  ctx: Context,
): CSharpHit | null {
  const identifier = identifierAt(file.root, offset)
  if (!identifier) return null

  // Every question from here on is asked at the identifier, not at the caret — a caret at the end
  // of the last name in a block is exactly that block's `endIndex`, outside every scope it is in.
  const at = identifier.startIndex

  if (isMemberName(identifier)) {
    const member = memberFor(tree, file, identifier, at, ctx)
    if (member) return { ...member, viaObject: false, definedIn: member.file.name }

    const receiver = identifier.parent?.childForFieldName('expression')
    if (receiver?.type === 'identifier') {
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

  // A bare name inside a type may be a base type's member.
  const owner = enclosingType(tree, offset)
  if (owner) {
    const inherited = inHierarchy(owner, file, tree, identifier.text, at, ctx, undefined, new Set())
    if (inherited) return { ...inherited, viaObject: false, definedIn: inherited.file.name }
  }

  // A type named with no alias, declared in another tab — C#'s namespace rule approximated.
  const asType = typeNamed(identifier.text, file, tree, ctx, undefined)
  if (asType && asType.file.name !== file.name) {
    return {
      binding: asType.binding,
      viaObject: false,
      file: asType.file,
      definedIn: asType.file.name,
      // Nothing else on screen names it — a `using` imports the namespace, not the type — but the
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

export function resolveCSharpDefinition(
  active: CSharpFile,
  files: readonly CSharpFile[],
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
    // The declaration has no range here. Highlight whatever named it on screen and let `definedIn`
    // say where it really lives; without an anchor there is nothing honest to point at, which is
    // what the TypeScript resolver answers in the same case.
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
