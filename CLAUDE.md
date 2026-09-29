# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev                              # vite dev server on :5173
npm run build                            # vue-tsc --noEmit, then vite build → dist/
npm run typecheck                        # vue-tsc alone
npm test                                 # unit tests (tests/*.test.ts)
npm run test:e2e                         # puppeteer suites (tests/e2e/*.test.ts)
npm run format                           # prettier --write
npm run format:check                     # what CI runs
```

Single test file / single case:

```sh
npx vitest run tests/definitions.test.ts
npx vitest run -t 'parameter'
npx vitest run --config vitest.e2e.config.ts tests/e2e/dist.test.ts
```

CI (`.github/workflows/deploy.yml`, on push to `main`) runs `format:check`, `test`, `test:e2e`,
`build`, then deploys `dist/` to GitHub Pages. The e2e suites are part of the gate — a change to
Monaco wiring or the build config must pass `test:e2e` locally, not just `test`.

## Architecture

An AST viewer over the open files: Monaco on the left, the TypeScript AST on the right, kept in
sync, with the definition of whatever is under the cursor highlighted. No backend.

**Every open file is in the program; only the active one is on screen.** The tab strip
(`FileTabs.vue`, `src/lib/files.ts`) chooses which file the editor and the tree show. `useBuffer`
holds `files` plus an active id and exposes `text`/`language`/`fileName` as writable views onto the
active one. The analyzer, though, is given _all_ of them: a tab's name is its module path
(`pathFor` → `/db.ts`), so `import { x } from './db'` between two tabs resolves, and the trace
walks along it. What is emphatically _not_ multi-file is the **view**: one buffer in the editor,
one AST, one set of decorations. A span is an offset into a particular file and means nothing
anywhere else — which is why `FlowNode` carries `file`, and why `App.vue` filters trace spans to
the active tab before handing them to Monaco.

**One backend per language family, and the seam is `useAnalysis`.** `src/lib/backend.ts` is the
contract the panes see — `update` / `tree` / `resolve` / optional `trace` / optional `ready` — and it
imports nothing from `typescript`. `tsBackend.ts` wraps today's analyzer unchanged; `python/`,
`java/`, `c/` and `csharp/` are the others. There are five families for nine languages, and both
groupings are load-bearing rather than tidy: the TypeScript family shares one `ts.Program`, and C
and C++ share one grammar and one program so that a `.h` open beside a `.c` is something the
`#include` can actually resolve to. `useAnalysis` partitions the open tabs by family, calls `update`
on **every** backend holding files (so a tab off screen is still in its language's program, which is
what a cross-file definition walks along), and dispatches `tree`/`resolve`/`trace` to whichever owns
the active one. **Cross-language resolution does not exist and will not**: the backends never share
a file set, so a `.ts` file's import cannot see `db.py` and Python's `import db` cannot see `db.ts`.
There is no build system here to say what would bridge them, and inventing one would mean guessing. `trace` is **optional rather than null-returning** — `null` already means "nothing
resolved at this offset", and a pane has to tell that apart from "this language has no trace" to
explain itself instead of looking broken.

**Python is tree-sitter, and the grammar loads on the main thread — that is a fact, not a
preference.** `@vscode/tree-sitter-wasm` ships the runtime and 16 grammars built together, which is
what removes the ABI-mismatch failure that a hand-assembled `web-tree-sitter` + grammar pair invites.
Its `wasm/tree-sitter.js` is a **UMD bundle** whose `getCurrentScriptUrl()` runs at module-evaluation
time (`var _scriptName = getCurrentScriptUrl()`) and **throws** unless `__filename` or `document`
exists — so it cannot load in any worker, and a _module_ worker is worse still: the bundle detects a
worker with `typeof importScripts`, which a module worker does not have, so it falls to its shell
branch and never installs `readAsync`. On the main thread `document.currentScript` is null for a
module, `_scriptName` is undefined, and emscripten's `scriptDirectory` stays empty — harmless
_because_ `locateFile` is supplied, which is the branch `findWasmBinary` then takes. The three assets
are `?url` imports so Vite emits them hashed and resolves them against the emitting chunk, which is
what makes `base: './'` work on Pages; importing the glue normally would have Rollup treat it as CJS,
hoist its `require('fs')` onto Vite's node stubbing, and inline 169 kB into the main chunk. Dev
serves everything from `/` and so proves none of this, which is why `tests/e2e/dist.test.ts` asserts
the three assets exist **and** loads a Python buffer in the built bundle. In the unit suites the same
package is reached through `createRequire` (`tests/support/python.ts`) — a real CJS load is the only
thing that gives the UMD its `__filename` — and `Language.load` is handed the wasm _bytes_, which
keeps URL resolution out of the test path entirely.

**Offsets are UTF-16 code units, and that is pinned rather than assumed.** Every `Span` in the app is
a UTF-16 offset, because that is what Monaco's `getPositionAt` and `String.slice` both take. A byte
offset would put every highlight in the wrong place — but only in files holding non-ASCII, which a
suite of ASCII fixtures would never notice. `tests/pythonTree.test.ts` pins it with an accent and a
non-BMP emoji.

**The caret rule reaches further in Python than it does in TypeScript.** Once `identifierAt` has
picked an identifier, every later question is asked at **that identifier's position**, not at the
caret's. A caret sits between characters, so one parked at the end of the last name in a `def` is
exactly that `def`'s `endIndex` — _outside_ it — and `scopeAt` would then miss the scope the name is
plainly in, which is how `self.host` silently fell back to resolving `self`.

**`python/scopes.ts` is two passes, and the split is load-bearing.** Everything a scope binds is
collected before any lookup runs, so "an assignment anywhere in a function makes the name local
throughout it" falls out structurally instead of needing a special case. The three rules a reader
arriving from TypeScript gets wrong are all deliberate: `if`/`for`/`while`/`with`/`try` are **not**
scopes, a **class body is skipped** by any lookup from inside a nested function, and a
**comprehension is** a scope. Builtins deliberately do not resolve — the same principle `noLib` buys
on the TypeScript side, and the same reason there is no list of interesting globals. Attributes
resolve **syntactically** in three shapes only (`self.x`, `C.x` for a class in an open tab, and a
method reached either way); anything else falls back to where the _object_ came from, which is the
same property fallback `definitions.ts` makes for a value TypeScript cannot type. It never guesses at
an attribute, because in a tool for following untrusted data a plausible wrong declaration is worse
than none. **Base classes are walked, and the walk crosses tabs** — depth-first, left to right,
class-before-bases so an override wins, with a `file:offset` `seen` set because a cycle in the
hierarchy is illegal Python but entirely writable mid-edit. When the declaration lands in another tab
it has no range on screen, so the highlight goes to the _import that brought the base class in_ while
the label still names the attribute that was asked about — the same "nearest thing on screen" idiom
`resolveDefinition` already uses for an imported name. Note this is one place Python answers _better_
than TypeScript: `db.run()` on a namespace import returns null there, since nothing local stands for
`run` itself, while Python reports the import with `definedIn`.

**The Python trace is `flow.ts`'s walk over the binder instead of over a language service.**
`python/flow.ts` produces the same `FlowNode`s, the same steps and origins and the same budgets, so
the pane and the decorations cannot tell which language answered — and the fixtures are written in
the same indented `label: excerpt [origin]` shape, which is how the two stay comparable line for
line. The two questions `flow.ts` asks the service are answered differently here: **reassignments
are free**, since the binder already records every binding of a name in a scope, while **call sites
cost a scan** of every `call` node in every open tab — which is why a trace stays on an explicit
request and is never wired to cursor movement.

Three Python-specific rules, each of which was a wrong answer before it was a rule. **An f-string is
not a literal**: `isConstant` is false for any string carrying an `interpolation`, and every `{…}`
becomes an operand, which is most of what a taint review is looking at. **Constructing a class is a
call to its `__init__`**, and nothing in the source says so — the call site reads `Connection(host)`
— so `callSitesOf` matches constructions of the enclosing class when the target is named `__init__`;
without it every constructor parameter dead-ends as `entry`, which is most of the state in
object-shaped code. And **the argument shift belongs to the call site, not to its syntax**:
`self` is implicit in both `o.m(x)` and `C(x)`, so both run one behind the parameters, but only the
first has a receiver to detect — `CallSite.shift` carries it rather than re-deriving it, which is
the off-by-one that reported the wrong value for every constructor argument.

**A wrapper object is followed through, and that is what `Seeking` is for.** A value read from a
request, stored on an object, passed down and read back out is the shape most taint takes — and in
Python `w.value` on an untyped `w` cannot be named, so the walk falls back to tracing `w` and used
to stop at `Wrapper(ident)` calling it a literal, losing the taint exactly where the wrapper carries
it. The attribute's _name_ now rides that fallback branch: it passes through argument, assignment
and return hops unchanged, and is **consumed by the first construction of a class that has such an
attribute**, which then expands to the constructor argument that set it. Where no branch can answer
it, the construction keeps its arguments instead (below) — only one with nothing fed into it is a
literal. It is seeded in
two places, and missing either one breaks the common case: `expand`'s `viaObject` branch, and
`tracePythonOrigins` itself, because tracing _at_ `obj.value` roots on `obj`'s declaration and never
passes through `expand` at all. Java needs none of this — it writes the receiver's type down — but
it does need `var` read off the `new`, since `var` is how most modern Java spells a local and a
`var` receiver is otherwise opaque.

**Reading a member follows the receiver, and that is a correctness rule rather than a tuning one.**
`id.value()` asks about one field of _this_ object. Expanding the member on its own reaches every
construction of the type across the open tabs — including a repository that also _builds_ a
`ProductId` when mapping a row, which nothing ever passes to the method being read. That is a path
that **cannot happen**, and a false path costs a reviewer more than a missing one; it is also not
what the "stated limits beat silent misses" rule is about, since following the receiver loses no real
flow. So Java carries `Seeking` the way Python does: the member's name rides the receiver's own chain
and is consumed by `constructorIndexFor` at the construction that actually made it. An earlier
version scanned every `new R(…)`, and that is what produced the false branch.

**A record's two members are written down nowhere**, which is what makes the above necessary rather
than merely tidy. `record ProductId(String value)` generates an accessor per component — so
`id.value()` calls a method that appears in no source — and the component _is_ the canonical
constructor's parameter, so it has no assignment to walk to. `expandCall` treats a zero-argument
invocation resolving to a `property` as a read of that component, and `accessorField` gives a
hand-written `return value;` getter the same treatment, so records and plain wrappers take one path.
`constructorIndexFor` then answers "which argument lands in this member": by position for a record,
and from `this.x = p` in the constructor body for a class. Miss any of it and the trace ends at
`new ProductId(id)` calling it a literal — precisely where a Spring controller's `@PathVariable`
disappears.

**Tracing _at_ a member read roots on the expression, not on the declaration.** `traceJavaOrigins`
checks for that shape before its usual rooting, because expanding the declaration is the very thing
that reaches every object of the type.

