/**
 * Java scopes and the names they bind.
 *
 * Pure: a tree-sitter tree in, a scope tree out. The same shape as python/scopes.ts, because the
 * resolver and the flow walk above it are written against that shape — but the rules are Java's,
 * and three of them are the opposite of Python's:
 *
 * - **A block is a scope.** `{ int t = 1; }` does not leak, where Python's `if` body does.
 * - **A class body is visible from its methods.** A method reads a field by bare name, where
 *   Python needs `self`. So the lookup walks *through* a class scope rather than skipping it.
 * - **Declaration precedes use** for locals, so the binding in force is the last one at or before
 *   the offset — there is no "assignment anywhere makes it local" rule to approximate.
 *
 * What Java adds instead is **overloading**, which is the one thing a binder without types cannot
 * settle. `lookupCall` narrows by arity, which is syntactic and usually decisive; where it is not,
 * the first declaration wins and the README says so.
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
  /** For a member: the type declaration it belongs to. */
  owner?: Node
  /** For a method: how many parameters it takes, so an overload can be narrowed by arity. */
  arity?: number
  /** True for a method or field declared `static`. */
  isStatic?: boolean
}

export type ScopeKind = 'unit' | 'type' | 'method' | 'block'

export interface Scope {
  kind: ScopeKind
  node: Node
  parent: Scope | null
  children: Scope[]
  bindings: Map<string, Binding[]>
  /** Members of a type — fields, methods, nested types — reached through `this`, an instance or
   *  the type's own name. Only on a `type` scope. */
  members: Map<string, Binding[]>
}

const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
])

/** Statements that hold a block of their own without being one. */
const BLOCKS = new Set([
  'block',
  'constructor_body',
  'for_statement',
  'enhanced_for_statement',
  'catch_clause',
  'try_with_resources_statement',
  'switch_block',
  'lambda_expression',
])

function newScope(kind: ScopeKind, node: Node, parent: Scope | null): Scope {
  const scope: Scope = {
    kind,
    node,
    parent,
    children: [],
    bindings: new Map(),
    members: new Map(),
  }
  parent?.children.push(scope)
  return scope
}

function add(into: Map<string, Binding[]>, binding: Binding): void {
  const existing = into.get(binding.name)
  if (existing) existing.push(binding)
  else into.set(binding.name, [binding])
}

/** The type declaration a scope sits in. */
function typeOf(scope: Scope): Scope | null {
  for (let s: Scope | null = scope; s; s = s.parent) if (s.kind === 'type') return s
  return null
}

function hasModifier(node: Node, word: string): boolean {
  const modifiers = node.namedChildren.find((child) => child?.type === 'modifiers')
  return modifiers ? modifiers.text.includes(word) : false
}

