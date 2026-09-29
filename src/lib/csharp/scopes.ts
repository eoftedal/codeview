/**
 * C# scopes and the names they bind.
 *
 * Pure: a tree-sitter tree in, a scope tree out, the same shape the other three binders produce.
 * Of the four languages this is the closest to java/scopes.ts — a block is a scope, a class body is
 * visible from its methods, declaration precedes use, and overloads are narrowed by arity — so what
 * is worth writing down is only where it differs, and every difference below was a wrong answer
 * first:
 *
 * - **A `using` binds nothing.** Java's `import com.example.Db` names one type, so it binds `Db`.
 *   C#'s `using Shop.Data;` imports a whole *namespace* and names no type at all, which is why
 *   cross-file resolution here rests entirely on the open-tabs rule in definitions.ts. Only an
 *   alias — `using Item = Shop.Data.Item;` — binds a name, and it is bound as an import.
 * - **A namespace opens no scope**, for the reason c/scopes.ts gives: a type in a single-namespace
 *   file would otherwise be invisible from the compilation unit, which is where a cross-file lookup
 *   starts.
 * - **A declarator holds its initializer as a bare child.** C# has no `value` field on a
 *   `variable_declarator`, and a `field_declaration` wraps a `variable_declaration` that wraps the
 *   declarator — two levels more than Java. `declaratorValue` is the one place that knows.
 * - **A primary constructor's parameters are in scope for the whole body.** On a `record` they are
 *   also public properties, which is what makes `id.Value` resolvable; on a `class` or `struct`
 *   they are parameters the body may capture.
 * - **A property is storage, not a method.** An auto-property has no body to walk, so the property
 *   *is* the member — which makes the wrapper case simpler here than the hand-written Java getter
 *   it corresponds to.
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
  /** True for a member declared `static`. */
  isStatic?: boolean
}

export type ScopeKind = 'unit' | 'type' | 'method' | 'block'

export interface Scope {
  kind: ScopeKind
  node: Node
  parent: Scope | null
  children: Scope[]
  bindings: Map<string, Binding[]>
  /** Members of a type — fields, properties, methods, nested types — reached through `this`, an
   *  instance or the type's own name. Only on a `type` scope. */
  members: Map<string, Binding[]>
}

const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'struct_declaration',
  'interface_declaration',
  'record_declaration',
  'record_struct_declaration',
  'enum_declaration',
])

/** Members that open a scope of their own and bind parameters into it. */
const METHODS = new Set([
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'local_function_statement',
])

/** Nodes that hold a scope without being a method. */
const BLOCKS = new Set([
  'block',
  'for_statement',
  'while_statement',
  'using_statement',
  'switch_section',
  'lambda_expression',
  'anonymous_method_expression',
  'accessor_declaration',
])

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

function hasModifier(node: Node, word: string): boolean {
  return node.namedChildren.some((child) => child?.type === 'modifier' && child.text === word)
}

/**
 * The value a `variable_declarator` initialises its name with.
 *
 * C# exposes no `value` field here: the grammar's equals-value clause is hidden, so the expression
 * is simply the declarator's last named child. The `name` and an indexer's `bracketed_argument_list`
 * are the two things it is not.
 */
export function declaratorValue(declarator: Node): Node | null {
  const name = declarator.childForFieldName('name')
  for (let i = declarator.namedChildCount - 1; i >= 0; i--) {
    const child = declarator.namedChild(i)
    if (!child || child.id === name?.id) continue
    if (child.type === 'bracketed_argument_list') continue
    return child
  }
  return null
}

/** The `variable_declarator`s under a field or local declaration, through the
 *  `variable_declaration` that wraps them. */
export function declaratorsOf(declaration: Node): Node[] {
  const holder =
    declaration.type === 'variable_declaration'
      ? declaration
      : (declaration.namedChildren.find((child) => child?.type === 'variable_declaration') ?? null)
  if (!holder) return []
  return holder.namedChildren.filter(
    (child): child is Node => child !== null && child.type === 'variable_declarator',
  )
}

/**
 * The parameter list a primary constructor is written with — `class Svc(IRepo repo)` and every
 * positional record. It carries no field name of its own, unlike a method's, so it can only be
 * found by type — and the guard below is load-bearing: a `method_declaration` also holds a
 * `parameter_list` child, so without it every method parameter would be read as a primary
 * constructor's and sent looking for constructions of the method's own name.
 */