**A method call on a receiver we cannot name is matched on the name alone, and that is deliberate
over-approximation.** `C().use(x)` and `self.conn.use(x)` leave `o.use` unresolvable, and dropping
them would _under_-approximate — a trace that silently misses a path is the one failure this tool
refuses. So where the name is declared exactly once across the open tabs it is accepted on the name;
where it is declared more than once, matching would be a guess between them, so only a resolvable
receiver counts. `TracePane`'s "no backward trace" branch is **reached by C and C++**, which is
what `AnalysisBackend.trace`'s optionality was built for — see the C paragraph below for why that
language declines one.

**Java is the third tree-sitter language, and its binder is the opposite of Python's in three
places.** A **block is a scope**; a **class body is visible from its methods**, so `lookup` walks
_through_ a type scope rather than skipping it; and declaration precedes use, so there is no
"assignment anywhere makes it local" rule. What Java adds instead is **overloading**, which a binder
without types cannot settle — `lookupCall` narrows by arity, which is syntactic and usually
decisive, and where it is not the first declaration wins and the README says so.

**Java's saving grace is that a receiver's type is written down.** `Db db = new Db();` names the
type on the line, so `declaredTypeName` makes `db.load()` resolve into another tab — the member
resolution Python has to decline. The cost is a longer list of ways a declaration can be _elsewhere_,
and `MemberHit.anchor` is what handles it: a span is an offset into its own file, so presenting one
against the active file's text is how a highlight lands on nonsense (`"ds Base { String m() {"` was
the actual output before this existed). Every hit therefore carries the file it was found in, and a
hit from another tab needs an anchor — the import, the `extends` clause, the receiver's declaration,
or the clicked identifier itself — set at the **first** crossing only, since a chain two supertypes
deep must still anchor on something in the file on screen. No anchor means null, which is what the
TypeScript resolver answers in the same case.

**A type in the same package needs no import**, and that is what most pasted pairs of Java files
look like — so an unresolved type name also searches the open tabs for a top-level declaration of
that name. It is Java's package rule approximated as "any open tab", and it is why the feature is
usable on two files at all.

**`declare` attaches `owner` to both copies of a member.** A field is added to its type's `members`
_and_ to the scope's own `bindings`, because a bare name inside a method resolves through the second
while `this.x` resolves through the first — and when only `members` carried the owner, a bare field
read silently lost the dimmed class header. **Reassignment is a scan, not a binding**: Java's
`x = …` is an `assignment_expression` that declares nothing, so `writesFor` walks the enclosing
method or type and resolves each candidate back to the same declaration, where python/flow.ts gets
its writes free from the binder.

**C and C++ are one language to this codebase, and that falls out of the artifact.**
`@vscode/tree-sitter-wasm` ships no `tree-sitter-c.wasm`; it ships `tree-sitter-cpp.wasm`, which is
built as a **superset** of the C grammar — a plain `.c` file parses through it with no ERROR nodes,
checked rather than assumed. So one grammar, one backend and one `Family` (`'c'`) serve both, which
is also what a `.h` open beside a `.c` needs: an `#include` only resolves if both tabs are in the
same program. `.h` is read as C, as Monaco's own contribution does; a C++ header spelled `.h` is the
one case that guesses wrong, and it costs a badge rather than a tree, since the grammar parses both.

**`c/scopes.ts` is Java's binder with four inversions**, each of which a reader arriving from the
other three languages gets wrong. A **declarator nests around its name** — `char *argv[]` is an
array of a pointer to an identifier — so `declaratorName` walks _down_ a chain where the Java binder
asks for a `name` field. A **namespace opens no scope**, because every name in a single-namespace
C++ file would otherwise be invisible from the translation unit, which is where a cross-file lookup
starts. **Both arms of a `#if` are bound**, since tree-sitter parses the preprocessor structurally
and evaluates nothing — the same may-analysis over-approximation the trace makes, and the honest
one. And **a macro is a binding**: `#define MAX 16` is the closest thing C has to a constant, bound
as a `variable` (or a `function`, for a function-like macro) because `DefinitionReason` is a shared
vocabulary that reaches the panes and is not extended for one language. What is emphatically _not_
modelled is macro **expansion** — a name a macro produces exists nowhere in the tree, so it resolves
to nothing, stated rather than guessed at.

**C's cross-file rule is the linker's, and that is a licence Java's is not.** An `#include "util.h"`
is textual, so everything the header declares is genuinely in scope and the tab is searched exactly;
`<stdio.h>` deliberately never resolves, which is what makes `printf` read as external. Beyond that,
C has no namespaces — a non-`static` file-scope name is one name in one global space — so "any open
tab's file scope" approximates what the linker actually does rather than guessing. `static` is what
it over-approximates, and the README says so. **A preprocessor directive's node extent includes the
newline that ends it**, so `declSpan` trims every span that becomes an answer; without it a
`#include` highlight runs onto the start of the next line.

**C and C++ ship with `trace` absent, and that is a judgement rather than unfinished work.** The
backward walk follows a value through assignments, returns and arguments. In C the interesting flows
go through **pointers** — `char *p = buf; gets(p);` is the path a reviewer opened the file for — and
a walk with no aliasing is a stated limit in TypeScript, a corner in Java, and a hole where the
feature should be in C. The **preprocessor** compounds it: a value passing through a macro dead-ends
at a name with no declaration. Shipping a trace that quietly missed those is the one failure this
tool refuses, so the pane says the language has none. That is the branch `AnalysisBackend.trace`'s
optionality exists for, and the reason `null` was never allowed to mean it.

**C# is the closest language here to Java, and only its differences are worth reading.** A block is
a scope, a class body is visible from its methods, declaration precedes use, overloads narrow by
arity, and — the fact that makes member resolution possible at all — **a receiver's type is written
down**. Five things differ, and each was a wrong answer first. **A `using` binds nothing**: C#
imports a _namespace_, not a type, so unlike Java's `import com.example.Db` nothing in a file says
which tab a type came from, and cross-file resolution rests entirely on the open-tabs rule; only a
`using X = …` alias binds a name. **A declarator holds its initializer as a bare child** — there is
no `value` field, and a `field_declaration` wraps a `variable_declaration` that wraps the declarator,
two levels more than Java — so `declaratorValue`/`declaratorsOf` are the only places that know.
**A primary constructor's parameters are in scope for the whole body**, as properties on a positional
`record` and as parameters on a `class`; `primaryParameters` **must** be guarded by node type,
because a `method_declaration` also holds a `parameter_list` child and without the guard every
method parameter is read as a primary constructor's and sent looking for constructions of its own
name. **A property is storage, not a method** — an auto-property has no body, so the property _is_
the member, which makes the wrapper case simpler here than the hand-written Java getter it
corresponds to. And **an attribute list sits inside the declaration node**, above its first line, so
`signatureSpan` starts past it or every annotated method highlights from its `[HttpGet(…)]`.

**The C# trace is the Java walk with four shapes Java does not have.** **A property read is not a
call**: `id.Value` is a bare member access where Java writes `id.value()`, so the receiver-following
rule applies to the access itself rather than only to a zero-argument invocation — `expandMemberRead`
follows the receiver for any real receiver and expands the member only for `this`/`base`, where
there is no receiver to follow. **An argument is wrapped** in an `argument` node that may carry a
`name:`, so nothing reads `arguments.namedChildren` directly. **An interpolated string is not a
literal** — `$"…{id.Value}…"` is where a query is built, and an `interpolation` carries no field for
its expression, so the expression is the child that is not an `interpolation_brace`. And **a
constructor may be primary or an object initializer**: `constructorIndexFor` answers by position for
a record or a primary constructor, from `this.X = p` in a block or behind an `=>` for an ordinary
one, and `initializerValueFor` reads `new W { Value = v }`, which fills a member with no constructor
involved at all. `constructorSite` returns **null** where nothing declared fits the arity but the
primary constructor does — a primary constructor has no body to show, and naming the first declared
one instead reports a constructor the call never runs.

**Two independent TypeScript setups exist, and conflating them causes confusion.**

1. `src/lib/analyzer.ts` — our own `ts.LanguageService` over the open files, running `noLib` and
   resolving imports between them. This is what produces the AST and answers
   `getDefinitionAtPosition`. Everything the app actually shows comes from here.
2. `src/lib/monacoSetup.ts` — Monaco's own bundled TS worker, which only powers editor niceties
   (hover, completion, squiggles). Its compiler options are separate and deliberately different,
   and it knows nothing about the other tabs: its models are keyed by file id, not by name, so it
   never resolves between them. Cross-tab imports are our analyzer's business alone.

A definition in a file that is not on screen has no range the editor can highlight, so an imported
name still resolves to its import statement — with `definedIn` saying which tab holds the real
declaration. That is the intended answer, not a gap to fix.

**Data flow.** `useBuffer` decides where the open files come from (a link, which describes exactly
one file → localStorage, which restores the whole strip → the sample) and owns
filenames/languages/notice. `useAnalysis` holds a debounced (150 ms) parse in a `shallowRef` and bumps
a `revision` counter. `App.vue` owns the shared selection state and wires the two panes.

**Two questions, two costs.** `resolveDefinition` is one definition lookup and runs on every cursor
move. `traceOrigins` (`src/lib/flow.ts`) walks a value backwards through assignments, returns and
call-site arguments — now across files, since references and definitions both cross an import —
costing a `getReferencesAtPosition` per parameter it crosses, so it runs only on explicit request
and is cleared whenever a file's text changes. Do not wire it to cursor movement. Both share
`declarationAt` in `definitions.ts`, which is the single home of the caret rule and the property
fallback; use it for any new offset→declaration lookup rather than calling
`getDefinitionAtPosition` directly.