/** The identifier a parameter binds. */
function parameterName(node: Node): Node | null {
  const named = node.childForFieldName('name')
  if (named) return named
  return node.namedChildren.find((child) => child?.type === 'identifier') ?? null
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

  /**
   * A field, method or nested type belongs both to its scope and to the type's members.
   *
   * Both copies carry `owner`. A bare name read inside a method resolves through `bindings`, while
   * `this.x` resolves through `members` — and if only the second carried the owner, the first would
   * lose the dimmed type header that says which class the field belongs to.
   */
  const declare = (scope: Scope, binding: Binding, member: boolean): void => {
    const owner = member ? typeOf(scope) : null
    const withOwner = owner ? { ...binding, owner: owner.node } : binding
    add(scope.bindings, withOwner)
    if (owner) add(owner.members, withOwner)
  }

  const bindParameters = (list: Node | null, into: Scope): void => {
    for (const parameter of list?.namedChildren ?? []) {
      if (!parameter) continue
      // `inferred_parameters` is `(a, b) -> …`; its children are bare identifiers.
      if (parameter.type === 'identifier') {
        add(into.bindings, {
          name: parameter.text,
          nameNode: parameter,
          declNode: parameter,
          reason: 'parameter',
        })
        continue
      }
      const name = parameterName(parameter)
      if (!name) continue
      add(into.bindings, {
        name: name.text,
        nameNode: name,
        declNode: parameter,
        reason: 'parameter',
      })
    }
  }

  const visit = (node: Node, scope: Scope): void => {
    if (TYPE_DECLARATIONS.has(node.type)) {
      const name = node.childForFieldName('name')
      if (name) {
        declare(
          scope,
          { name: name.text, nameNode: name, declNode: node, reason: 'class' },
          scope.kind === 'type',
        )
      }
      const inner = open('type', node, scope)
      const body = node.childForFieldName('body')
      if (body) for (const child of body.namedChildren) if (child) visit(child, inner)
      // A record's header declares its components as fields.
      for (const parameter of node.childForFieldName('parameters')?.namedChildren ?? []) {
        const componentName = parameter && parameterName(parameter)
        if (!componentName) continue
        declare(
          inner,
          {
            name: componentName.text,
            nameNode: componentName,
            declNode: parameter,
            reason: 'property',
          },
          true,
        )
      }
      return
    }

    switch (node.type) {
      case 'method_declaration':
      case 'constructor_declaration':
      case 'compact_constructor_declaration': {
        const name = node.childForFieldName('name')
        const parameters = node.childForFieldName('parameters')
        if (name) {
          declare(
            scope,
            {
              name: name.text,
              nameNode: name,
              declNode: node,
              reason: 'function',
              arity: parameters?.namedChildren.filter((child) => child !== null).length ?? 0,
              isStatic: hasModifier(node, 'static'),
            },
            true,
          )
        }
        const inner = open('method', node, scope)
        bindParameters(parameters, inner)
        const body = node.childForFieldName('body')
        if (body) visit(body, inner)
        return
      }

      case 'lambda_expression': {
        const inner = open('block', node, scope)
        const parameters = node.childForFieldName('parameters')
        if (parameters?.type === 'identifier') {
          // `x -> …` with no parentheses.
          add(inner.bindings, {
            name: parameters.text,
            nameNode: parameters,
            declNode: parameters,
            reason: 'parameter',
          })
        } else {
          bindParameters(parameters, inner)
        }
        const body = node.childForFieldName('body')
        if (body) visit(body, inner)
        return
      }

      case 'field_declaration':
      case 'constant_declaration': {
        for (const declarator of node.namedChildren) {
          if (declarator?.type !== 'variable_declarator') continue
          const name = declarator.childForFieldName('name')
          if (!name) continue
          declare(
            scope,
            {
              name: name.text,
              nameNode: name,
              declNode: node,
              reason: 'property',
              isStatic: hasModifier(node, 'static'),
            },
            true,
          )
          const value = declarator.childForFieldName('value')
          if (value) visit(value, scope)
        }
        return
      }

      case 'local_variable_declaration': {
        for (const declarator of node.namedChildren) {
          if (declarator?.type !== 'variable_declarator') continue
          const name = declarator.childForFieldName('name')
          if (!name) continue
          add(scope.bindings, {
            name: name.text,
            nameNode: name,
            declNode: node,
            reason: 'variable',
          })
          const value = declarator.childForFieldName('value')
          if (value) visit(value, scope)
        }
        return
      }

      case 'enum_constant': {
        const name = node.childForFieldName('name')
        if (name) {
          declare(
            scope,
            { name: name.text, nameNode: name, declNode: node, reason: 'property' },
            true,
          )
        }
        return
      }

      case 'import_declaration': {
        // `import com.example.Db;` binds `Db`; a static or wildcard import binds nothing we can name.
        const scoped = node.namedChildren.find(
          (child) => child?.type === 'scoped_identifier' || child?.type === 'identifier',
        )
        if (!scoped || node.text.includes('*')) return
        const last = scoped.type === 'scoped_identifier' ? scoped.childForFieldName('name') : scoped
        if (last) {
          add(scope.bindings, {
            name: last.text,
            nameNode: last,
            declNode: node,
            reason: 'import',
          })
        }
        return
      }

      case 'catch_clause': {
        const inner = open('block', node, scope)
        const parameter = node.namedChildren.find(
          (child) => child?.type === 'catch_formal_parameter',
        )
        const name = parameter && parameterName(parameter)
        if (name && parameter) {
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

      case 'enhanced_for_statement': {
        const inner = open('block', node, scope)
        const name = node.childForFieldName('name')
        if (name) {
          add(inner.bindings, {
            name: name.text,
            nameNode: name,
            declNode: node,
            reason: 'binding',
          })
        }
        const value = node.childForFieldName('value')
        if (value) visit(value, scope)
        const body = node.childForFieldName('body')
        if (body) visit(body, inner)
        return
      }

      case 'resource': {
        const name = node.childForFieldName('name')
        if (name) {
          add(scope.bindings, {
            name: name.text,
            nameNode: name,
            declNode: node,
            reason: 'binding',
          })
        }
        const value = node.childForFieldName('value')
        if (value) visit(value, scope)
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
 * Which binding is in force at an offset: the last one at or before it, and failing that the first
 * in the scope. Java requires a local to be declared before it is used, so the first clause is
 * almost always the answer; the fallback covers a field, which a method may read above its own
 * declaration.
 */
function inForce(bindings: readonly Binding[], offset: number): Binding {
  let best: Binding | null = null
  for (const binding of bindings) {
    if (binding.nameNode.startIndex <= offset) best = binding
  }
  return best ?? bindings[0]!
}

/**
 * The binding a name resolves to from an offset.
 *
 * Unlike Python's, the walk goes *through* a type scope rather than skipping it: a method reads a
 * field by bare name. Nothing outside the open tabs resolves, which is the same principle `noLib`
 * buys on the TypeScript side — `String`, `System`, anything from `java.*` has no declaration here
 * and so reads as external.
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
 * The same lookup, narrowed by how many arguments a call supplies.
 *
 * This is the only answer to overloading a binder without types has, and it is usually enough:
 * `get(id)` and `get(id, opts)` differ in arity far more often than they differ only in parameter
 * type. Where arity does not separate them the first declaration wins, which the README states.
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
      return (byArity.length > 0 ? byArity : bindings)[0]!
    }
  }
  return null
}

/** A member declared on a type itself — no supertypes, which is definitions.ts's job since one may
 *  live in another tab. */
export function ownMemberOf(scope: Scope, name: string, offset: number): Binding | null {
  const members = scope.members.get(name)
  return members ? inForce(members, offset) : null
}

/** The names a type lists as supertypes, in the order written. */
export function superTypeNames(scope: Scope): Node[] {
  if (scope.kind !== 'type') return []
  const found: Node[] = []
  for (const field of ['superclass', 'interfaces']) {
    const holder = scope.node.childForFieldName(field)
    if (!holder) continue
    const collect = (node: Node) => {
      if (node.type === 'type_identifier') {
        found.push(node)
        return
      }
      for (const child of node.namedChildren) if (child) collect(child)
    }
    collect(holder)
  }
  return found
}

/** The type declaration an offset sits in, if any — how `this.x` and a bare field name find it. */
export function enclosingType(tree: ScopeTree, offset: number): Scope | null {
  return typeOf(scopeAt(tree, offset))
}

/** The scope a type declaration opened. */
export function scopeForNode(tree: ScopeTree, node: Node): Scope | null {
  return tree.all.find((scope) => scope.node.id === node.id) ?? null
}
