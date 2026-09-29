/**
 * C and C++ scopes and the names they bind.
 *
 * Pure: a tree-sitter tree in, a scope tree out — the same shape python/scopes.ts and
 * java/scopes.ts produce, because the resolver above is written against that shape. The rules are
 * C's, and four of them are worth stating because a reader arriving from the other three languages
 * will expect otherwise:
 *
 * - **A declarator nests around its name.** `char *argv[]` is an array of a pointer to an
 *   identifier, and the name is at the bottom of that chain — so nothing here reads
 *   `childForFieldName('name')` the way the Java binder does. `declaratorName` walks down instead.
 * - **A namespace opens no scope.** It should, and C++ says it does — but every name in a
 *   single-namespace file would then be invisible from the translation unit, which is what a
 *   cross-file lookup starts from. Descending with the same scope over-approximates in the one
 *   direction that costs nothing here and keeps the common file shape working.
 * - **Both arms of a `#if` are bound.** tree-sitter parses the preprocessor structurally and
 *   expands nothing, so a name defined in either branch is in the tree and is bound. That is the
 *   same may-analysis over-approximation the trace makes elsewhere, and the honest one: refusing
 *   to resolve a name because it sits under an `#ifdef` would be a silent miss.
 * - **A macro is a binding.** `#define MAX 16` is the closest thing C has to a constant, and a
 *   reader clicking `MAX` wants the `#define`. It is bound as a `variable` (or a `function`, for a
 *   function-like macro) because `DefinitionReason` is a shared vocabulary that reaches the panes
 *   and is not extended for one language.
 *
 * What is emphatically *not* modelled is macro **expansion**. A name a macro produces exists
 * nowhere in the tree, so it does not resolve — stated, rather than guessed at.
 */
import type { Node } from '@vscode/tree-sitter-wasm'
import type { DefinitionReason } from '../definitions'

export interface Binding {
  name: string
  /** The identifier that binds the name — where the caret rule points. */
  nameNode: Node
  /** The whole declaration, which is what gets a span. */
  declNode: Node
  reason: DefinitionReason
  /** For a member: the struct, union or class declaration it belongs to. */
  owner?: Node
  /** For a function: how many parameters it takes, so an overload can be narrowed by arity. */
  arity?: number
}

export type ScopeKind = 'unit' | 'type' | 'function' | 'block'

export interface Scope {
  kind: ScopeKind
  node: Node
  parent: Scope | null
  children: Scope[]
  bindings: Map<string, Binding[]>
  /** Fields and methods of a struct, union or class. Only on a `type` scope. */
  members: Map<string, Binding[]>
}

/** Declarations that introduce a type with a body worth walking. */
const TYPE_SPECIFIERS = new Set(['struct_specifier', 'union_specifier', 'class_specifier'])

/** Nodes that hold a scope of their own. A C block is a scope, as Java's is. */
const BLOCKS = new Set([
  'compound_statement',
  'for_statement',
  'for_range_loop',
  'catch_clause',
  'lambda_expression',
])

/** Wrappers a declarator nests inside on the way down to its identifier. */
const DECLARATOR_WRAPPERS = new Set([
  'init_declarator',
  'pointer_declarator',
  'array_declarator',
  'function_declarator',
  'reference_declarator',
  'parenthesized_declarator',
  'attributed_declarator',
])

const NAME_NODES = new Set(['identifier', 'type_identifier', 'field_identifier'])

/**
 * The identifier a declarator finally names.
 *
 * `char *argv[]` parses as an array declarator around a pointer declarator around the name, and an
 * out-of-line C++ method is `Widget::Set`, whose name is the second half. Both are handled by
 * walking down rather than by asking any one node for a `name` field.
 */
export function declaratorName(node: Node | null): Node | null {
  let current: Node | null = node
  for (let guard = 0; current && guard < 32; guard++) {
    if (NAME_NODES.has(current.type)) return current
    if (current.type === 'qualified_identifier') {
      const inner = current.childForFieldName('name')
      if (!inner) return null
      current = inner
      continue
    }
    if (!DECLARATOR_WRAPPERS.has(current.type)) return null
    current =
      current.childForFieldName('declarator') ??
      current.namedChildren.find(
        (child): child is Node => child !== null && child.type !== 'type',
      ) ??
      null
  }
  return null
}