**A wrapper object is followed through in TypeScript too, and `Seeking` is the same mechanism it is
in Python and Java.** A value read out of a DTO cannot always be named where it is read: an
interface member holds a shape and never a value, and a class field's value arrives through its
constructor. The walk therefore falls back to the **receiver** and carries the member's name down
with it — riding assignment, argument and return hops unchanged, consumed by the first thing that
can answer it (an object literal with that property, or a construction of a class with that member,
which expands to the argument that set it through `constructionSource`, TypeScript's
`constructorIndexFor`: parameter property, then `this.x = p` in the constructor body, then the
field's own initializer). Where no branch can answer it nothing changes, and **a construction with
nothing fed into it is still a literal**. It is seeded in three places and missing any one breaks
a common case: `expand`'s `viaObject` branch, its new type-only-member branch, and `traceOrigins`
itself — tracing _at_ `w.value` expands the declaration directly and never passes through `expand`
at all, which is the same trap `tracePythonOrigins` documents.

**A construction is not a terminal, and its constructor gets a row — in all three languages.** A
wrapper _is_ its contents, so `new ProductId(id)` says where the object was made and nothing about
where what is inside it came from: with a member being sought the argument that fills it answers
precisely, and otherwise every non-constant argument is kept, which is the same over-approximation
`expandOpaqueCall` makes. Only a construction with nothing fed into it stays a literal. Above those
arguments sits the **constructor the value passes through**, where the class declares one —
`constructorSite` in Java (compact or ordinary, picked by arity then first, the same guess
`lookupCall` makes for an overload), `initOf` in Python, `members.find(isConstructorDeclaration)`
in TypeScript — because a record's compact canonical constructor is exactly where
`UUID.fromString(value)` validates or throws, and a trace that steps over it reads as though the
value arrived untouched. A class that declares none has nothing to show and gets no row, and the
row is only ever created when something will hang under it: a node nothing references would still
be counted in the pane's step count. **`FlowNode.definedIn` carries the tab the type is declared in
regardless**, because `tracedFiles` builds the _Analyze this trace_ tags out of the trace and a
wrapper with no constructor of its own leaves no row in its own file — a model asked whether that
path is validated cannot answer without the source. It is set on the construction's own row in all
three languages, and `tracedFiles` takes it beside `file`.

**`Analyze with agents` is `askAbout` for a run, and neither takes a scope any more.**
`useAgents.runAbout(task)` clears the transcript, sets the task and runs; the files come out of the
task's own `@` tags, read in `run` at the moment Run is pressed. That is what makes a run's scope
impossible to leave stale — an earlier version stored the names **with the task they were given
for** and dropped them when the task no longer matched, because a reader who rewrites the box is
asking something else; now the selection _is_ in the box, so rewriting it rewrites the selection and
there is nothing to keep in step. A run still takes **one snapshot** of the buffer, and the tags are
spent against it per agent rather than over the run: an agent handed the code is handed the tagged
files alone, an agent that reads for itself gets the index of every tab and is pointed at them. One
snapshot, several readings of it — which is also why a mixed team is unremarkable.

**Rooting a member read on the expression is what makes a DTO in another tab traceable at all.**
`resolveDefinition` answers null when the declaration is elsewhere and nothing local stands for it
— an import brings in `Dto`, not `Dto.value` — and `traceOrigins` used to refuse the trace outright
on that null. The read itself is in the file on screen, so it is the root, and Java has the same
rule for the same reason.

**Where the member _can_ be named, the declaration is expanded rather than the receiver followed,
and that is the opposite of Java's choice** — deliberately. A TypeScript field is written by its
constructor _and_ by any setter, and `writesFor` finds both through references; following the
receiver instead would answer only the construction that made this object and silently drop the
setter, which is the one failure this tool refuses. The cost is the may-analysis's usual one — every
construction of the class is reported — and the README states it. `writesFor` therefore takes a
property declaration and an object-literal property as well as a variable, looking through the
property access a field is written through (`this.value = v` puts the reference on the name inside
the access, not on the assignment's left), and a `readonly` field is **not** skipped the way a
`const` is: the constructor is exactly where one is written. `declarationFor` gained accessors for
the same reason — without it a getter's declaration stays the bare name token, which the trace then
calls a literal.

**Trace node granularity.** `expand` deliberately _collapses_ the identifier→declaration hop, or
every step in a chain would double. Two exceptions, both in `flow.ts`: `declarationAt`'s `viaObject`
flag means the property fallback answered about a different expression (`req`, not `req.params.id`),
so that hop gets its own row; and `terminateAtDeclaration` gives the _last_ row of a branch the
declaration's span, so a trace starts and ends at a declaration. Changing either changes the shape
every `tests/flow.test.ts` fixture asserts.

**A copied trace is a different artefact from the pane, and `traceText.ts` is where they part.**
The pane is read beside the editor; the text is read in a chat, by a model, with no editor and no
tab strip — so **every step names its own file**, including the steps in the tab on screen, which
`TraceRow.vue` deliberately leaves bare because the buffer beside it already says which file that
is. It is a **markdown nested list** rather than plain indentation, and that is for whoever reads it
next: a model reads a list as the tree it is, and wherever the text is re-rendered as markdown — a
model quoting it back, a report built from it — indentation alone would be folded into one
paragraph by `markdown.ts`'s paragraph rule. (Both panes show the reader's _own_ text `pre-wrap`,
so a pasted trace looks right there either way; it is the second reader that the list is for.) The citation shape is `DEFAULT_ROLE`'s own —
`name (file line N)` — so a pasted trace reads like the answer the brief is asking for rather than
as a second notation. Its origin wording is its own table, not `TraceRow.vue`'s two-word
`ORIGIN_TEXT`, which is written for a column beside the row that explains it. The may-analysis
caveat is part of the text and must stay: a trace pasted without it reads as a claim about what the
code _does_, and that is precisely how a model turns a path the code never takes into a finding.
What is copied is the whole trace, whatever is folded away — collapsing is how a large one is read,
not a statement about which steps matter — and the feedback is the button's own label, not the
app's notice line, because that line is up beside the share link that writes it.

**A question names its own files, with `@`, and that is the only scoping mechanism there is.**
`src/lib/mentions.ts` is the pure half: `mentionedFiles(text, names)` for what a question narrows
to, `mentionAt`/`applyMention` for the completion a composer offers, `describeScope` for the line a
narrowed pane shows and `describeDraftScope` for the line under the box before it is asked. A tag is
resolved **against the open tabs and nowhere else** — the whole name as the tab spells it, or an
unambiguous basename, the same forgiveness `read_file` shows — which is what leaves `@PathVariable`
in a Java excerpt, `@app.route` in a Python one and an address in prose as the prose they are. It
matters more than it looks: the text a reader pastes into that box is most often a trace, and a
trace is full of annotations. A basename that two tabs answer to is refused rather than guessed, for
the reason `tools.ts` refuses it — narrowing onto the wrong file is worse than not narrowing.

**`Analyze this trace` writes those tags rather than passing a list beside the question.**
`traceQuestion` puts `tracedFiles` in the first line as `@name` tags, in first-mention order,
because the budget is spent in order and what a tight one should clip is the far end of the path
rather than the value the reader asked about. `useChat.askAbout(question)` is then only "a new
conversation, then `ask`" — everything about _which files_ is read back out of the question's text,
by the same code a typed `@` goes through. The gain is not tidiness: what narrowed a conversation is
visible **in** the conversation, it can be edited before it is sent, and `App.vue` no longer has to
know whether the picked model reads its own files.

**Only the question that _opens_ a conversation can _scope_ it**, because a session carries the code
it was built with and cannot be handed different code without throwing the conversation away. What a
later tag does instead is **add** — `withTaggedFiles` in `useChat` — and that is the one place where
what the reader sees and what the model gets deliberately differ: the transcript keeps the question
as it was typed, tags and all, while the model is handed the same question with
`buildAddedCodeMessage`'s output in front of it. Only what it lacks is sent. A tagged file the
conversation already carries is **named rather than sent twice** (`@db.ts @auth.ts` on the second
question of a chat opened over `db.ts` costs one file, not two), and a model that reads its own
files is told to read them and sent nothing — which is also what makes a tag on a follow-up
worth anything on that path. The budget is what is _left_ (`maxCodeChars − spentCode`, floored at
`MIN_ADDED_CHARS`), so a conversation cannot talk its way past its own window one tag at a time, and
a file there was no room for is named to the model and kept out of `scopeFiles`. `ChatPane` says
which of the three is about to happen, because all three are typed the same way. Three things follow
the
scope rather than the buffer once it is set — the files the session is built from, `stale` (editing
a file the model was never shown must not cost the conversation) and the `clipped` line, which
states the narrowing whether or not anything was clipped. **`stale` is measured against a map of
name → text rather than one joined signature**, and that is what a growing conversation needs:
folding a newly added file into a joined string would silently forgive every edit made to the others
in the meantime. Being order-insensitive is a second, smaller win — switching tabs reorders the
prompt without changing a character of it. The **model** is told as well, through
`CodeContext.partial`: the brief asks it to say when an answer depends on code it cannot see, and a
listing whose first sentence claims to be every open file makes that impossible to judge — a model
that believes it has the whole editor explains a gap by inventing something rather than by naming
the file it would need. `newChat` drops the tags, which is what makes "New chat" mean the whole
buffer again. The question itself is bare — `ANALYZE_TASK` — because what _analyze_ means belongs
to the brief, which is the reader's; `tests/traceText.test.ts` refuses taint vocabulary in it for
the same reason `tests/agents.test.ts` refuses it in the orchestrator's.

**A tag narrows what a model is _handed_ and never what it may _read_.** For a model without tools
the two are the same thing, and `buildCodeMessage` gets the tagged files alone. For one with them
they are not: `buildIndexMessage(files, named)` lists **every** tab and appends one line naming the
tagged ones to start with, `fileTools` is built over every tab, and `clipped` stays null — nothing
was withheld, so there is nothing to warn about. Narrowing the toolbox instead would spend the one
advantage the tool path has, which is that a path leaving the tagged files is one the model can
follow on its own. `useChat` and `useAgents` each make that choice at the single place they build
the opening turn, so the two cannot drift.

**`MentionBox.vue` is one component for both panes, and that is a correctness argument rather than
a DRY one.** The composer must complete to names the parser will then resolve; two implementations
that disagreed would offer a file and quietly not narrow to it. Its ranking is `quickOpen`'s — the
same subsequence matcher Cmd+P uses, so `@slb` finds `src/lib/base.ts` in both places and a reader
has one gesture for naming a file. Its keys are handled in **one** `keydown` handler rather than
through `@keydown.enter.prevent` modifiers, because every key in it is conditional: Enter picks a
completion while the list is open and asks the question while it is not, and a modifier cannot say
"only when".

**`noLib` is load-bearing twice over.** It keeps the bundle small, and it makes the trace's terminal
condition principled: nothing outside the open files resolves, so a name with no definition _is_ an
external source. There is deliberately no list of interesting globals. `noResolve` used to do the
same job for imports and is now **off** on purpose — an import of another tab resolves and the walk
follows it, while an import of anything not open (`express`, `node:fs`) still resolves to nothing
and terminates the branch exactly as before. Turning `noLib` on again would be the way to break
this; do not.

**Cross-file spans, in three places.** (1) `declarationAt` may answer with a declaration in another
file; it also returns `local`, the import that brought the name into the queried one, because the
editor can only highlight what is on screen — that is how "an imported name resolves to its import
statement" survives, now with `definedIn` naming where it really lives. (2) Every `walk.sf` in
`flow.ts` is gone: each node reads its own `getSourceFile()`, and the cycle map is keyed
`file:offset`, since two tabs share every offset. (3) `useAnalysis` exposes both `revision` (any
parse) and `contentRevision` (a file's text actually changed). The trace is dropped on the second
only — switching tabs reparses without moving a character, and dropping the trace there would make
a cross-file one impossible to follow, since following it _is_ switching tabs.

**Tab names are module paths.** `./db` finds the tab called `db.ts`, `db.js`, `lib/db.ts` or
`lib/index.ts` — TypeScript's bundler resolution, given a host whose files are the open tabs. Two
tabs may therefore not share a name (`renameFile` refuses), or an import would be ambiguous.

**A folder open is two completely different mechanisms wearing one button.** `src/lib/upload.ts` is
the seam: a **directory picker** (`webkitdirectory`, its own `<input>` — the attribute belongs to the
element, not the click, so one input cannot ask for both) has already walked the tree by the time
`change` fires, handing over a flat `FileList` whose entries each carry a `webkitRelativePath`, root
segment included and `accept` ignored; a **drop** hands over none of that — `dataTransfer.files`
holds one bogus entry per folder that fails on first read — so the tree is walked here, from entries
that must be taken out of the `DataTransfer` **synchronously, before the first await**, since it is
emptied the moment the handler yields. Hence `filesFromDrop`'s synchronous prologue and
`onDrop` awaiting nothing ahead of it. `readEntries` returns a **batch at a time** (Chrome's is 100)
and signals the end with an empty one, so it is called until it does — reading one batch would
quietly open 100 files of a 150-file directory. The walk is **breadth-first**, which is not a style
choice: depth-first plus a bound stops inside the first subdirectory it entered and never reaches the
files beside it, while a level at a time means whatever the bound cuts is the deepest thing found,
which the tab cap was going to discard anyway. A handle is asked for only for a name a backend can
read, which is what makes skipping a repository's images and lockfiles cost nothing — **except at
depth 0**, where a loose dropped file is kept whatever its extension, because a dropped `notes.md`
deserves the word `openFiles` already has for it and silence reads as a broken drop target.
**Which of the two it was is reported rather than inferred**: `filesFromDrop` returns `folder`
alongside the files, read off the dropped entries, and the picker reads `input.webkitdirectory` off
the element that fired — a folder holding one file at its root would be indistinguishable from a
loose drop by the time only names are left, and the next paragraph turns on telling them apart.

**A folder open replaces the strip; a file open adds to it.** A folder is a project, so what was
open belongs to a different one — and the fifty places are the folder's to spend, not something to
share with tabs the reader is done with. `openFiles` takes it as `OpenOptions.replace` from the
caller rather than sniffing the names for a `/`, for the reason above. Two things make it safe
rather than merely tidy: the cap and the refresh-in-place lookup both read `kept`, which is empty
when replacing, so a folder is never clipped by tabs that are about to close; and the replacement is
**conditional on something having opened**, because emptying the editor is the one unrecoverable
outcome here and a folder holding nothing readable must not cause it — that case keeps the tabs and
says `Nothing opened` instead. The close is stated in the notice (`closed`), since a tab the reader
had been typing in can go this way and the strip alone does not say how much went with it.

**A folder's files arrive under their paths, and that is the whole reason it works.** A project holds
two `index.ts` as a matter of course, and `openFiles` refreshes a tab whose name matches — so bare
basenames would have the second file silently overwrite the first. A path is also already what a tab
name _is_ (`lib/db.ts` resolves), so `./db` between two files of the same folder resolves exactly as
it does between two hand-made tabs. `arrangeForOpen` drops the folder each path starts in — it is the
folder the reader picked, so it says nothing, and relative imports are untouched because every path in
a folder shifts by the same one segment. It is done **per entry** rather than only for a root they all
share, since the rule is about the reader's own folder name and holds just as much for a drop of two
folders, or of a folder beside a loose file; a name with no folder in it is left alone, having nothing
to lose. The one thing that stops it is a **collision** — `a/src/db.ts` and `b/src/db.ts` both
becoming `src/db.ts` would have `openFiles` refresh the first tab with the second file, silently — so
where two stripped names would match, every name keeps its own root instead. What it deliberately does _not_ do is reorder:
`tests/e2e/app.test.ts` pins both the strip's order and that the **last** file picked is the one you
land on, and a folder is no reason to change either. So depth is spent where it is actually needed —
`fitToStrip` returns a **set**, not a list, precisely so the cap can be decided on depth while the
tabs still open in arrival order. `MAX_OPEN_FILES` is 50 because every tab is a Monaco model, a file
in its language's program, a call-site scan for every trace and a section of a chat's prompt; the
clip is stated, like the code listing's, and a refresh of a name already open costs no room against
it. Readability is settled before the cap for the same reason: a file this viewer cannot parse must
not take a place from one it can. `FileTabs` then shows the directory and the basename apart, with
the directory taking practically all of the shrinking (`flex: 0 999 auto`) — end-truncating
`src/lib/very-long-nam…` would be a strip of tabs that cannot be told from one another.

**Quick open is Cmd+P, and both halves of it are decided by things outside this app.** The keybinding
is on `window` in the **capture** phase, in `App.vue`, and each word of that is load-bearing: Monaco
handles keys on its own node, which is a descendant, so a bubbling listener arrives after the editor
has had its say; and Cmd+P is the _browser's_ print shortcut, which nothing but `preventDefault`
stops. It is deliberately **not** `editor.addAction` the way trace is — the palette has to answer
from the tree and the panes too, where the editor holds no focus and none of its actions run. Ctrl+P
is accepted alongside Cmd+P since both spell "the command key" to a reader arriving from an editor
and Monaco binds neither, while Cmd+Shift+P is deliberately left to the browser: a command palette is
what that means elsewhere, and this app has no commands to offer.

`src/lib/quickOpen.ts` is the pure half, and the matcher is a **subsequence** because that is the
gesture readers bring — `slb` for `src/lib/base.ts`. What makes such a thing usable or useless is
only ever the ranking, since every file in a tree matches a short query somehow, so the score is
three things and no more: letters that run together, letters that start a word, and letters in the
file's own name rather than the directories above it. The one non-obvious piece of the
implementation is that it tries **every** starting position rather than the first — greedy from the
left alone matches `store` against the `s` of `src/lib/store.ts` and scores it as scattered. Ties go
to the shorter name, then alphabetically, so the list never reshuffles between two equal scores.
`segmentsFor` cuts the name into runs for rendering, ending one wherever _either_ the match or the
directory prefix changes, so a row stays a `v-for` and never `v-html`.

**The palette lists files by recency, and that is what the order is for.** `useBuffer.recentFiles`
puts the tab on screen first and the one before it second, and the palette arms the **second** row —
which is the entire reason `recent` exists: arming the first would make Enter a no-op, while arming
the one below it makes Cmd+P–Enter a toggle between the two files a reader is working in, as it is in
an editor. `recent` is not persisted and is never cleaned up on a close: a reload has no history
worth restoring, and a stale id simply finds no file when the order is read back, which is cheaper
than watching for closes. Picking hands focus back to the buffer (`EditorPane.focus`), so the palette
is never a detour that leaves you typing into nothing.

**The cursor offset is the single source of truth for selection.** `AstNode.id` is a pre-order index
that is only stable within one parse, so after every re-parse `App.vue` re-derives the selection from
the offset rather than carrying the id over. A tree click additionally pins the exact id (`origin`
tracks which side moved last), because an offset alone can't distinguish a node from its
same-position ancestors.

**Reactivity constraint.** `ts.Node` has circular `parent` refs and lazily-computed positions, so it
must never be made reactive. `astTree.ts` copies each parse into a flat plain-object list, and both
the tree and the Monaco editor instance live in `shallowRef`s. Tree rows get shared state via
`provide`/`inject` (`src/components/astContext.ts`), not prop drilling.

**The chat tab is a third question with a third cost.** `src/lib/chat.ts` is a provider contract,
not a client: `providers/{builtin,webllm,transformers,openrouter,localServer}.ts` implement
`availability` / `load`, and nothing above them knows which model is answering. **Two lifetimes, and conflating
them is the bug that keeps coming back**: a `ModelEngine` owns the loaded weights and outlives
conversations, while a `ChatSession` is a system prompt and its turns. `newChat` drops the session
and keeps the engine — destroying the engine per conversation means reloading the model onto the
GPU on every "New chat". Four of the five providers keep the rule stated everywhere else: no key,
no hosted fallback — every model runs on the reader's machine. `openrouter` is the one
deliberate exception, clearly labelled wherever it's offered: it sends the system prompt, the open
files and every question to OpenRouter's API using a key the reader supplies themselves
(`providers/openrouterKey.ts`, `localStorage` key `codeview:openrouter-key` — the first _secret_
kept there, under the same unencrypted trust model as every other persisted preference in this
app), and it is never included in a share link (`copyShareLink`/`buildFragment` in
`useBuffer.ts`/`App.vue` hand-pick exactly which fields go into the fragment; the key is never one
of them). An OpenRouter entry with no key configured stays visible in the picker rather than
disappearing — `Availability`'s `'needs-key'` — and `useModel`'s `engine()`/`engineFor()` refuse to
load one without a key, throwing a message that names the missing key specifically, before ever
attempting a request. The four shipped OpenRouter entries (GPT-4o mini, Claude Haiku 4.5, Claude
Sonnet 5, GLM-5.3 Flash) are not the whole story: a reader can
add any OpenRouter-hosted slug of their own from the same settings tab
(`providers/openrouterModels.ts`, `localStorage` key `codeview:openrouter-models`, turned into an
ordinary `ModelChoice` by `toModelChoice` so nothing downstream treats it differently). **A shipped
slug is a promise OpenRouter can withdraw**: `anthropic/claude-3.5-haiku` was retired from its
catalogue and failed on the first question, which is how the Haiku entry moved to 4.5 — under the
same id, so a remembered pick or a team link still lands. Check a slug against
`https://openrouter.ai/api/v1/models` (public, no key) before shipping one, and read `thinking` off
its `supported_parameters`: an entry is flagged only where that list has `reasoning`, since that is
what `reasoning: { enabled }` is sent against and GPT-4o mini has no such parameter.

**`localserver` is the fifth provider and the opposite of an exception**: a server the reader
started — Ollama, LM Studio, llama.cpp, vLLM — reached over loopback, so the code never leaves the
machine and nothing downloads into the browser. It sits beside `openrouter` only because the four of
them speak the same API, and `providers/openaiCompatible.ts` is that shared half: one SSE read loop
carrying the four rules that drift the moment they are copied — the partial answer pushed into the
history on _both_ the success and the error path, the `DOMException('Aborted', 'AbortError')` that
`stream.ts`'s `isAbort` is keyed to, `fold.end()` closing a `<think>` the stream left open, and an
`error` object inside an SSE chunk **failing** the answer rather than ending it — that chunk, with
`finish_reason: 'error'` beside it, is the only way OpenRouter can report a provider dying once the
response is committed, and reading only the delta turned it into a short answer that happened to
stop (`tests/openaiCompatible.test.ts`). `useChat` keeps what streamed before such a failure as an
answer of its own ahead of the failed row, as the agents pane already did. What
is left in each provider is its five own facts: endpoint, headers, ceiling, the wording of a
failure, and the wording of one reported mid-stream. **Its gate is the base URL, not `import.meta.env.DEV`**, and the reasoning matters because
the obvious premise is wrong: a page on GitHub Pages _can_ fetch `http://localhost` — loopback is
carved out of mixed-content blocking, the Secure Contexts spec counting `127.0.0.1`, `[::1]` and the
`localhost` name as potentially trustworthy. What actually stands in the way is the reader's own to
clear (Ollama's default origins are loopback-only, so `OLLAMA_ORIGINS` is needed for the deployed
site; LM Studio has a switch) plus Chrome's local-network permission prompt for a public page
reaching a loopback address — which is the reason nothing is ever requested until an address is
typed, rather than a reason to gate on the build. A dev-mode prefill was tried and **rejected for a
test reason worth keeping**: `tests/e2e/app.test.ts` runs against the dev server and pins the
picker's contents with `toEqual`, so seeding an address there would make those listings depend on
whether the machine running them happens to have a server up. `EXAMPLE_LOCAL_URL` is a placeholder
only. Its catalogue is entirely the reader's: nothing is added to `MODELS`, and
`providers/localServerModels.ts` merges what `/models` reported (cached under
`codeview:local-server-seen`) with what they named by hand (`codeview:local-server-models`), **the
hand-added entry winning** so that naming a discovered model is an override — the one way to say it
thinks, or that its context is smaller than the budget assumes, neither of which `/models` reports.
**The cache exists because `allModels()` is synchronous and discovery is not**, and it is
_persisted_ rather than held in memory so a reload restores the picker at once and a remembered
model id still resolves before the probe returns — otherwise `useModel` quietly bumps the reader
onto a different model on every reload. A failed probe deliberately keeps the list: a server down
for a minute is not evidence it is gone. Three reasoning field names are read, not one
(`reasoning`, `reasoning_content`, `thinking`), because OpenRouter, llama.cpp/LM Studio and Ollama
each pick a different one, and a server that writes `<think>` into `content` needs nothing —
`markdown.ts` already folds it. The thinking switch is asked in **two dialects at once**
(`localReasoningFields`): `chat_template_kwargs.enable_thinking` for llama.cpp and vLLM, and
`reasoning_effort` (`none` / `medium`) for Ollama, whose OpenAI endpoint reads nothing else — the
first field alone left the switch dead there, a thinking model thinking whatever it said. Both are
sent **only** for an entry the reader flagged, since these servers disagree about unknown body
fields and a discovered entry must not be what finds that out; what `/models` cannot say the
settings pane now can, listing the discovered models each with a `thinks` box that _names_ the
model (the hand-added override the list already was) rather than adding a flag of its own. The failure that matters is the one with no
`Response` at all: `fetch` rejects with a `TypeError`, and `networkMessage` names the address and
all three causes rather than letting "Failed to fetch" stand. Its address is no part of a share
link, for the key's reason and one more — it means nothing wherever the link is opened.

**How a model is reached is a fifth tab, not a pane's own setting.** `SettingsPane.vue` is the
cogwheel at the far end of the row — no word on it, and `margin-left: auto` away from the four tabs
that are things to look at rather than things to set — and it holds the OpenRouter key, the reader's
added OpenRouter slugs, the local server's address and the models named on it by hand. Those four
were the chat's own settings panel while the chat was the only thing that spent them, which had the
agents tab sending a reader into a conversation they did not want in order to configure a run: they
are the same facts whichever pane asks, so they sit beside both. What did _not_ move is what belongs
to one asker — the chat's brief and its `Start from` shelf (its cogwheel now says **Prompt**, and
goes gold only for a rewritten brief), the agents' team and each agent's own model. The picker and
the `think` switch stay in both toolbars: they are the choice, not the configuration, and a reader
changing model mid-conversation should not have to leave it. Its own fields are **drafts under one
Save**, and that is load-bearing rather than inherited: `App.vue` probes the server whenever the
stored address changes, so a field writing through per keystroke would ask a dozen half-typed hosts
on the way to the real one. Each draft then _follows_ its stored value (`watch` per prop), since an
address is stored canonical and a draft left holding `localhost:11434` would read as unsaved against
the `http://localhost:11434/v1` that was kept. The tab's cogwheel goes gold once any of the four is
set — a configured key is invisible from everywhere else in the app — and `probe()` now runs on
opening this tab too, since the local server's discovery call _is_ that probe and its list is what
the tab exists to show.

`MODELS` in `chat.ts` is a static list, so `providers/index.ts`'s `allModels()` is what actually merges the
shipped catalogue with the reader's own — `usableModels()` and the new `findModel()` (the one
lookup `useModel`, `useAgents` and the agents pane use in place of `chat.ts`'s own `modelById`,
which only knows the shipped ones) both go through it. Adding or removing one does not touch the
GPU/builtin side of the picker, so `useModel.refreshModels()` exists as a narrow escape hatch —
called from `App.vue`'s watch on the reader's list — that reapplies whatever `probe` already
settled about the GPU without re-probing it. That engine is now
`useModel`'s and not the chat's: **one loaded model for the whole app**, one picker, one `thinking`
flag, shared with the agents tab, because a conversation and a run are two uses of the same weights
and a second engine would put the same gigabytes on the GPU twice. Consumers register through
`onChange` rather than watching `model` themselves — the host calls them _before_ it destroys the
old engine, so a session is never torn down after the thing underneath it.

Both WebGPU libraries are **dynamically imported inside workers** (`worker: { format: 'es' }`,
`optimizeDeps.exclude`), so they land in their own chunks and the main bundle is unchanged; check
that with a build before believing an edit. A GPU **adapter** is a fact about the browser, not the
model — Chrome exposes `navigator.gpu` on machines that hand back nothing — so `useChat.probe`
settles it once and drops every downloadable model when there is none — **except OpenRouter's**,
which needs no GPU and stays listed either way; what it needs instead is a key, which is a fact
about the reader's own settings, not the browser, so it is gated separately. That is what leaves the
pane with the bare "no language model" message only when neither a browser capability nor a key
can be had, rather than a picker full of things that cannot run.
`enable_thinking` is sent only for models flagged `thinking`, and its value is per _question_, not
per session — it rides `AskOptions`, because `extra_body` is a request field. WebLLM turns thinking
off by prefilling an empty `<think>` block, which would corrupt a model that has none. **Each
provider reaches the same flag by its own road**: WebLLM's is `extra_body`, while the ONNX
pipeline's is `tokenizer_encode_kwargs`, which it spreads into `apply_chat_template`. What comes
_back_ differs too, and that is the part with teeth. Gemma 4 answers in channels —
`<|channel>thought…<channel|>` — and those markers are **special tokens**, so the worker must turn
`skip_special_tokens` off for a thinking question or the reasoning arrives pasted onto the front of
the answer with nothing to separate them. `providers/thoughts.ts` translates the channel into the
`<think>` block `markdown.ts` already folds, and drops the protocol tokens that then come through
with it; it can work chunk by chunk because `TextStreamer` flushes a special token on its own, so a
marker never arrives split. The thought is kept out of the _history_, which is what Gemma's own
template does with a past turn's channels, and is why `withoutThoughts` sits between the stream and
`messages`. ONNX quantisation is the model's call, not the worker's: a repo's `transformers_js_config` names
what its weights were validated at, and forcing `q4f16` on a model that asks for `q4` (GLM-Edge)
fails. Anything fp16 on WebGPU is suspect for small models — the same reason Gemma 3 is absent,
while Gemma 4 is present because its publisher's own WebGPU demo runs these sessions at q4f16.
The Gemma 4 entries are also the one place a **multimodal** repo is loaded: `text-generation`
instantiates `Gemma4ForCausalLM` against weights whose architecture is
`Gemma4ForConditionalGeneration`, which Transformers.js reads as text-only and fetches
`embed_tokens` plus `decoder_model_merged` alone — never the vision or audio encoder. Nothing in
the provider knows this; it falls out of the repo's own config, which is also where the external
data chunk counts come from. Their size figures are those two files, and it is the per-layer
embeddings, not the 2.3B effective parameters, that make an "E2B" a 3 GB download. **`onnxruntime-web` is a 32-bit
wasm module** — its memory is declared `max=4.00 GiB` — and that address space, not the GPU and not
the machine's RAM, is what those two run out of: E2B's files claim 3.11 GB of it and E4B's 4.91 GB
before a prompt exists, leaving the session, the arenas and the prefill intermediates to share what
is left. Which is why `maxCodeChars` is **6 000** on the Gemma 4 entries and 14 000 on every other
ONNX one — the single budget in the catalogue sized by a memory ceiling rather than a context
window, since the intermediates grow with the listing and a big enough prompt ends in
`Failed to allocate memory for buffer mapping` on a machine with tens of gigabytes free. The other
two ONNX entries are ~1.2 GB of weights with nearly 3 GiB of room, and keep the wider budget. The
same fact decides which way `cpuEmbeddings` points: it is
a **lever on GPU memory**, and the only one those entries have: at q4f16 `embed_tokens` is 1.59 GB
against the decoder's 1.52 on E2B (2.02 against 2.89 on E4B), and it is a lookup table rather than
arithmetic, so `ModelChoice.cpuEmbeddings` runs it on the CPU and leaves the GPU to the decoder
alone. It is **off everywhere**, and on a machine with GPU memory to spare it should stay off: running a
session on `wasm` keeps its weights in the 4 GiB address space above, which is the scarce resource
there, so it trades the plentiful one for the scarce one and makes the failure it looks like a cure
for more likely. It is for the opposite machine — a GPU too small for both sessions — and what it
costs even then is `inputs_embeds` and `per_layer_inputs` crossing from CPU to GPU on every token,
which has not been measured. So it exists to be flipped on an entry and timed, not as a default. The record it builds lives in `providers/devices.ts`, its own
module for `ceiling.ts`'s reason, and the rule it encodes is the trap: Transformers.js dispatches a
device record per session **file**, and a file the record does not name falls back to the library's
default, which in a browser is `wasm` — so `SPLIT_SESSIONS` names _both_ sessions, or moving the
embeddings would take the decoder to the CPU with them. That is also why the field is only
meaningful on the Gemma 4 entries: every other ONNX model here is single-session (`model`), with
nothing to split and nothing to name. `tests/chat.test.ts` holds both halves.

The thinking prefill comes back in the answer, so `markdown.ts` parses `<think>` as a block kind: empty means protocol and is
dropped, non-empty is folded into a `<details>`, and an unterminated one is thinking-in-progress. `useChat` lives in `App.vue`, not in `ChatPane.vue`,
because the pane unmounts on every tab switch and a conversation must not. **That unmount is also
why both panes scroll to their end `onMounted`** and not only while streaming: a pane coming back
has no scroll position to restore and would open on the first message. The trace pane's analyze
buttons are what made it obvious — they file a question that is a whole trace _before_ the pane
exists, so the watcher that follows a growing conversation never sees it arrive and the reader
lands on the top of it with the answer forming out of sight. The system prompt (role,
the source/sink definitions, then **every open file**, line-numbered) is built once per session, so
the code it carries is a snapshot — edits raise a `stale` hint rather than silently rebuilding the
session, which would discard the conversation. The model is given every open file for the same reason the trace
crosses them: a taint flow usually leaves the file it starts in. What it is _not_ given is which
one is on screen beyond the ordering, so answers cite a file with every line number. The **role half** of that prompt is the reader's to rewrite — the cogwheel in the pane, `DEFAULT_ROLE`
in `chat.ts`, stored under `codeview:chat-role` **only while it differs**, so a later edit to the
shipped brief reaches everyone who never touched theirs. It also rides a link: `copyShareLink` takes
the brief as an argument (`App.vue` supplies it, since `useBuffer` knows nothing about the chat) and
writes `systemprompt=` only when one has been written, while `useChat` reads that key itself and
**does not store what a link supplied** — the link's brief must not overwrite the reader's own, which
is why `setRole` rather than the ref is what persists. It is also no part of `fromParams`, so a
chat-only link leaves the open tabs alone. The file listing is not editable, because it
is generated from the buffer rather than typed; `buildSystemPrompt` appends it under whatever the role
says, and a blank role falls back to the default rather than sending a model no instructions. Saving a
different brief drops the session and keeps the engine, for the same reason `newChat` does: the weights
did not change. `maxCodeChars` is the budget for all of them together, spent in the order given
— which is why `promptFiles` puts the file on screen first — and files that do not fit are named
rather than dropped silently. Staleness is measured in **tab order**, so switching tabs (which only
reorders the prompt) does not cost a conversation, while an edit, a rename or a close does. The availability probe waits for the tab to be opened.

**The agents tab is the same engine asked in a line instead of once.** `src/lib/agents.ts` is pure —
the briefs, the message each hop is asked, and the link format — and `useAgents` runs them. **The
whole design rests on one asymmetry: the orchestrator never sees the code, every sub-agent sees all
of it.** The orchestrator's session is built from `orchestratorPrompt` (its brief plus the roster)
and lives for the whole run, accumulating what each agent reported; each agent gets a _fresh_
session from the same `buildSystemPrompt` the chat uses, and it is destroyed the moment its step
ends — an agent is one question asked of the files, not a conversation. Five turns for two agents:
kickoff, agent, relay, agent, summary. The relay is **verbatim** (`handoffMessage` appends the
previous report word for word) because the orchestrator's paraphrase is exactly where a file, a line
and a name get lost — and it is defended three times over, since a model shown a verdict and asked
to write about it rewrites it by default: `DEFAULT_ORCHESTRATOR` forbids restating a report,
`relayMessage` forbids it again at the point of asking, and `handoffMessage` closes with the line
that actually settles it — where the brief and the report disagree, the report is authoritative.
Weakening any of the three is how a "mitigated" reaches the next agent as a "confirmed". **The
first agent gets the reader's task the same way, and for the same reason** — `handoffMessage` takes
it and copies it in verbatim ahead of the brief. Every hop therefore carries exactly one copy no
model in the middle wrote, and which one it is follows the chain: the task for the first agent, the
previous report for each one after. The gap was invisible while a task was a sentence and obvious
once it was not — **Analyze with agents** hands over a whole trace, the orchestrator boils it down
to a line, and the first agent was briefed on a flow it had never seen. It is deliberately **not**
repeated into every hop: a later agent already has a verbatim copy of its own, its job is the report
in front of it, and a second copy of a trace would compete with the code listing for one window; what the _orchestrator_ is given is clipped at `MAX_RELAY_CHARS`, and the clip
is stated. A run snapshots `promptFiles` once, so two agents cannot disagree about what line 12 says
because the reader typed in between.

**The subject of a run is the reader's task, and the orchestrator's brief must not compete with
it.** `DEFAULT_ORCHESTRATOR` deliberately names no review of its own: it describes the job — brief,
relay, summarise — and says outright that what to look for is the reader's to decide. An earlier
version opened with "the review you are running is a taint review", and the orchestrator followed
_that_ instead of the task in the box; a concrete mission in a system prompt beats a task mentioned
once in a message, every time. The taint vocabulary belongs to the agents, which is where it already
was (`DEFAULT_ROLE`) — the participant that cannot read a line of code is the last one that should
be holding opinions about what to look for. `tests/agents.test.ts` asserts the brief stays free of
`taint` and `sink` for exactly this reason. The task also rides **every** message the orchestrator is
asked for (`taskBlock`, in kickoff, relay _and_ summary), not just the first: mentioned once, a small
model has drifted back to whatever its own instructions made salient by the second brief.

**What a step shows and what it passes on are different text.** `speak` keeps the answer whole in
the transcript — `markdown.ts` folds a `<think>` block into a disclosure, and a reader may want to
open it — but returns `withoutThoughts(answer)`, and that return value is what the next hop's
message is built from. Thinking is the model working towards an answer, not the answer: relaying it
spends a small context window on working-out and invites the next agent to treat a discarded line of
thought as a finding. An answer that is _only_ thinking therefore returns nothing, which a brief
recovers from by falling back to the reader's task.

`StepKind` is a rendering contract as much as a data one: `task`, the orchestrator's `brief` /
`summary`, an `agent` report, and the hop in flight are all shown open — a run is read for its
findings, not clicked through, and the only thing that folds on its own is a model's `<think>` block
inside whichever step produced it. Every agent still gets a color of its own (`AGENT_COLORS` in
`AgentsPane.vue`, hashed from its name into a `--agent` custom property on the step), so a run of
several agents reads as several distinct voices rather than one undifferentiated scroll, and the
orchestrator's own steps (`brief`, `summary`) share a separate, single color throughout so they read
as one voice threading between the agents it briefs. A step does **not** keep what it was handed: a
handoff is the brief above it plus the report before it, and both are already rows in the same
transcript, so storing it would only render the same text twice. `tests/e2e/app.test.ts` asserts
that shape over `.step.task`, `.step.brief` and `details.report` (open by default, per the above),
and checks the relay against what actually reached the model (`__inputs`) rather than against the
DOM — along with the invariant itself, that the orchestrator's system prompt carries the roster and
no code while every agent's carries the file.

The team travels the way the chat's brief does and for the same reasons: stored under
`codeview:agents` **only while it differs** from `defaultTeam()`, read from an `agents=` link
without being persisted, and written into `copyShareLink` by `App.vue` (never reached for by
`useBuffer`, which knows nothing about models). It is a `--8<--` bundle — the same text format as
`files=`, through the same `serializeSections`/`parseSections` — with the orchestrator as the first
section, whatever its header says. `normalizeTeam` is not cosmetic: a name with a newline in it
would break the bundle, two agents answering to one name would leave the orchestrator briefing
whichever it meant, and a name holding `@` would come back out of a link as a shorter name on a
model nobody chose — because **an agent's model rides its header**: `--8<-- Triage @gemma-4-e4b`.
`AgentSpec.model` is a catalogue id, absent for "the run's model", and it is kept as an id rather
than resolved so a team survives a machine that cannot run what it names; `engineFor` then throws
naming the model, filed against the agent, rather than running it on something else.

**The hunters are a shelf, not a mode.** `src/lib/hunters.ts` is one `Record<string, string>` —
the name the picker shows, the complete system prompt — built from a shared opening and one of two
closings around the per-class half in `FOCUS`, so a change to how a finding is reported is one edit
rather than seventeen. The seventeenth is **Memory safety**, added with C and C++ — a flow class
whose carrier is the _length_ rather than the data, which is why it says to follow a size back as
carefully as a value, and the one class that also asks for lifetime bugs (use-after-free,
double-free) on the same path. Both panes offer them (`ChatPane`'s prompt editor, and every agent card in
`AgentsPane`, where the two shipped briefs sit in the same select), and picking one **only writes
the textarea**: there is no hunter id kept, no new key in a link and nothing downstream that knows
a brief came from here — an edited hunter is simply a brief of the reader's own, which is why the
select shows a name only while the text still equals that brief exactly and says _your own wording_
otherwise. They are deliberately shorter than `DEFAULT_ROLE` and capped at `HUNTER_CHAR_CAP`, and
**short means the tokens a hunt sends, not the file**: the opening and closing ride every hunt, so
they are where a saved character counts seventeen times over, and they were over half of each hunter
before they were cut. The opening is one line and teaches no taint vocabulary — a flow hunter's own
"what removes the taint" is the only version a single-issue hunt needs, and the five checklist
classes (BOLA, function-level authorization, CSRF, authentication, secrets) have no use for one.
Those five get the `check` closing, which asks for a where and a what-is-missing, because a
hop-by-hop path is the wrong shape for a missing decorator and each of their class halves already
says what to name; the rest get `flow`, which _shows_ the path shape as three numbered example hops
rather than describing it, since a small model copies a shape it is shown far more reliably than
one it is told about. The class halves are the concrete part — named sinks, named traps — and are
where the tokens should go; what was cut from them was the prose around the lists, chiefly the
reasons for a rule, which a model does not need. `tests/hunters.test.ts` holds the invariants: each
carries the citation-and-honesty rules (check the name is on the line, say plainly when nothing is
found) and hunts one class only, a flow hunter carries the numbered-hop shape and a checklist hunter
does not, the opening stays one line — and none may contain a `--8<--` line, since a hunter usually
ends up as an agent's role and rides a team bundle.

**The context window is a catalogue field, and the budgets follow it.** WebLLM's MLC list compiles
every model here to a 4 096-token override, and `ModelChoice.contextTokens` is what it actually runs
at — Qwen2.5-Coder 16k, Qwen3.5 32k (a full-attention layer only every fourth, so the KV cache is
cheap), Gemma 2 8k because its weights stop there. It is WebLLM-only the way `dtype` is ONNX-only:
neither the ONNX pipeline nor Chrome's model takes such a figure, and `tests/chat.test.ts` refuses
one on their entries. `maxCodeChars` is sized from it — ~3 chars a token of numbered code, ~7.5k
tokens held back for brief, handoff and generation — and the 8k entries are knowingly over-committed
at 14 000. **The agents pane spends the handoff from the code budget**: `maxCodeChars` was sized for
a chat, and an agent's question is a brief plus a whole report, so `useAgents` passes
`maxCodeChars − handoff.length` (floored at `MIN_AGENT_CODE_CHARS`) to `buildCodeMessage`, which
clips the listing and says so instead of the answer dying at the window with nothing to relay. The
relay clip scales too — `relayLimit(maxCodeChars)`, a third of the code budget and never under
`MAX_RELAY_CHARS` — with the orchestrator's two messages clipped at the picked model's limit and each
handoff at the receiving agent's. **Both OpenAI-compatible providers have their own ceiling**,
`MAX_HOSTED_TOKENS` and `MAX_LOCAL_TOKENS`, not `ceiling.ts`'s: on that API `max_tokens` also pays
for the reasoning, so 4096 is how a thinking model spends its whole allowance and returns no answer.
That `MAX_NEW_TOKENS` guards against a local model that loops does apply to `localserver` in a way it
does not to a hosted one — but reaching the ceiling is reported rather than swallowed, and the stop
button is on a GPU the reader owns, so it keeps the roomier figure too.
Their thought does not arrive in the text either — it is `delta.reasoning` (or
`reasoning_content`, or `thinking`) beside `delta.content` — so `foldReasoning` in
`providers/thoughts.ts` turns it into the `<think>` block everything else already handles, on every
stream regardless of the thinking flag, since a custom slug or a local reasoning model may reason
unasked. **A server may also leak the model's own protocol into `content`**, and an MLX build of
Gemma 4 does exactly that: the thought goes to `reasoning_content` and the closing `<channel|>` is
left in the answer, arriving mid-sentence in front of the reader. `dropTokens` takes those out —
gated by `protocolTokensFor(model)`, which is the whole of what keeps it from being a
find-and-replace over everybody's answers, since those strings are Gemma's and this repository's own
source is full of them. It is a **marker machine with a hold-back**, not a search per chunk, for
`toolFilter`'s reason: nothing lines a delta up with a token, and a missed one is what the reader
sees. It runs **per request** — a token cannot split across two HTTP responses — and what it filters
is what reaches the history too, so a later question is not asked against protocol. They are
**dropped rather than folded**: translating `<channel|>` into `</think>` would be right only where
the opening marker leaked too, and a stray closer with no block open renders as literal `</think>`. The shipped Review agent runs on `DEFAULT_REVIEW`, not `DEFAULT_ROLE`: the same
`REVIEWER_BRIEF` closed with "report every flow in full" instead of the chat's "keep answers
short", because an agent's report is the next agent's entire input and a system prompt asking for
brevity would beat any orchestrator brief asking for more.

**Per-agent models are the one exception to "one loaded model", and `useModel` still owns every
engine.** The picked engine is `loaded`; an agent's is an _extra_, loaded by `engineFor` on the
first hop that needs it and kept across runs for the same reason the picked one is kept across
chats. What bounds the extras is `retain`: `useAgents` watches the team and hands the host
`teamModels(team)`, and an extra nobody names is unloaded — re-asserted in `run`'s `finally`, since
a team can change under a run. Engines change hands rather than reloading where they can: the
`model` watcher promotes an extra that becomes the picked model and demotes a picked model that an
agent still names (`wanted`). The orchestrator has no model setting and never will — it runs on the
picked model, and the picker is still the chat's own. `thinkingNow(id)` and `maxCodeChars` are
looked up per agent for the same reason; the code _snapshot_ is still one per run. **The
orchestrator never thinks** (`ORCHESTRATOR_THINKS` in `useAgents`), whatever the reader's switch
says: it has no code to reason about, a brief is a pointer, and the summary is reports it is
forbidden to improve on — Qwen3.5 4B spent minutes weighing the wording of each, and an earlier
"keep it under 120 words" gave it a number to count on top. The brief asks for a shape and says
outright not to count or redraft; `tests/agents.test.ts` refuses a word figure.

Answers are Markdown, rendered by `markdown.ts` → `MarkdownText.vue` → `MarkdownSpans.vue` as
real elements — never `v-html`, which is what keeps model output from becoming markup. The parser's
odd-looking rules are deliberate: an unterminated fence is code (a streaming answer is always
mid-block), emphasis is `*`-only (`_` would italicise `snake_case`), and only `http(s)` targets
become links. Backticks are counted, not merely found — a run of _n_ opens a code span and only a
run of exactly _n_ closes it, which is how a model writing about this codebase gets a backtick
inside one (``console.log(`a`)``), and the same rule at block level is why a four-backtick fence
survives a ``` line inside it. `spansToText` therefore picks a delimiter longer than anything in
the span, since a wrapped list item is re-parsed from its own re-serialized text. A model reaching for LaTeX mid-sentence gets one concession: a `$…$` run
holding nothing _but_ arrow macros is spelled as the character (`SYMBOLS` in `markdown.ts`,
and adding a symbol means adding a row). Nothing but — which is what leaves `$5 to $10`, and
any macro the table has no character for, exactly as written.

**The brief is the system prompt; the code is a turn.** `buildSystemPrompt(role)` now returns the
brief and nothing else, and `buildCodeMessage({files, maxCodeChars})` returns the listing, which
`ModelEngine.chat(system, code)` seeds as a **hidden opening exchange** — a user turn carrying the
files, then `CODE_ACK` — ahead of the first real question. Instructions and data are different kinds
of thing, and a model told which is which is harder to talk out of its brief by something written in
a comment; the code message says so in its first sentence. **It is not a `tool` message, and that
was checked rather than assumed**: a tool message answers a tool call, and this one answers
nothing — it is handed over unasked, so there is no `tool_call_id` for it to carry. That holds
even where a tool role exists, which on two of the ONNX templates it now does; where it does not
(Chrome's `initialPrompts` is system/user/assistant, and MLC drops an assistant turn's
`tool_calls` when rendering) it could not have been one anyway. **`CODE_ACK` is load-bearing, not polite**:
Gemma's template raises on two user turns in a row, so the seeded history has to stay alternating.
The agents' orchestrator calls `chat(system)` with no second argument, which is now the whole
mechanism by which it never sees a file.

**No brief says how the code arrived, because no brief knows.** The same wording serves a model
handed every open file, one handed the two a question tagged, and one handed an index and a
`read_file` — so the claim belongs to the opening turn, which is the only thing that can tell them
apart, and that is the whole reason the brief is left untouched by the choice below. A brief that
says it is looking at the code is false on two of the three paths and false in the worst direction:
it tells a model that could read a file that it need not. `hunters.ts` had this right from the start
(`CITE`: "The code message already says how the files are numbered, so this does not"); the two
shipped briefs and the acknowledgement did not, and `REVIEWER_BRIEF`, `DEFAULT_TRIAGE` and
`CODE_ACK` were each rewritten to state only what is true on every path. `CODE_ACK` is the sharpest
case — seeded as the model's _own_ voice directly after an index whose first sentence is "you have
not seen any of their contents yet", "I have the files" wrote a contradiction into its mouth.
`tests/chat.test.ts` holds the rule over every shipped template at once, hunters included, so the
next one written cannot reintroduce it.

**A model that can call a tool is given the files to _read_ instead of the files, and that is one
decision made in one place.** `usesTools(choice)` — `ModelChoice.supportsTools` _and_ a provider
that can carry a call — picks between `buildCodeMessage` (the listing, as before) and
`buildIndexMessage` (names, languages and line counts, nothing else) for the same opening turn,
and hands `chat` a `ToolBox` in the second case. Both panes ask it at the one place they build
that turn, so the two cannot drift; the brief is untouched either way, which is deliberate —
it is the reader's to rewrite, and a rewrite must not be able to leave a model holding an index
it does not know what to do with, which is also why the instruction to read rides the index. The
flag is checked **against the provider** as well as read, because a mis-flagged entry that fell
through would be strictly worse off than a clipped listing and silent about it;
`tests/chat.test.ts` refuses the flag on a provider that cannot, and this is the belt.
`maxCodeChars` stops being a clip over everything and becomes the ceiling on **one `read_file`**,
which is the whole gain, so `clipped` is null on that path — there is nothing withheld to warn
about.

`src/lib/tools.ts` is pure and is both tools: `list_files` and `read_file(file, start?, end?)`.
Its rules were each a wrong answer first. **A schema rides every request** — and a tool loop makes
several per question — so the descriptions are one short line each and `tests/tools.test.ts` caps
them. A range the model wrote loosely (0, backwards, past the end) is **clamped rather than
refused**, and `"start": "12"` is read as a number, because a round spent on an error message is a
round not spent reading. A cut lands **on a line boundary** and says `start=N` for the rest, while
a range the model _asked_ for is not a cut and is not nudged — telling it to read on would have it
chase the rest of a file it deliberately sampled. A basename resolves to `lib/db.ts` (that is how
a model names a file in prose) but **only where it is unambiguous**, since guessing between two
would put the wrong code in front of a review. Nothing throws: a bad call is answered with what is
open, which the model can act on, where an exception would end the answer.

**Two providers can carry a call, and they are not the same mechanism.** On the OpenAI-compatible
side (`openaiCompatible.ts`) it is the API's own: one `fold` for the whole question rather than one
per request, an assistant turn carrying `tool_calls` and its `tool` answers pushed **together**
with nothing awaited between them (a history holding an ask with no answer is refused by the next
request, and an abort landing in that gap would leave the conversation unusable), and a round that
stopped at the token ceiling is not run — its arguments may have stopped half-written. At
`MAX_TOOL_ROUNDS` the tools are still **declared** and `tool_choice: 'none'` takes the option away,
because this API rejects a history of calls with nothing to declare them.

On the ONNX side there is no API at all: there is a chat template, and the model writes its call
into the **text**. `providers/onnxTools.ts` is therefore a **dialect** per family, each read off the
publisher's own files rather than guessed — Qwen's `<tool_call>` with JSON inside, which its
template prints the instructions for, and Gemma 4's `<|tool_call>call:name{…}`, whose tokenizer
config carries a `response_schema` naming the regexes and an argument syntax that is **not JSON**
(`key:value`, strings wrapped in its `escape_token` `<|"|>`, which is why they are scanned rather
than regexed: a string may hold any comma or brace it likes). A model whose template has no `tools`
variable (GLM-Edge) has **no dialect, is never offered any, and is never flagged** — and
`tests/onnxTools.test.ts` pins the catalogue and the parser to each other in both directions.
Gemma's markers are special tokens where Qwen's are merely added ones, so
`keepsSpecialTokens` decides whether the worker stops skipping them — which also lets the protocol
tokens through, and `foldChannels` is what drops those. The filter is a **marker machine over the
stream**, not a search per chunk, since nothing lines a token boundary up with a marker and a
missed one puts raw call syntax in front of the reader; a call the model never closed is dropped
whole. The worker parses and reports the calls on `done`, and the **provider runs them**, because
the files are on its side of the worker boundary.

