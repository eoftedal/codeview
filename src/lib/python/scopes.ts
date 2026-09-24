/**
 * Python scopes and the names they bind.
 *
 * Pure: a tree-sitter tree in, a scope tree out, with no I/O and no browser. Two passes, and the
 * split is what makes one of Python's rules fall out structurally instead of needing a special
 * case: everything a scope binds is collected before any lookup runs, so a name assigned on line 9
 * is already local when it is read on line 2. That is what Python means by "an assignment anywhere
 * in a function makes the name local throughout it".
 *
 * The rules a reader arriving from TypeScript gets wrong, all of them deliberate here:
 *
 * - `if`, `for`, `while`, `with` and `try` are **not** scopes. A name bound inside one is visible
 *   after it.
 * - A **class body is skipped** by any lookup from inside a nested function. A method reaches a
 *   class attribute through `self`, never by bare name.
 * - A **comprehension is** a scope of its own, so its target does not leak.
 *
 * Nothing outside the open files resolves, and that is the same principle the TypeScript side gets
 * from `noLib`: builtins — `print`, `len`, `open` — deliberately have no definition, so an
 * unresolvable name *is* one that came from outside. There is no list of interesting globals.
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
  /** For a `property`: the class body it belongs to, so the header can be dimmed underneath. */
  owner?: Node
}

export type ScopeKind = 'module' | 'function' | 'class' | 'comprehension'

export interface Scope {
  kind: ScopeKind
  node: Node
  parent: Scope | null
  children: Scope[]
  /** Several bindings may share a name — `x` assigned twice, a conditional import. */
  bindings: Map<string, Binding[]>
  /** Names this scope redirects to the module scope. */
  globals: Set<string>
  /** Names this scope redirects to the nearest enclosing function scope that binds them. */
  nonlocals: Set<string>
  /** Attributes set on `self` inside this class, by name. Only on a `class` scope. */
  attributes: Map<string, Binding[]>
}

const COMPREHENSIONS = new Set([
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
])

function newScope(kind: ScopeKind, node: Node, parent: Scope | null): Scope {
  const scope: Scope = {
    kind,
    node,
    parent,
    children: [],
    bindings: new Map(),
    globals: new Set(),
    nonlocals: new Set(),
    attributes: new Map(),
  }
  parent?.children.push(scope)
  return scope
}

function add(into: Map<string, Binding[]>, binding: Binding): void {
  const existing = into.get(binding.name)
  if (existing) existing.push(binding)
  else into.set(binding.name, [binding])
}

/** The class a scope sits in, looking through the method that is usually between them. */
function classOf(scope: Scope): Scope | null {
  for (let s: Scope | null = scope; s; s = s.parent) if (s.kind === 'class') return s
  return null
}

/**
 * Every identifier a target pattern binds. `a, b = …` binds two; `*rest` binds one; `o.x = …` and
 * `xs[i] = …` bind none — the first is an attribute (handled separately) and the second mutates
 * something already bound.
 */
function* targets(node: Node | null): Generator<Node> {
  if (!node) return
  switch (node.type) {
    case 'identifier':
      yield node
      return
    case 'pattern_list':
    case 'tuple_pattern':
    case 'list_pattern':
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern':
    case 'parenthesized_expression':
    case 'tuple':
    case 'list':
    case 'as_pattern_target':
      for (const child of node.namedChildren) if (child) yield* targets(child)
      return
    default:
      return
  }
}

/** The identifier a parameter binds, whatever shape the parameter takes. */
function parameterName(node: Node): Node | null {
  switch (node.type) {
    case 'identifier':
      return node
    case 'default_parameter':
    case 'typed_default_parameter':
      return node.childForFieldName('name')
    case 'typed_parameter':
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern':
      return node.namedChildren.find((child) => child?.type === 'identifier') ?? null
    default:
      return null
  }
}

/** `self.x = …` inside a method — the one attribute form that is a binding rather than a read. */
function selfAttribute(left: Node): Node | null {
  if (left.type !== 'attribute') return null
  const object = left.childForFieldName('object')
  return object?.type === 'identifier' && object.text === 'self'
    ? left.childForFieldName('attribute')
    : null
}

export interface ScopeTree {
  root: Scope
  /** Every scope, innermost last, so a lookup can take the last one containing an offset. */
  all: Scope[]
}