/** The `function_declarator` inside a declarator chain, which is what carries the parameters. */
function functionDeclarator(node: Node | null): Node | null {
  let current: Node | null = node
  for (let guard = 0; current && guard < 32; guard++) {
    if (current.type === 'function_declarator') return current
    if (!DECLARATOR_WRAPPERS.has(current.type)) return null
    current = current.childForFieldName('declarator')
  }
  return null
}

function newScope(kind: ScopeKind, node: Node, parent: Scope | null): Scope {
  const scope: Scope = { kind, node, parent, children: [], bindings: new Map(), members: new Map() }
  parent?.children.push(scope)
  return scope
}

function add(into: Map<string, Binding[]>, binding: Binding): void {
  const existing = into.get(binding.name)
  if (existing) existing.push(binding)
  else into.set(binding.name, [binding])
}

function typeOf(scope: Scope): Scope | null {
  for (let s: Scope | null = scope; s; s = s.parent) if (s.kind === 'type') return s
  return null
}

export interface ScopeTree {
  root: Scope
  all: Scope[]
}

export function buildScopes(root: Node): ScopeTree {
  const unit = newScope('unit', root, null)
  const all: Scope[] = [unit]

  const open = (kind: ScopeKind, node: Node, parent: Scope): Scope => {
    const scope = newScope(kind, node, parent)
    all.push(scope)
    return scope
  }

  /** A field or method belongs both to its scope and to the type's members — see java/scopes.ts on
   *  why both copies carry `owner`. */
  const declare = (scope: Scope, binding: Binding, member: boolean): void => {
    const owner = member ? typeOf(scope) : null
    const withOwner = owner ? { ...binding, owner: owner.node } : binding
    add(scope.bindings, withOwner)
    if (owner) add(owner.members, withOwner)
  }

  const bindParameters = (declarator: Node | null, into: Scope): void => {
    const parameters = functionDeclarator(declarator)?.childForFieldName('parameters')
    for (const parameter of parameters?.namedChildren ?? []) {
      if (!parameter) continue
      const name = declaratorName(parameter.childForFieldName('declarator'))
      if (!name) continue
      add(into.bindings, {
        name: name.text,
        nameNode: name,
        declNode: parameter,
        reason: 'parameter',
      })
    }
  }

  const countParameters = (declarator: Node | null): number => {
    const parameters = functionDeclarator(declarator)?.childForFieldName('parameters')
    return (parameters?.namedChildren ?? []).filter((child) => child !== null).length
  }

  const visit = (node: Node, scope: Scope): void => {
    if (TYPE_SPECIFIERS.has(node.type)) {
      const name = node.childForFieldName('name')
      if (name) {
        declare(
          scope,
          { name: name.text, nameNode: name, declNode: node, reason: 'class' },
          scope.kind === 'type',
        )
      }
      const body = node.childForFieldName('body')
      if (body) {
        const inner = open('type', node, scope)
        for (const child of body.namedChildren) if (child) visit(child, inner)
      }
      return
    }

    switch (node.type) {
      case 'enum_specifier': {
        const name = node.childForFieldName('name')
        if (name) {
          declare(
            scope,
            { name: name.text, nameNode: name, declNode: node, reason: 'class' },
            scope.kind === 'type',
          )
        }
        // An unscoped enum puts its constants in the *enclosing* scope, which is the whole point of
        // one in C: `RED` is written bare. `owner` still names the enum, so the pane dims its
        // header the way it does for a struct field.
        for (const enumerator of node.childForFieldName('body')?.namedChildren ?? []) {
          const constant = enumerator?.childForFieldName('name')
          if (!constant || !enumerator) continue
          add(scope.bindings, {
            name: constant.text,
            nameNode: constant,
            declNode: enumerator,
            reason: 'property',
            owner: node,
          })
        }
        return
      }

      case 'type_definition': {
        for (const child of node.namedChildren) {
          if (child?.type === 'type') continue
          if (child) visit(child, scope)
        }
        const alias = declaratorName(node.childForFieldName('declarator'))
        if (alias) {
          declare(
            scope,
            { name: alias.text, nameNode: alias, declNode: node, reason: 'class' },
            scope.kind === 'type',
          )
        }
        return
      }

      case 'function_definition': {
        const declarator = node.childForFieldName('declarator')
        const name = declaratorName(declarator)
        if (name) {
          declare(
            scope,
            {
              name: name.text,
              nameNode: name,
              declNode: node,
              reason: 'function',
              arity: countParameters(declarator),
            },
            scope.kind === 'type',
          )
        }
        const inner = open('function', node, scope)
        bindParameters(declarator, inner)
        // A constructor's `: name_(n)` initialiser list reads the parameters, so it belongs inside.
        for (const child of node.namedChildren) {
          if (child && child.type !== 'type' && child.id !== declarator?.id) visit(child, inner)
        }
        return
      }

      case 'declaration': {
        // One `type` shared by every declarator: `int a, *b;`.
        for (const child of node.namedChildren) {
          if (!child) continue
          if (child.type === 'init_declarator') {
            const value = child.childForFieldName('value')
            if (value) visit(value, scope)
          }
          const name = declaratorName(child)
          if (!name) continue
          // A prototype — `int add(int, int);` — declares a function, not a variable.
          const isFunction = functionDeclarator(child) !== null
          declare(
            scope,
            {
              name: name.text,
              nameNode: name,
              declNode: node,
              reason: isFunction ? 'function' : 'variable',
              arity: isFunction ? countParameters(child) : undefined,
            },
            scope.kind === 'type',
          )
        }
        return
      }

      case 'field_declaration': {
        for (const child of node.namedChildren) {
          if (!child || child.type === 'type') continue
          const name = declaratorName(child)
          if (!name) continue
          declare(
            scope,
            {
              name: name.text,
              nameNode: name,
              declNode: node,
              reason: functionDeclarator(child) ? 'function' : 'property',
              arity: functionDeclarator(child) ? countParameters(child) : undefined,
            },
            true,
          )
        }
        return
      }

      case 'preproc_def': {
        const name = node.childForFieldName('name')
        if (name) {
          add(scope.bindings, {
            name: name.text,
            nameNode: name,
            declNode: node,
            reason: 'variable',
          })
        }
        return
      }

      case 'preproc_function_def': {
        const name = node.childForFieldName('name')
        const parameters = node.childForFieldName('parameters')
        if (name) {
          add(scope.bindings, {
            name: name.text,
            nameNode: name,
            declNode: node,
            reason: 'function',
            arity: (parameters?.namedChildren ?? []).filter((child) => child !== null).length,
          })
        }
        return
      }

      case 'namespace_definition': {
        // Deliberately no scope of its own — see the header.
        const body = node.childForFieldName('body')
        if (body) for (const child of body.namedChildren) if (child) visit(child, scope)
        return
      }

      case 'template_declaration': {
        for (const parameter of node.childForFieldName('parameters')?.namedChildren ?? []) {
          const name = parameter?.namedChildren.find((child) => child?.type === 'type_identifier')
          if (!name || !parameter) continue
          add(scope.bindings, {
            name: name.text,
            nameNode: name,
            declNode: parameter,
            reason: 'class',
          })
        }
        for (const child of node.namedChildren) {
          if (child && child.type !== 'template_parameter_list') visit(child, scope)
        }
        return
      }

      case 'for_range_loop': {
        const inner = open('block', node, scope)
        const name = declaratorName(node.childForFieldName('declarator'))
        if (name) {
          add(inner.bindings, {
            name: name.text,
            nameNode: name,
            declNode: node,
            reason: 'binding',
          })
        }
        const right = node.childForFieldName('right')
        if (right) visit(right, scope)
        const body = node.childForFieldName('body')
        if (body) visit(body, inner)
        return
      }

      case 'catch_clause': {
        const inner = open('block', node, scope)
        for (const parameter of node.childForFieldName('parameters')?.namedChildren ?? []) {
          const name = declaratorName(parameter?.childForFieldName('declarator') ?? null)
          if (!name || !parameter) continue
          add(inner.bindings, {
            name: name.text,
            nameNode: name,
            declNode: parameter,
            reason: 'binding',
          })
        }
        const body = node.childForFieldName('body')
        if (body) visit(body, inner)
        return
      }

      default: {
        if (BLOCKS.has(node.type)) {
          const inner = open('block', node, scope)
          for (const child of node.namedChildren) if (child) visit(child, inner)
          return
        }
        for (const child of node.namedChildren) if (child) visit(child, scope)
      }
    }
  }

  for (const child of root.namedChildren) if (child) visit(child, unit)
  return { root: unit, all }
}