**WebLLM is the one that cannot, and that is a fact about the library**:
`chat.completions.create` throws `UnsupportedModelIdError` for any model outside
`functionCallingModelIds` — five Hermes builds, none in this catalogue — so sending tools to a Qwen
or Gemma build there fails the question outright rather than degrading. Chrome's Prompt API has no
tool role. Both are handed the listing, unchanged.

**A rich artefact is the tool path's own temptation, and the trace is the rich artefact.** A trace
hands over an excerpt, a file and a line for every step — enough to write a plausible review from
without opening anything — so a model that can call `read_file` will often answer from the trace
instead of the code. Two things push back, both cheap: `traceToText`'s closing paragraph says the
quoted lines are excerpts and not the code, and `buildIndexMessage`'s tagged line says **read them**
rather than _start there_ — an instruction beats a suggestion when what it is competing with is a
page of code excerpts already in the question. Neither is a guarantee, which is why the row below
matters more than either.

**A conversation that never read anything says so**, and that is the one case the rows above would
otherwise leave blank. A model handed a toolbox can narrate "I must first read the files" and then
end its turn — no call, no row, and a well-formed answer resting on nothing but the file list. Both
tool providers therefore keep an `everRead` flag **per session** and emit `NO_READS_NOTE` as a
closing row where it is still false; per session rather than per question, since a follow-up resting
on a file already in the history is ordinary. It is worth having because the cause is usually
outside this app — a server that does not translate its model's tool syntax into `tool_calls`, or a
small model that plans instead of calling — and none of those are visible from the answer.