export function primaryParameters(declaration: Node): Node[] {
  if (!TYPE_DECLARATIONS.has(declaration.type)) return []
  const list = declaration.namedChildren.find((child) => child?.type === 'parameter_list')
  return (list?.namedChildren ?? []).filter(
    (child): child is Node => child !== null && child.type === 'parameter',
  )
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

  /** A member belongs both to its scope and to the type's members — see java/scopes.ts on why both
   *  copies carry `owner`. */
  const declare = (scope: Scope, binding: Binding, member: boolean): void => {
    const owner = member ? typeOf(scope) : null
    const withOwner = owner ? { ...binding, owner: owner.node } : binding
    add(scope.bindings, withOwner)
    if (owner) add(owner.members, withOwner)
  }

  const bindParameters = (list: Node | null, into: Scope): void => {
    for (const parameter of list?.namedChildren ?? []) {
      if (!parameter) continue
      // `(a, b) => …` with no types: the parameters are bare identifiers.
      if (parameter.type === 'identifier' || parameter.type === 'implicit_parameter') {
        add(into.bindings, {
          name: parameter.text,
          nameNode: parameter,
          declNode: parameter,
          reason: 'parameter',
        })
        continue
      }
      const name = parameter.childForFieldName('name')
      if (!name) continue
      add(into.bindings, {
        name: name.text,
        nameNode: name,
        declNode: parameter,
        reason: 'parameter',
      })
    }
  }

  const countParameters = (list: Node | null): number =>
    (list?.namedChildren ?? []).filter((child) => child !== null).length

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

      // A positional record's components *are* public properties; a class or struct's primary
      // constructor parameters are parameters the whole body can read.
      const positional =
        node.type === 'record_declaration' || node.type === 'record_struct_declaration'
      for (const parameter of primaryParameters(node)) {
        const componentName = parameter.childForFieldName('name')
        if (!componentName) continue
        if (positional) {
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
        } else {
          add(inner.bindings, {
            name: componentName.text,
            nameNode: componentName,
            declNode: parameter,
            reason: 'parameter',
          })
        }
      }

      const body = node.childForFieldName('body')
      if (body) for (const child of body.namedChildren) if (child) visit(child, inner)
      return
    }

    if (METHODS.has(node.type)) {
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
            arity: countParameters(parameters),
            isStatic: hasModifier(node, 'static'),
          },
          // A local function is a local, not a member of the enclosing type.
          scope.kind === 'type' && node.type !== 'local_function_statement',
        )
      }
      const inner = open('method', node, scope)
      bindParameters(parameters, inner)
      // A body is a `block` or an `arrow_expression_clause`; a constructor may also carry a
      // `: base(x)` initializer, which reads the parameters and so belongs inside.
      for (const child of node.namedChildren) {
        if (child && child.id !== parameters?.id && child.type !== 'modifier') visit(child, inner)
      }
      return
    }

    switch (node.type) {
      case 'property_declaration':
      case 'indexer_declaration':
      case 'event_field_declaration': {
        const name = node.childForFieldName('name')
        if (name) {
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
        }
        // An accessor body and an initializer both read names from the type's own scope.
        for (const child of node.namedChildren) {
          if (child && child.id !== name?.id && child.type !== 'modifier') visit(child, scope)
        }
        return
      }

      case 'field_declaration': {
        for (const declarator of declaratorsOf(node)) {
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
          const value = declaratorValue(declarator)
          if (value) visit(value, scope)
        }
        return
      }

      case 'local_declaration_statement': {
        for (const declarator of declaratorsOf(node)) {
          const name = declarator.childForFieldName('name')
          if (!name) continue
          add(scope.bindings, {
            name: name.text,
            nameNode: name,
            declNode: node,
            reason: 'variable',
          })
          const value = declaratorValue(declarator)
          if (value) visit(value, scope)
        }
        return
      }

      case 'enum_member_declaration': {
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

      case 'delegate_declaration': {
        const name = node.childForFieldName('name')
        if (name) {
          declare(
            scope,
            { name: name.text, nameNode: name, declNode: node, reason: 'class' },
            scope.kind === 'type',
          )
        }
        return
      }

      case 'using_directive': {
        // Only an alias names something. A plain `using Shop.Data;` imports a namespace and binds
        // no simple name at all — see the header.
        const alias = node.childForFieldName('name')
        if (alias && node.text.includes('=')) {
          add(scope.bindings, {
            name: alias.text,
            nameNode: alias,
            declNode: node,
            reason: 'import',
          })
        }
        return
      }

      case 'namespace_declaration':
      case 'file_scoped_namespace_declaration': {
        // Deliberately no scope of its own — see the header.
        const body = node.childForFieldName('body')
        if (body)
          for (const child of body.namedChildren)
            if (child) visit(child, scope)
            else for (const child of node.namedChildren) if (child) visit(child, scope)
        return
      }

      case 'foreach_statement': {
        const inner = open('block', node, scope)
        const name = node.childForFieldName('left')
        if (name?.type === 'identifier') {
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
        const declaration = node.namedChildren.find((child) => child?.type === 'catch_declaration')
        const name = declaration?.childForFieldName('name')
        if (name && declaration) {
          add(inner.bindings, {
            name: name.text,
            nameNode: name,
            declNode: declaration,
            reason: 'binding',
          })
        }
        const body = node.childForFieldName('body')
        if (body) visit(body, inner)
        return
      }

      case 'declaration_expression': {
        // `out var n` and `int.TryParse(s, out int n)`: a name declared inside an argument.
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

      case 'declaration_pattern': {
        // `if (o is Wrapper w)` — `w` is in scope for the rest of the enclosing block.
        const name = node.childForFieldName('name')
        if (name) {
          add(scope.bindings, {
            name: name.text,
            nameNode: name,
            declNode: node,
            reason: 'binding',
          })
        }
        return
      }

      default: {
        if (BLOCKS.has(node.type)) {
          const inner = open('block', node, scope)
          if (node.type === 'lambda_expression') {
            const parameters = node.childForFieldName('parameters')
            if (parameters?.type === 'implicit_parameter') {
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

/** Which binding is in force at an offset: the last one at or before it, else the first in the
 *  scope. The fallback covers a field, which a method may read above its own declaration. */
function inForce(bindings: readonly Binding[], offset: number): Binding {
  let best: Binding | null = null
  for (const binding of bindings) {
    if (binding.nameNode.startIndex <= offset) best = binding
  }
  return best ?? bindings[0]!
}

/**
 * The binding a name resolves to from an offset. As in Java the walk goes *through* a type scope
 * rather than skipping it, since a method reads a field by bare name. Nothing outside the open tabs
 * resolves — `string`, `Console`, anything from `System.*` reads as external, which is the same
 * principle `noLib` buys on the TypeScript side.
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

/** The same lookup, narrowed by how many arguments a call supplies. Where arity does not separate
 *  two overloads the first declaration wins, which the README states. */
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

/** A member declared on a type itself — no base types, which is definitions.ts's job since one may
 *  live in another tab. */
export function ownMemberOf(scope: Scope, name: string, offset: number): Binding | null {
  const members = scope.members.get(name)
  return members ? inForce(members, offset) : null
}

/** The names a type lists as base class and interfaces, in the order written. */
export function superTypeNames(scope: Scope): Node[] {
  if (scope.kind !== 'type') return []
  const list = scope.node.namedChildren.find((child) => child?.type === 'base_list')
  if (!list) return []
  const found: Node[] = []
  for (const child of list.namedChildren) {
    if (!child) continue
    if (child.type === 'identifier') found.push(child)
    // `: IRepo<Item>` — the head is the type being named.
    if (child.type === 'generic_name') {
      const head = child.namedChildren.find((inner) => inner?.type === 'identifier')
      if (head) found.push(head)
    }
  }
  return found
}

/** The type declaration an offset sits in — how `this.X` and a bare field name find it. */
export function enclosingType(tree: ScopeTree, offset: number): Scope | null {
  return typeOf(scopeAt(tree, offset))
}

/** The scope a type declaration opened. */
export function scopeForNode(tree: ScopeTree, node: Node): Scope | null {
  return tree.all.find((scope) => scope.node.id === node.id) ?? null
}