/** The innermost scope holding an offset. */
export function scopeAt(tree: ScopeTree, offset: number): Scope {
  let found = tree.root
  for (const scope of tree.all) {
    if (offset < scope.node.startIndex || offset >= scope.node.endIndex) continue
    if (scope.node.startIndex >= found.node.startIndex) found = scope
  }
  return found
}

/**
 * Which binding is in force at an offset: the last one at or before it, else the first in the
 * scope. C requires a declaration before use, so the first clause is almost always the answer; the
 * fallback covers a struct field, which a C++ method may read above its own declaration.
 */
function inForce(bindings: readonly Binding[], offset: number): Binding {
  let best: Binding | null = null
  for (const binding of bindings) {
    if (binding.nameNode.startIndex <= offset) best = binding
  }
  return best ?? bindings[0]!
}

/**
 * The binding a name resolves to from an offset. Nothing outside the open tabs resolves, which is
 * the same principle `noLib` buys on the TypeScript side — `printf`, `size_t` and anything from a
 * system header have no declaration here and so read as external.
 */
export function lookup(tree: ScopeTree, name: string, offset: number): Binding | null {
  for (let scope: Scope | null = scopeAt(tree, offset); scope; scope = scope.parent) {
    const bindings = scope.bindings.get(name)
    if (bindings) return inForce(bindings, offset)
    if (scope.kind === 'type') {
      const members = scope.members.get(name)
      if (members) return inForce(members, offset)
    }
  }
  return null
}