**Every call is written into the answer as its own `<tool>` row** — `markdown.ts`'s third
model-output block, beside `think` — and the difference between the two is the point. A thought is
folded away; a tool row is **shown**, because what a model was allowed to read is the first thing
worth checking about an answer it built by reading, and one that quietly read half a file must not
look like one that read the file it cites. Both are stripped by `withoutThoughts`, which is
therefore about the _working-out_ rather than about thinking: the model already holds the file
contents in its own history, and relaying `read_file routes.ts lines 1-40` to the next agent spends
its window on a line it cannot check. The rows are emitted as **siblings** of a thought, never
inside one: `fold.end()` closes any open `<think>` first, and `parseMarkdown` tries `TOOL` **before**
`THINK` — taken the other way round, a `<think>` would run from the first open marker past a row to
the next close and swallow it. The ONNX path hides the raw call syntax the model wrote and the
provider writes the rows itself, since that syntax is the model's own protocol rather than anything
a reader wants.

A reader-added model carries the flag too (`tools` on both `CustomOpenRouterModel` and
`LocalServerModel`, a checkbox beside `thinks` in the settings tab), and for the same reason
`thinking` is theirs to set: OpenRouter's `/models` reports `tools` in `supported_parameters` but a
local server reports nothing of the kind, and a runtime will happily accept the field for a model
whose template has nowhere to put it. Both lists' saved rows now **toggle** in place rather than
showing a badge, through a setter that rewrites the draft immutably — `v-model` on a row would
write straight through to the stored object and break the drafts-under-one-Save rule.