export function buildScopes(root: Node): ScopeTree {
  const module = newScope('module', root, null)
  const all: Scope[] = [module]

  const open = (kind: ScopeKind, node: Node, parent: Scope): Scope => {
    const scope = newScope(kind, node, parent)
    all.push(scope)
    return scope
  }

  const bindTargets = (node: Node | null, decl: Node, scope: Scope, reason: DefinitionReason) => {
    for (const name of targets(node)) {
      add(scope.bindings, { name: name.text, nameNode: name, declNode: decl, reason })
    }
  }

  const visit = (node: Node, scope: Scope): void => {
    switch (node.type) {
      case 'function_definition':
      case 'lambda': {
        if (node.type === 'function_definition') {
          const name = node.childForFieldName('name')
          // The name belongs to the scope the `def` sits in; the parameters and body do not.
          if (name) {
            add(scope.bindings, {
              name: name.text,
              nameNode: name,
              declNode: node,
              reason: 'function',
            })
          }
        }
        const inner = open('function', node, scope)
        const parameters = node.childForFieldName('parameters')
        for (const parameter of parameters?.namedChildren ?? []) {
          if (!parameter) continue
          const name = parameterName(parameter)
          if (!name) continue
          add(inner.bindings, {
            name: name.text,
            nameNode: name,
            // A bare `identifier` parameter is its own declaration; the richer forms carry the
            // annotation and the default, which belong in the highlight.
            declNode: parameter.type === 'identifier' ? name : parameter,
            reason: 'parameter',
          })
          // A default value is evaluated in the *enclosing* scope, not the function's.
          const fallback = parameter.childForFieldName('value')
          if (fallback) visit(fallback, scope)
        }
        const body = node.childForFieldName('body')
        if (body) visit(body, inner)
        return
      }

      case 'class_definition': {
        const name = node.childForFieldName('name')
        if (name) {
          add(scope.bindings, { name: name.text, nameNode: name, declNode: node, reason: 'class' })
        }
        // Base classes are named in the enclosing scope.
        const bases = node.childForFieldName('superclasses')
        if (bases) visit(bases, scope)
        const inner = open('class', node, scope)
        const body = node.childForFieldName('body')
        if (body) visit(body, inner)
        return
      }

      case 'assignment':
      case 'augmented_assignment': {
        const left = node.childForFieldName('left')
        const attribute = left ? selfAttribute(left) : null
        if (attribute) {
          // `self.x = …`: an attribute of the class, not a name in the method.
          const owner = classOf(scope)
          if (owner) {
            add(owner.attributes, {
              name: attribute.text,
              nameNode: attribute,
              declNode: node,
              reason: 'property',
              owner: owner.node,
            })
          }
        } else if (left) {
          // A class body's own names are the class's attributes as well as its scope's.
          const reason: DefinitionReason =
            left.type === 'identifier'
              ? scope.kind === 'class'
                ? 'property'
                : 'variable'
              : 'binding'
          bindTargets(left, node, scope, reason)
          if (scope.kind === 'class') {
            for (const name of targets(left)) {
              add(scope.attributes, {
                name: name.text,
                nameNode: name,
                declNode: node,
                reason: 'property',
                owner: scope.node,
              })
            }
          }
        }
        const right = node.childForFieldName('right')
        if (right) visit(right, scope)
        return
      }

      case 'named_expression': {
        const name = node.childForFieldName('name')
        if (name) {
          add(scope.bindings, {
            name: name.text,
            nameNode: name,
            declNode: node,
            reason: 'variable',
          })
        }
        const value = node.childForFieldName('value')
        if (value) visit(value, scope)
        return
      }

      case 'import_statement':
      case 'import_from_statement': {
        for (const child of node.namedChildren) {
          if (!child) continue
          if (child.type === 'aliased_import') {
            const alias = child.childForFieldName('alias')
            if (alias) {
              add(scope.bindings, {
                name: alias.text,
                nameNode: alias,
                declNode: node,
                reason: 'import',
              })
            }
          } else if (child.type === 'dotted_name') {
            // `import a.b` binds `a`, not `b` — Python binds the top package. In a `from` the
            // dotted name under `module_name` is the module, not a binding.
            if (child === node.childForFieldName('module_name')) continue
            const first = child.namedChildren[0]
            const bound = node.type === 'import_statement' ? first : child.namedChildren.at(-1)
            if (bound) {
              add(scope.bindings, {
                name: bound.text,
                nameNode: bound,
                declNode: node,
                reason: 'import',
              })
            }
          }
          // `wildcard_import` binds nothing we can see — a stated limit, not an oversight.
        }
        return
      }

      case 'for_statement': {
        bindTargets(node.childForFieldName('left'), node, scope, 'binding')
        for (const child of node.namedChildren) {
          if (child && child !== node.childForFieldName('left')) visit(child, scope)
        }
        return
      }

      case 'as_pattern': {
        // `with … as h` and `except … as e`. The alias is the binding; what precedes it is a read.
        const alias = node.childForFieldName('alias')
        bindTargets(alias, node, scope, 'binding')
        for (const child of node.namedChildren) if (child && child !== alias) visit(child, scope)
        return
      }

      case 'global_statement':
      case 'nonlocal_statement': {
        const into = node.type === 'global_statement' ? scope.globals : scope.nonlocals
        for (const child of node.namedChildren)
          if (child?.type === 'identifier') into.add(child.text)
        return
      }

      default: {
        if (COMPREHENSIONS.has(node.type)) {
          // A comprehension has a scope of its own, so its target does not leak into the enclosing
          // one. The first clause's iterable is evaluated outside it; close enough that the
          // difference has never mattered to a reader.
          const inner = open('comprehension', node, scope)
          for (const child of node.namedChildren) if (child) visit(child, inner)
          return
        }
        if (node.type === 'for_in_clause') {
          bindTargets(node.childForFieldName('left'), node, scope, 'binding')
          const right = node.childForFieldName('right')
          if (right) visit(right, scope)
          return
        }
        for (const child of node.namedChildren) if (child) visit(child, scope)
      }
    }
  }

  for (const child of root.namedChildren) if (child) visit(child, module)
  return { root: module, all }
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
 * Which of a scope's bindings for a name is the one in force at an offset: the last binding at or
 * before it, and failing that the first in the scope.
 *
 * The fallback is not a rounding error — a helper that reads a name at the top and assigns it at
 * the bottom is legal Python, and the name is local throughout. This approximates shadowing in
 * time, which a static reading of a dynamic language can only ever approximate; the README says so.
 */
function inForce(bindings: readonly Binding[], offset: number): Binding {
  let best: Binding | null = null
  for (const binding of bindings) {
    if (binding.nameNode.startIndex <= offset) best = binding
  }
  return best ?? bindings[0]!
}

/** The module scope at the top of a chain. */
function moduleOf(scope: Scope): Scope {
  let current = scope
  while (current.parent) current = current.parent
  return current
}

/**
 * The binding a name resolves to from an offset, or null when nothing open declares it.
 *
 * The walk is local scope first, then every enclosing scope *except* class scopes, then the module.
 * `global` and `nonlocal` are redirects rather than bindings and jump the chain.
 */
export function lookup(tree: ScopeTree, name: string, offset: number): Binding | null {
  const from = scopeAt(tree, offset)

  for (let scope: Scope | null = from; scope; scope = scope.parent) {
    if (scope.globals.has(name)) {
      const module = moduleOf(scope)
      const bindings = module.bindings.get(name)
      return bindings ? inForce(bindings, offset) : declaredOnly(scope, name)
    }
    if (scope.nonlocals.has(name)) {
      for (let outer = scope.parent; outer; outer = outer.parent) {
        if (outer.kind !== 'function') continue
        const bindings = outer.bindings.get(name)
        if (bindings) return inForce(bindings, offset)
      }
      return declaredOnly(scope, name)
    }
    // A class body is visible to the code written directly in it, and to nothing nested inside.
    if (scope.kind === 'class' && scope !== from) continue
    const bindings = scope.bindings.get(name)
    if (bindings) return inForce(bindings, offset)
  }
  return null
}

/**
 * A `global x` or `nonlocal x` with nothing anywhere to bind it. The statement is the only
 * declaration there is, so it is the honest answer rather than null.
 */
function declaredOnly(scope: Scope, name: string): Binding | null {
  const statement = findDeclaration(scope.node, name)
  return statement
    ? { name, nameNode: statement, declNode: statement.parent ?? statement, reason: 'other' }
    : null
}

function findDeclaration(node: Node, name: string): Node | null {
  if (node.type === 'global_statement' || node.type === 'nonlocal_statement') {
    for (const child of node.namedChildren) if (child?.text === name) return child
  }
  for (const child of node.namedChildren) {
    if (!child) continue
    const found = findDeclaration(child, name)
    if (found) return found
  }
  return null
}

/** An attribute declared on a class itself — no bases, which is `definitions.ts`'s job since a base
 *  may live in another tab. `self.x` and `C.x` both land here. */
export function ownAttributeOf(scope: Scope, name: string, offset: number): Binding | null {
  const bindings = scope.attributes.get(name)
  if (bindings) return inForce(bindings, offset)
  // A method is an attribute too, and lives in the class's ordinary bindings.
  const own = scope.bindings.get(name)
  return own ? inForce(own, offset) : null
}

/**
 * The names a class lists as bases, in the order written.
 *
 * Only bare identifiers: a dotted base (`models.Model`) needs the module resolved first and is
 * almost always external anyway, and a keyword argument (`metaclass=…`) is not a base at all.
 * Resolution order is depth-first, left to right — an approximation of Python's C3 linearization
 * that agrees with it for every hierarchy without diamonds.
 */
export function baseNames(scope: Scope): Node[] {
  if (scope.kind !== 'class') return []
  const bases = scope.node.childForFieldName('superclasses')
  return (bases?.namedChildren ?? []).filter((base): base is Node => base?.type === 'identifier')
}

/** The class scope a node sits in, if any — how `self.x` finds its class. */
export function enclosingClass(tree: ScopeTree, offset: number): Scope | null {
  return classOf(scopeAt(tree, offset))
}

/** The class scope a `class_definition` node opened, for resolving `C.x` from outside. */
export function scopeForNode(tree: ScopeTree, node: Node): Scope | null {
  return tree.all.find((scope) => scope.node.id === node.id) ?? null
}