/**
 * The same lookup narrowed by argument count — C++ overloads, and a prototype standing beside its
 * definition. Where arity does not separate them the first declaration wins, as Java's does.
 */
export function lookupCall(
  tree: ScopeTree,
  name: string,
  offset: number,
  argumentCount: number,
): Binding | null {
  for (let scope: Scope | null = scopeAt(tree, offset); scope; scope = scope.parent) {
    for (const table of [scope.bindings, scope.kind === 'type' ? scope.members : null]) {
      const bindings = table?.get(name)
      if (!bindings) continue
      const byArity = bindings.filter(
        (binding) => binding.arity === undefined || binding.arity === argumentCount,
      )
      // A definition says more than a prototype, so prefer one where both are open.
      const candidates = byArity.length > 0 ? byArity : bindings
      return (
        candidates.find((binding) => binding.declNode.type === 'function_definition') ??
        candidates[0]!
      )
    }
  }
  return null
}

/** A member declared on a type itself — no base classes, which is definitions.ts's job since one
 *  may live in another tab. */
export function ownMemberOf(scope: Scope, name: string, offset: number): Binding | null {
  const members = scope.members.get(name)
  return members ? inForce(members, offset) : null
}

/** The names a C++ class lists as base classes, in the order written. */
export function baseTypeNames(scope: Scope): Node[] {
  if (scope.kind !== 'type') return []
  const clause = scope.node.namedChildren.find((child) => child?.type === 'base_class_clause')
  if (!clause) return []
  return clause.namedChildren.filter(
    (child): child is Node => child !== null && child.type === 'type_identifier',
  )
}

/** The type declaration an offset sits in — how a bare field name in a C++ method finds it. */
export function enclosingType(tree: ScopeTree, offset: number): Scope | null {
  return typeOf(scopeAt(tree, offset))
}

/** The scope a type declaration opened. */
export function scopeForNode(tree: ScopeTree, node: Node): Scope | null {
  return tree.all.find((scope) => scope.node.id === node.id) ?? null
}