**Pure vs. impure.** `src/lib/{agents,analyzer,astTree,definitions,files,flow,mentions,share}.ts` are pure and
unit-tested over fixture strings — as are `normalizeBaseUrl` and `toModelChoice`
(`tests/localServer.test.ts`), the two halves of the local provider that touch neither storage nor
the network; the rest of it, like the OpenRouter key and its added models, is browser-bound — — the analyzer's fixtures are now _sets_ of files, which is how
cross-file resolution and cross-file traces are tested; everything else is browser-bound and covered only by the e2e suites.
`chat.ts` is the mixed case: `buildSystemPrompt`/`numberLines`/`promptFiles`/`describeStatus` are
pure, the `MODELS` catalogue is data, and only the provider seam is not. `stream.ts` is the shared
read loop both panes accumulate an answer with, and it is where an answer learns it was **cut off**:
both providers cap generation at one `MAX_NEW_TOKENS` (`providers/ceiling.ts`, its own module so
the ONNX worker's bundle does not pull the catalogue in for a number) — a ceiling against a model
that never emits its end of turn, not a per-model figure and not a target, so it is deliberately
generous and shared between thinking and answer. The ONNX worker counts tokens with a stopping
criterion and reports reaching it on `done`. **A failure has to find the same route back**, which
is subtler than it looks: `transformers.ts`'s `fail` hands an error to whichever of `ready`/`pending`
is actually waiting, because `worker.onerror` used to close over the _load_ promise's `reject` and
so delivered every failure after load to a settled promise — leaving the pane waiting on a stream
that had already stopped. A worker-level error is `fatal` and latches `broken`, since posting to a
dead worker is silence rather than an error; an exception the worker caught and reported is not,
since it is still there to answer the next question. What escapes the worker's own try/catch comes
back through `onunhandledrejection`, which is where a WebGPU device dying mid-run actually
surfaces — ORT's async work is not the call being awaited, and that call may never settle at all.
There is deliberately **no timeout**: a large listing on a small model legitimately takes minutes
before its first token, and a watchdog that cannot tell that from a dead device would abort real
answers. WebLLM reports `finish_reason: 'length'`, which is
also what a **full context window** produces — a long thought over a large listing ends there,
silently, unless it is read. Neither provider has a thinking budget to offer: WebLLM lets no
assistant prefill through, so a thought cannot be closed early. The stream stays
`ReadableStream<string>` (the built-in provider hands Chrome's own through untouched), so the flag
travels beside it as `AskOptions.onTruncated`, which `streamAnswer` installs and returns as
`Answer.truncated`; both panes append `TRUNCATED_NOTE`, and the agents pane relays it to the next
hop for the same reason the code listing states its clip. An answer that is only thinking gets no
note, or the note would be handed on as the whole report. Both providers keep
`withoutThoughts(answer)` in the history, not the thought: Qwen's and Gemma's own templates drop a
past turn's reasoning, and in an 8 k window it would otherwise crowd out the next question.
**Sampling is chosen per question, not only per model**: `ModelChoice.sampling` is the row for a
plain answer and `thinkingSampling` the one for a thinking question, and the provider picks between
them from `AskOptions.thinking` (falling back to `sampling` where there is only one row). Qwen3.5
publishes four rows and needs two of them: thinking runs the card's **precise-coding** row
(`0.6 / 0.95 / presence 0`), not its general one (`1.0 / 0.95 / presence 1.5`), because every row on
that card assumes `top_k=20` and WebLLM has no field for it — at temperature 1.0 over a 0.95 nucleus
the leftover tail is far fatter than Qwen intends, which is where a long thought circles. The lower
temperature is the nearest substitute WebLLM has for the missing top-k; the general row's presence
penalty was tried first as Qwen's own anti-loop remedy and looped anyway, and pushing a reviewer
away from what it has already said fits badly with citing the code's identifiers. A `repetition_penalty` of **1.05 on both rows is the one figure with no row behind it** — the card
leaves every row at 1.0 — added because a thought still circled at 0.6; it is deliberately milder
than Qwen2.5-Coder's shipped 1.1, because the penalty falls on the code's own identifiers, which a
citation has to repeat. Non-thinking runs the card's instruct row (`0.7 / 0.8 / presence 1.5`),
which is what the agents' orchestrator now uses throughout. **Sampling is a catalogue field, not a knob**: `ModelChoice.sampling` carries what a model's
publisher recommends over its weights' own defaults, rides `LoadOptions` like `dtype`, and is
applied on every question. It exists because **MLC builds do not carry the publisher's
`generation_config.json`**: Qwen3.5's and Qwen2.5-Coder's `mlc-chat-config.json` ship `top_p 1.0`
(and, for Coder, no repetition penalty) where the cards say 0.95 / 0.8 and 1.1, and Gemma 2's
ships MLC's own 0.7/0.9. So every WebLLM entry names its publisher's row (`QWEN3_SAMPLING`,
`QWEN25_CODER_SAMPLING`, `GEMMA2_SAMPLING`), each with its source in the comment. The ONNX
entries name none, and that is not an omission: Transformers.js reads the repo's own
`generation_config.json` (so ONNX Qwen2.5-Coder already has its 1.1), and the pipeline runs
greedy, so a card's sampling row has nothing to apply to — GLM-Edge publishes none and Gemma 4's
card names no penalty. WebLLM takes `temperature`, `top_p`,
`presence_penalty` and `repetition_penalty` (no `top_k`/`min_p` field); the ONNX pipeline only the
repetition penalty, since it runs greedy on purpose, so anything else on an ONNX entry is a figure
nothing reads, and `tests/chat.test.ts` refuses it. Unset means the weights' own config decides —
each field is spread in only when set, never sent as null.

## Things that will bite

- **Monaco owns both click modifiers.** Alt-click adds a cursor, ctrl/cmd-click goes to a
  definition, and `multiCursorModifier` only swaps which is which — there is no free click gesture.
  Trace is registered with `editor.addAction` (context menu + `Alt+T`) for exactly this reason; an
  earlier alt-click binding just opened Monaco's definition peek over the editor.
- **`typescript` is pinned to `^6`.** TS 7's package dropped the classic compiler API (`exports["."]`
  is `lib/version.cjs`); the browser-side AST work needs 6.x's `lib/typescript.js`. Do not bump to 7.
- **Monaco workers are wired explicitly** in `monacoSetup.ts` via `?worker` imports, because a
  production build (unlike dev) leaves Monaco's self-spawned worker URLs dangling. Import specifiers
  are `monaco-editor/editor/editor.worker?worker` — monaco 0.56's exports map is `"./*" ->
"./esm/vs/*.js"`, so the older `monaco-editor/esm/vs/…` form silently resolves to a doubled path.
  `getWorker` must return something for every label; there is no fallback. `tests/e2e/dist.test.ts`
  exists solely to catch regressions here, since dev and prod disagree.
- **Highlights use Monaco's `inlineClassName`, not `className`** — the latter renders a positioned
  box behind the text, which loses the tint-plus-underline effect.
- **Programmatic cursor moves are wrapped in a suppression flag** (`withoutCursorEvents` in
  `EditorPane.vue`) so the resulting change event isn't mistaken for a user action and bounced back.
- **Monaco models need a real file extension in their URI** (`inmemory://codeview/<file id>.tsx`);
  the TS worker keys off it and will flag valid TypeScript as errors without it. The URI is keyed by
  file **id**, not name, so it survives a rename — but a language switch still means a new model,
  and `showActive` in `EditorPane.vue` is the one place that swaps them. It saves the outgoing view
  state _before_ asking for the new model, re-applies every decoration after (detaching a model
  drops them), and emits a `cursor` event, since the same offset means something else in another
  buffer. The `modelValue` watcher beside it targets the model for `props.fileId` rather than the
  attached one: on a tab switch both props change at once, and writing the new text into the
  outgoing model would silently overwrite the file being left behind.
- **A tab's rename field is focused after `nextTick`, not in the ref callback.** Vue re-invokes a
  function ref on every patch, and `v-model`'s own mounted hook writes `value` back afterwards —
  either one drops the selection, which is what puts the caret in the middle of the old name.
- **`ts.SyntaxKind` reverse lookup is unreliable** — the enum aliases range markers onto real kinds,
  so `VariableStatement` comes back as `FirstStatement`. Use `kindName()` from `astTree.ts`.
- **Share fragments are parsed by hand, not with `URLSearchParams`**, which decodes `+` as a space
  and would corrupt hand-written source. Keys are lower-cased; values are left verbatim — except
  `systemprompt`, the one key holding prose rather than code, where `+` **is** a space and `%2B` a
  literal plus (`PROSE_KEYS` in `share.ts`). That swap runs on the still-encoded value, before the
  percent-decoding, which is the only order in which those two survive each other. `z.` marks
  a deflated payload, `r.` an uncompressed one, and anything unprefixed or undecodable is read as
  literal source.
- **`files=` is `src=` for the whole strip**, and goes through the same `z.`/`r.`/literal rules — a
  hand-written bundle must keep working, which is why it is a text format and not JSON-in-base64.
  One payload for all the tabs, not one per tab: files that import each other compress against each
  other. `serializeFiles`/`parseFiles` round-trip exactly, and the rule that buys it is that **the
  newline before a `--8<--` header belongs to the header** — change that and every file that ends
  without a newline gains one on the way through a link. `copyShareLink` still writes the old
  `src`/`lang`/`filename` form for a lone tab: shorter, and every existing link and embed keeps
  working. It never touches the reader's own address bar any more — only the clipboard (falling
  back to putting the link in the notice text if that write is refused) — since the address bar is
  a live view of _their_ buffer, not the one being handed to someone else.
- **The fragment is dropped from the address bar once, right after every composable that reads it
  (`useBuffer`, `useChat`, `useAgents`) has captured what it needs, in `App.vue`.** Each parses
  `location.hash` synchronously on construction even though applying a linked value is itself
  async, so dropping it once all three have run still lets it overload `localStorage` for that one
  load. Without this, editing after opening a link and then reloading would snap straight back to
  the link's content, since `fromParams` would still be true; dropping the hash means a reload
  falls back to `localStorage` instead, which every edit already keeps current. `dropFragment` in
  `share.ts` is the one place that does this — a no-op when there is no hash, which is the common
  case — and it is _not_ a watcher on ongoing edits: once dropped, there is nothing left to change
  out from under.
- **The caret rule.** A caret sits _between_ characters, so a cursor at the end of a word is one past
  the identifier it belongs to. Both `findNodeAtOffset` and `identifierAt` look one character left
  when the caret isn't inside a token. Any new offset→node lookup needs the same rule.
- `window.__codeviewEditor` is a **dev-only** test hook (`import.meta.env.DEV`); `dist.test.ts`
  therefore locates text by walking the DOM instead.

Prettier: no semicolons, single quotes, 100 columns.

## Reference

`README.md` documents the URL parameters (`src`, `lang`, `filename`, `hideHeader`), the highlight
rules per construct, the reasoning behind the definition rules (signature clipping, the property
fallback), and what the trace can and cannot follow. Consult it before changing behaviour in
`src/lib/definitions.ts` or `src/lib/flow.ts` — each rule there is a deliberate choice, not an
accident, and the trace's limits (no aliasing, no path sensitivity, callbacks unreachable) are
stated in the UI as well as the docs. Keep them stated: a provenance tool that quietly misses a
path is worse than one that admits it.
