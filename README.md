# codeview

**Live demo:** https://eoftedal.github.io/codeview/

Explore a TypeScript, JavaScript, Python or Java file as a syntax tree. Monaco on the left, the AST on
the right, kept in sync both ways: move the cursor and the tree follows, click a node and
the editor follows.

On top of that, whatever sits under the cursor gets its **definition** highlighted — the
declaration a name actually resolves to, not the first thing with a matching name. Ask for a
**trace** and it goes further, walking that value back through assignments, return values and
call-site arguments until it reaches a constant, an import, or something the file cannot see.

Vue 3 + TypeScript, no backend — the code you paste never leaves the browser. (The optional
chat models are downloaded _to_ the browser; nothing is ever uploaded.)

## Running it

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # static bundle in dist/
npm test          # tree and definition rules
npm run test:e2e  # puppeteer: the dev server and the built bundle
npm run format    # prettier
```

The build output is plain static files; drop `dist/` on any host. Pushing to `main` builds
and publishes it to https://eoftedal.github.io/codeview/ — see
`.github/workflows/deploy.yml`.

Paste or type into the editor, open local files (button or drag-and-drop), or share a
buffer with **Copy link**. The open files are kept in `localStorage` between visits.

**Open folder** takes a whole directory, and a folder can be dropped on the editor as well
as picked. It is walked recursively; anything this viewer cannot parse is skipped without a
word, and so is everything under a directory that holds no source worth reading —
`node_modules`, `vendor`, `dist`, `build`, `out`, `target`, `coverage`, `__pycache__`,
`venv`, and anything dotted, `.git` first among them. A folder you pick yourself is always
walked, so dropping `dist` on purpose does open `dist`. Files arrive under their **paths**
(`src/lib/db.ts`), which is what keeps two `index.ts` apart and what lets an import between
them resolve; the picked folder's own name is dropped from the front, since every file
shares it. At most 50 tabs stay open — a folder with more keeps the files nearest its root
and says how many it left out, which is the point at which to open a subfolder instead.

**Cmd+P** (Ctrl+P) is quick open: type part of a name and press ↵. The match is a
subsequence, so `slb` finds `src/lib/base.ts`, and the ranking prefers letters that run
together, letters that start a word, and letters in the file's own name over the directories
above it. The list starts in the order the files were last shown, with the row below the
current one armed — so Cmd+P then ↵ toggles between the two files you are working in. ↑↓ or
tab moves, esc dismisses.

Several files can be open at once, on a tab strip above the editor: **+** adds a blank one,
**✕** closes one, and right-clicking a tab offers **Rename**, which also switches the
language when the new extension calls for a different one. The tree and the editor show the
active tab, but **all of them are analysed together**: a tab's name is its module path, so
an import from one tab to another resolves and a trace follows it across. Two tabs may not
share a name, or an import would be ambiguous. Closing the last tab is not offered, since
there is always a buffer. A share link carries the whole strip.

A share link carries the code in the URL fragment, which browsers never send to the server
— so shared code stays between the people holding the link. **Copy link** deflates (raw
DEFLATE via `CompressionStream`, no dependency) and base64urls the result.

With one tab open it writes the plain, older form, `#src=z.<payload>&lang=ts&filename=…`.
With several it writes `#files=z.<payload>&active=<name>`, and the payload is every open
tab in one stream — one deflate over the whole set is markedly shorter than a payload per
file, since files that import each other repeat each other's names. Opening such a link
opens those tabs, under their own names, on the one the sender was looking at.

Anything without a `z.` prefix is read literally, so both forms can be written by hand:

    #src=const%20answer%20%3D%2042&lang=ts

    #files=--8<-- a.ts%0Aexport const a = 1%0A--8<-- b.ts%0Aimport { a } from './a'

A bundle is a header line per file (`--8<-- name`) followed by its source, verbatim. The
newline in front of a header belongs to the header, which is what makes the round trip
exact for a file that ends without one. A payload with no header at all is one unnamed
file, so `files=` degrades to exactly what `src=` means. Two entries with the same name
would make an import ambiguous, so the second becomes `db-2.ts`.

The fragment is parsed without `URLSearchParams`, which decodes `+` as a space and would
quietly corrupt hand-written source. A prefixed payload that fails to decode is treated as
literal too — source starting with `z.` is likelier than a corrupt link. The exceptions are
`systemprompt` and `agents`, which are prose rather than code and so take the ordinary reading:
`+` is a space there, and `%2B` a literal plus.

## Parameters

Read from the query string and the fragment alike, the fragment winning where both name a
key. Key names are case-insensitive, since these get typed by hand.

| Parameter      | Effect                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src`          | the buffer — `z.`/`r.` payload, or literal source                                                                  |
| `lang`         | `ts`, `tsx`, `js`, `jsx`, `py` or `java`                                                                           |
| `filename`     | names the tab; its extension picks the language when `lang` is absent. **Copy link** carries it along              |
| `hideHeader`   | hides the title bar, language switcher and buttons, for embedding                                                  |
| `systemprompt` | the chat's brief — `z.`/`r.` payload, or literal text. **Copy link** carries it only when you have rewritten it    |
| `agents`       | the agents tab's team, as a `--8<--` bundle — same rules. **Copy link** carries it only when you have rewritten it |

Any of these describes what the link is about, so it opens with those files rather than the
tabs the reader happened to leave open. Without them, the last session comes back whole;
the seed buffer arrives as `example.ts` — or `example.py`, with its own sample, when the link asks
for Python — because every tab needs a name. `systemprompt` and
`agents` are the exceptions on both counts: neither says anything about which files are open, so
they leave the reader's tabs alone, and both belong to the link rather than to the reader — they
are not written to `localStorage`, so opening someone else's link cannot overwrite a brief or a
team you wrote yourself. Both can be written out in the clear, spaces and all:

    #systemprompt=you+are+a+reviewer+who+only+reports+SQL+injection

    #agents=--8%3C--+orchestrator%0AYou+brief+them.%0A--8%3C--+Scan%0ARead+the+routes.

An agent's header may name the model it runs on — `--8<-- Scan @gemma-4-e4b`, using the id from
the picker's catalogue — and one that does not runs on the model picked for the run. `@` is
reserved for this and is stripped from names.

`hideHeader` needs no value, though `=false`/`=0`/`=no`/`=off` turns it off. It leaves the
tab strip alone, so an embed can still say which file it is showing:

    ?hideHeader&filename=src/services/Connection.ts

## What gets highlighted

| Under the cursor            | Highlighted                                                     |
| --------------------------- | --------------------------------------------------------------- |
| a variable                  | its whole declaration, `const`/`let`/`var` included             |
| a parameter                 | the parameter — even where it shadows an outer name             |
| a function, class or method | the first line of the signature, body excluded                  |
| an object property          | the property assignment, with the object's creation site dimmed |
| a destructured binding      | the binding element, with its declaration dimmed                |
| an imported name            | the import statement                                            |

The parameter rule is the one that makes the tool worth using: a name that enters scope as
a parameter is _defined_ by that parameter, not by whatever value was passed in at some
call site. The same goes for a destructured binding.

## How the definitions work

Both halves come from the TypeScript compiler API over a single in-memory file
(`src/lib/analyzer.ts`): `ts.forEachChild` builds the tree, and `getDefinitionAtPosition`
answers the definition question. There is no hand-written scope analyser — TypeScript
already resolves shadowing, closures, destructuring and property access correctly, so the
work in `src/lib/definitions.ts` is mapping its answer onto a range worth highlighting:

- **Signature clipping.** A definition hit points at a name; a reader wants the
  declaration. For anything function-like the range runs from the declaration's start to
  whichever comes first, the body or the end of that line — so a multi-line parameter list
  highlights `function wide(` rather than dragging in three lines of parameters.
- **The property fallback.** `cfg.host` where `cfg` is an untyped JS parameter has no
  definition of its own. Rather than give up, the lookup retries on the object expression,
  which lands on the parameter — the same answer the parameter rule would give.
- **The caret rule.** A caret sits _between_ characters, so a cursor at the end of a word —
  where clicking a word usually leaves it — is one past the identifier it belongs to. Both
  lookups look one character left when the caret isn't inside a token.

The analyzer runs with `noLib`, so nothing resolves into the standard library. It does
resolve **between the open tabs**: a tab's name is its module path, so `import { x } from
'./db'` finds the tab called `db.ts`, `db.js`, `lib/db.ts` or `lib/index.ts`, exactly as a
bundler would — no extension needed. An import of anything that is not open (`express`,
`node:fs`) still resolves to nothing.

The editor shows one file, so a declaration in another tab has no range to highlight: an
imported name still answers with its import statement, and the header adds → `db.ts` to say
which tab holds the real declaration.

### Python

Python is parsed by [tree-sitter](https://tree-sitter.github.io/) rather than by the TypeScript
compiler, so the tree is a tree-sitter tree — `module`, `function_definition`, `identifier` — and
the definitions come from a scope binder of our own rather than from a type checker. The answers
have the same shape as the TypeScript ones: the same reasons, the same signature clipping, the same
`defined in` when a name is declared in another tab.

Three of Python's rules differ from TypeScript's in ways worth stating, because a reader arriving
from the other side gets them wrong:

- **`if`, `for`, `while`, `with` and `try` are not scopes.** A name bound inside one is visible
  after it.
- **A class body is invisible from inside a method.** A method reaches a class attribute through
  `self`, never by bare name — and this tool resolves it the same way.
- **A comprehension is a scope**, so its target does not leak out of it.

An assignment anywhere in a function makes that name local throughout the function, so a use above
the assignment still resolves to it. Where a name is bound more than once, the binding in force is
the last one at or before the cursor, falling back to the first in the scope. That is an
approximation of shadowing in time, which is the most a static reading of a dynamic language can
offer.

Builtins — `print`, `len`, `open` — deliberately do not resolve, for the same reason nothing from
`lib.d.ts` resolves on the TypeScript side: with only the open tabs to go on, a name with no
declaration _is_ one that came from outside.

**Attributes resolve by name, not by type**, and only in three shapes: `self.x` inside a class,
`C.x` where `C` is a class in an open tab, and a method reached either way.

Base classes **are** followed, including into another tab — `class UserView(BaseView)` resolves
`self.template` to whatever `BaseView` declares, wherever `BaseView` lives. The walk is depth-first
and left to right, which agrees with Python's own C3 linearization for any hierarchy without
diamonds, and the class itself always wins over its bases, so an override resolves to the override.
A base in no open tab simply ends that branch. Only bare identifiers count as bases: a dotted one
(`models.Model`) would need the module resolved first, and is almost always external anyway.

Anything else — `obj.method()` where `obj` came from a function's return value — falls back to
showing where `obj` itself came from, and says so by pointing at that declaration instead. It never
guesses at an attribute.

The **backward trace works too**, and follows the same rules as the TypeScript one — assignments,
returns, call-site arguments, across tabs wherever an import leads. Three Python-specific points are
worth knowing:

- **Every interpolation of an f-string is followed.** `f"SELECT {name}"` is not a literal; `name` is
  a step in the chain, which is usually the whole point.
- **Constructing a class is treated as a call to its `__init__`**, because nothing in the source
  says so — the call site reads `Connection(host)`. Without that link every constructor parameter
  would dead-end as an entry point.
- **A value carried inside a wrapper object is followed through it.** A value read from a request,
  stored on an object, passed down and read back out is the shape most taint actually takes, and
  `w.value` on an untyped `w` cannot be named. So the attribute's _name_ rides the fallback branch,
  and a construction of a class that has such an attribute connects back to the argument that set
  it — the chain runs from the read, through the constructor, to the request. A construction with
  no attribute being sought is still just a literal.
- **A method call on a receiver the tool cannot name** — `C().use(x)`, `self.conn.use(x)` — is
  matched on the method name alone, but only where that name is declared exactly once across the
  open tabs. That over-approximates, which a _may_-analysis is allowed to do; where the name is
  declared more than once, matching would be a guess between them, so only a receiver that resolves
  counts.

What Python support does **not** do:

- **No cross-language resolution.** A `.py` tab and a `.ts` tab are in separate programs. Python's
  `import db` never finds `db.ts`, and there is no build system here to say that it should.
- `from m import *` binds nothing, so every name it would have brought in reads as external.
- Dynamic attributes (`getattr`, `__getattr__`), `globals()`, `exec` and `__all__` re-exports are
  out of reach.
- Decorators do not rewrite meaning: a name decorated with `@property` still resolves as the
  function it is written as.

### Java

Java is parsed by tree-sitter too, with a binder of its own — and three of its rules are the
opposite of Python's, which is worth stating because the panes look identical:

- **A block is a scope.** A name declared inside `{ … }` does not escape it, where Python's `if`
  body leaks into the enclosing function.
- **A class body is visible from its methods.** A method reads a field by bare name; Python needs
  `self`, and this tool resolves each the way its own language does.
- **Declaration precedes use** for locals, so there is no "assignment anywhere makes it local" rule
  to approximate.

**Overloads are separated by arity** — how many arguments the call passes. That is all a reader
without types has, and it is usually enough, since overloads differ in arity far more often than
they differ only in parameter type. Where arity cannot separate them the first declaration wins;
that is a real limit, not a resolution.

**A receiver's type is written down, which Java gives and Python does not.** `Db db = new Db();`
says what `db` is on the line, so `db.load()` follows into `Db.load` — the member resolution Python
has to decline. It works for a local, a field or a parameter whose type names a type in an open tab;
a receiver whose type is not written down locally (a chained call, a field of a type from outside)
leaves its members unresolvable, and the answer degrades to where the receiver came from.

**A record is followed through as a value wrapper**, which is what records are mostly used for. Two
things a record declares without writing them down anywhere: an accessor per component, so
`id.value()` calls a method that appears nowhere; and the component itself, which _is_ the canonical
constructor's parameter. Both are resolved, so a value wrapped in a record — the common Spring shape
of a path variable turned into a `ProductId` and handed to a repository — traces from the unwrapped
read all the way back to the request. A plain class with a constructor and a getter reads the same
way: a method whose body is just `return value;` is a read of that field.

**Reading a member follows the receiver, not the type.** `id.value()` asks about one field of _this_
object, so the walk continues along wherever `id` came from and consumes the member at the
construction that actually made it. Expanding the member on its own would instead reach every
construction of the type in the open tabs — including objects the value never came through, such as
a repository that also _builds_ a `ProductId` when mapping a row. That is a path that cannot happen,
which is worse than a noisy one.

**A `var` receiver reads its type off the construction.** `var w = new Wrapper(x)` writes the type
on the `new` rather than on the declaration, and `var` is how most modern Java spells a local — so
`w.getValue()` follows into `Wrapper` either way. A wrapper object therefore needs no special
handling here: the getter returns the field, the field was set by the constructor, and the
constructor was called with the value.

**A type in the same package needs no import**, and that is the shape most pasted pairs of files
take — so an unresolved type name also looks for a tab declaring a top-level type of that name.
Where the declaration is in another tab it has no range on screen, so the highlight lands on
whatever named it here: the import, the `extends` clause, the receiver's own declaration, or the
identifier itself.

The **backward trace works the same way**, with one Java-specific cost: `x = …` declares nothing in
Java, so reassignments come from a scan that resolves each assignment back to the same declaration,
where Python's binder hands them over for free. Constructing an object is treated as a call to the
constructor, so a field set in one reaches the `new` that supplied it.

What Java support does **not** do: resolve a member on a receiver whose type is not written down;
separate overloads that share an arity; follow a supertype, an import or a static member outside the
open tabs; or know anything about generics, annotations that generate code, or reflection.

## Tracing a value back to its sources

The definition question stops after one step. **Trace** — the button in the right pane, `Alt+T` in
the editor, or the editor's context menu — keeps going, and answers _where did this value actually
come from?_

Each step is one hop backwards. A variable leads to its initializer and to every later assignment;
a call leads into the callee's `return` statements; a parameter leads out to every call site and the
argument sitting at its index. That last edge is the one that makes it worth having — it is the step
you otherwise make by hand, scrolling to find who calls this thing.

**A tagged template is a call**, and the walk treats it as one: in `` sql`SELECT ${id}` `` the tag
`sql` is the callee and the `${…}` substitutions are the arguments. The trace goes into the `return`
statements of `sql` when `sql` is one of the open files, and keeps every substitution as a child when
it is not — which is the edge an injection trace turns on. Parameters run one place ahead of the
substitutions, because the runtime hands the tag its strings array first: substitution 0 arrives in
parameter 1 of `sql(strings, ...values)`, so tracing `values` still reaches every interpolated
expression at every tagged call site. `strings` is the one parameter nothing in the source fills in,
so that branch ends at the declaration rather than pretending a substitution reached it.

The walk ends where it honestly can:

| Terminal          | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `defined here`    | a constant, a function, or an object built on the spot        |
| `another module`  | an import of something no tab holds — `express`, `node:fs`    |
| `outside`         | a name with no declaration at all — a global, say             |
| `uncalled here`   | a parameter no call site in the open files fills in           |
| `caller supplies` | a parameter of a function handed to something else to invoke  |
| `seen above`      | a cycle — the same declaration is already expanded further up |

**The walk crosses files.** An import between tabs resolves, so the trace follows a value into the
callee's body wherever it lives — and back out again, because find-all-references crosses an import
too, so a parameter still reaches the argument at every call site including the ones in other tabs.
Each step is labelled with the file it is in (`store.ts:6`), the summary says how many files the
path touched, and clicking a step in another tab opens it. The editor only decorates the steps in
the tab on screen: a span is an offset into one file and means nothing in another. The parameter a
value _arrives_ as is marked too, with a dashed underline rather than a step's tint — the walk
collapses the hop from a name to its declaration, so that parameter is on the path without being a
step, and where the trace leaves for the call sites it would otherwise go unmarked entirely.

`noLib` does the interesting work at the end. Because nothing resolves into the standard library,
**a name with no definition is by construction external** — so `process.env.TOKEN` and
`document.location` fall out as sources with no list of dangerous globals to maintain. An
unresolvable call keeps its arguments and its receiver as children, so `untrusted.trim()` still
leads back to `untrusted` rather than dead-ending on an unknown method — and a tag no open file
declares keeps its substitutions the same way.

The same cut runs through property chains, and it is why the walk does not stop at the first thing
it cannot type. In an express handler, `Request` never resolves, so `req.params.id` has no
declaration of its own — but the _object_ does, so the trace steps out through `req.params` to `req`
and lands on the route handler's parameter:

```
parameter `productId`            productId: string    9
  passed to `getProductById`     productId           16
    initialised from             req.params.id       15
      `.id` read from            req.params          15
        `.params` read from      req                 15
          parameter `req`        req: Request        14   caller supplies
```

`caller supplies` is the honest terminal there: `req` is declared right in the file, but express
fills it in, so the value enters from outside. That is the shape of a real injection trace — the
value interpolated into the SQL template came from the request, and the trace says so in six steps.

A trace **starts at a declaration and ends at one**. Intermediate rows show the expression a value
passed through, which is what you want in the middle of a chain; but the last row of a branch points
at where the value enters the program rather than at the last place it happened to be read — line 14
above, not the `req` on line 15.

### Wrapper objects and DTOs

A value carried inside an object is the shape most flows take, and a trace that stops at the
wrapper loses the value exactly where it is being carried. So the walk goes through one:

```ts
interface Dto {
  value: string
}
const w: Dto = { value: req.params.id }
const out = w.value // ← trace this
```

```
property `value`: w.value
  `.value` read from: w
    initialised from: { value: req.params.id }
      property `value`: req.params.id        ← outside
```

The wrapper itself is a step, which is the point: you see the object the value was put into, not
only where it ended up. Six shapes are followed, and each was a dead end before it was a rule — a
**field the constructor fills in** (`this.value = v`, reached through the constructor's argument at
each call site), a **parameter property** (`constructor(public value: string)`), a **getter**, an
**interface or type member**, a **member written after the object was built** (`d.value = raw`),
and a DTO declared in **another tab**.

The mechanism the interface case turns on is worth knowing about, because it decides what the
trace will _not_ claim. A member declared by an interface holds a shape and never a value, so the declaration
says nothing about where the value came from; the walk falls back to the **receiver** — the object
the member was read from — and carries the member's name down with it. That name rides through
assignments, arguments and returns unchanged, and is answered by the first thing that can: an
object literal with such a property, or a construction of a class with such a member, which
expands to the argument that set it. Reading `w.value` therefore follows the object `w` actually
came from, rather than reaching every object of that shape in the buffer — a path that cannot
happen costs a reviewer more than a missing one. Where nothing can answer the name, nothing
changes: the arguments are kept instead, which is the same over-approximation an unresolvable call
makes, and only a construction with nothing fed into it is a value made right there.

**The constructor is a step of its own**, where the class declares one, and that is the row a
security review is usually looking for:

```java
var productId = new ProductId(id);   // ← trace this
```

```
variable `productId`: var productId = new ProductId(id);
  initialised from: new ProductId(id)
    constructed by `ProductId`: public ProductId          ← ProductId.java
      passed to `ProductId`: id
        parameter `id`: @PathVariable String id           ← never called here
```

A record's compact canonical constructor is where the value is validated, normalised or rejected —
`UUID.fromString(value)` before the component is ever stored — and a trace that steps over it reads
as though the value arrived untouched, which is the difference between a finding and a sanitiser.
Clicking that row opens the tab it is in. A class that declares no constructor has nothing to show
and gets no row; Java's compact and ordinary constructors, Python's `__init__` and TypeScript's
`constructor` all count.

The step records the wrapper's tab either way, which is what
[**Analyze this trace**](#taking-a-trace-to-a-model) spends: a record with no constructor of its own
leaves no row in the file that declares it, and a model asked to judge the path — is this validated?
what does `value()` return? — cannot answer without that source. So the file the type is declared in
is part of the chat's scope whether or not a row lands there.

TypeScript, Python and Java all do this. It is the same rule in each, and the traces read the
same.

### Taking a trace to a model

Two buttons under the trace — **Copy**, and **Analyze this trace**.

**Copy** puts the whole trace on the clipboard as text, for pasting into the chat or an agent's
task — a path you have already followed is a far better question than "is this vulnerable?", and
it saves the model the walk.

Every step names its **file and its line**, even the steps in the tab on screen, which the pane
itself leaves off because the editor beside it already says which file that is. Pasted anywhere
else there is no editor, and a bare line number points into whichever file the conversation
happens to be about. The citation shape is the one the shipped brief asks a model to answer in —
`name (file line N)` — so a pasted trace reads like the answer it is asking for:

```
Backward trace of variable `raw`, from main.ts line 2 — 3 steps, 2 files, 1 origin outside the open files.

- variable `raw`: const raw = read() (main.ts line 2)
  - initialised from: read() (main.ts line 2)
    - returned by `read`: process.env.SEED (db.ts line 2) — from outside the open files

Each step is where the value above it came from. This is a may-analysis: every path that could
reach the value is shown, with no aliasing and no path sensitivity, so a path here is one the code
could take rather than one it does. The lines quoted here are single-line excerpts and not the
code: check every step against the file it names before you rely on it, and do not report a
finding from this text alone.
```

It is a markdown nested list because the tree is the analysis, and a list survives being read by
a model and re-rendered as markdown where bare indentation would be folded into one paragraph. The caveat travels with it for the reason the pane
states it in its footer — a may-analysis read as a claim about what the code _does_ is how a model
turns a path the code never takes into a finding. The last sentence is aimed at a different habit:
a trace carries an excerpt, a file and a line for every step, which is enough to write a
plausible-looking review from without opening a single file — so a model that _can_ read the files
will often review the trace instead. Saying the excerpts are excerpts is the cheap half of the fix;
the visible half is that a chat which never called `read_file` now says so in a row of its own. A walk that stopped at its budget says so too,
and what is copied is the whole trace, whatever you have folded away on screen.

**Analyze this trace** does the pasting for you: it opens the Chat tab, starts a new conversation
and asks that question with the same text below it. What differs from pasting by hand is the first
line, which [**tags the files**](#naming-files-with-) the trace cites:

```
Analyze this trace. @main.ts @db.ts
```

So the conversation is opened over those two files and nothing else — their full source,
line-numbered, exactly as an ordinary chat gets the whole buffer. A trace is the one question here
that says exactly which files matter, and a chat scoped to them spends its budget on the code the
question is about. The tags are ordinary text: delete one before you ask, add a tab the trace never
reached, or leave them alone.

The question is deliberately the bare "Analyze this trace." What _analyze_ means is the brief's to
say, and the brief is yours: a question that named what to look for would compete with a hunter or
a rewritten role, the same way an orchestrator brief naming its own review used to beat the task
in the box. It starts a new conversation, because the code a conversation carries is fixed when it
opens.

**Analyze with agents** beside it asks the same question of [a line of
agents](#running-a-line-of-agents) instead: the trace becomes the run's task, tags and all, and the
team reads it one after another. A run takes one snapshot of the buffer and every agent is given
the tagged files out of it — or, where an agent is on a model that reads its own files, the index
of every tab with the tagged ones to start from. Each agent's row says what it was narrowed to,
exactly as the chat's status line does.

### What it does not do

It is a _may_-analysis: it shows every path that **could** reach the value, with no path sensitivity
and no alias analysis. Concretely, it will miss things.

- **Aliasing.** Following a wrapper through an alias, an argument or a return works, because the
  member's name travels with it; what is not tracked is a value reaching an object by some route
  the walk cannot name — through an array, a `Map`, a spread, or a property whose key is computed.
- **Callbacks.** In `[1, 2].map((n) => …)` the arrow's parent _is_ the call, so there is no named
  callee whose references could be searched. `n` is reported as external, which is the true answer:
  its value comes from `map`'s implementation.
- **Mutation of a container.** `arr.push(tainted)` followed by `arr[0]` is not tracked. A named
  member written after its object was built (`d.value = raw`) _is_.
- **Every construction, when a member can be named.** A field's writes are found through its
  references, so tracing `d.value` on a typed field reports every place that field is written —
  including constructions of the class that never reach this read. The over-approximation is
  deliberate: the alternative drops the setter that did.
- **Standard library calls** report as external, since `noLib` means `Math.max` is as unknown as
  anything else, `` String.raw`…` `` included. Honest, but noisy.

A trace runs only when asked, and is dropped as soon as the buffer changes — every span in it is an
offset into text that has since moved. Unlike the definition highlight, which is one lookup per
cursor move, a trace costs a reference query per parameter it walks through.

## Asking a model

The third tab is a chat about the code, answered by a model running **on your own machine**.
There is no backend, and the promise everywhere else holds: weights come down, the code never
goes up.

Three backends sit behind one interface (`src/lib/chat.ts`), and the picker lists only what this
browser can actually run:

| Model                        | Runtime                               | Size                |
| ---------------------------- | ------------------------------------- | ------------------- |
| Browser built-in             | Chrome's `LanguageModel` (Prompt API) | nothing to download |
| Qwen2.5-Coder 1.5B / 3B / 7B | WebLLM over WebGPU                    | 1.6 / 2.5 / 5.1 GB  |
| Qwen3.5 2B / 4B              | WebLLM over WebGPU                    | 2.2 / 3.9 GB        |
| Qwen2.5-Coder 1.5B (ONNX)    | Transformers.js over WebGPU           | ~1.2 GB             |
| GLM-Edge 1.5B                | Transformers.js over WebGPU           | ~1.3 GB             |
| Gemma 4 E2B / E4B            | Transformers.js over WebGPU           | 3.1 / 4.9 GB        |

The browser's own model is the default wherever it exists — nothing to download, and no wait.
The rest fetch their weights once from the Hugging Face CDN and the browser caches them; the
first question after picking one pays for the download, and the progress bar says so. Both
WebGPU runtimes are loaded lazily, so a reader who never picks one never downloads either
library. Which Gemma is on offer is decided per generation, not by version number: Gemma 3
overflows fp16 on WebGPU ([onnxruntime#26732](https://github.com/microsoft/onnxruntime/issues/26732),
open) and is absent, while Gemma 4's own WebGPU demo runs the same q4f16 sessions this pane asks
for. Gemma 4's small models are multimodal, and only their text half is fetched — asking for text
generation leaves the vision and audio encoders in the repo, but not the per-layer embedding
tables, which are why an "E2B" of 2.3B effective parameters still costs 3 GB. GLM-Edge
is the only GLM published small enough to run in a browser at all.

The Qwen3.5 models and both Gemma 4s can reason before they answer, and the **think** checkbox
beside the picker decides whether they do — per question, so turning it on mid-conversation costs
nothing. Off by default, since an answer should be the answer; where reasoning arrives anyway it is
folded away rather than shown. Thinking is slower twice over: the reasoning is generated before the
answer starts, and it is spent out of the same budget.

Starting a new chat keeps the model loaded: only the conversation and its system prompt are
replaced. Changing model is what unloads one.

Where the browser has neither a built-in model nor a working GPU adapter — `navigator.gpu` can
exist and still hand back nothing — the tab says only that no language model is available in
this browser, and does nothing else.

Which models are on offer is partly a matter of configuration, and that lives in the **⚙** tab at
the right-hand end of the row rather than under the chat: an OpenRouter API key, any OpenRouter slug
you want in the catalogue yourself, and the address of a model server running on your own machine.
All three are the same facts whether a chat or an agent run spends them, which is why they sit
beside both panes instead of inside one — the tab's cogwheel goes gold once any of them is set,
since a configured key is otherwise invisible from anywhere in the app. Nothing there is stored
until **Save** (the address in particular starts a discovery request the moment it is kept), and
none of it ever rides a share link. What stays under each pane's own cogwheel is what belongs to
that pane alone: the chat's brief, the agents' team.

The system prompt makes the model a security engineer reading the code as a SAST tool would —
taint flowing from **sources** (request fields, environment, files, anything the code does not
control) to **sinks** (queries, shell commands, `eval`, paths, DOM writes) — and carries
**every open file**, each line-numbered from its own line 1, so answers can cite a file and a
line. This is the one place the tool is not single-file: the tree and the trace read the active
tab, but a taint flow usually leaves the file it starts in, so the model gets all of them.

The brief and the code reach the model as different things. The **system prompt** is the brief
alone; the open files arrive as a **hidden opening turn** of the conversation — a message carrying
the line-numbered listing, answered with a one-line acknowledgement — before your first question.
Instructions are instructions and code is data, and the code message says as much in its first
sentence, so a line written inside a comment reads as part of the file under review rather than as
part of the brief. It is not sent as a `tool` message: a tool message is a reply to a tool
call, and the opening turn answers no call — it is handed over unasked. The acknowledgement is
there because some chat templates refuse two user turns in a row.

### Naming files with @

Type `@` in the chat's box or the agents' task box and the open tabs are offered by name, filtered
as you type — the same subsequence matcher the Cmd+P palette uses, so `@slb` finds
`src/lib/base.ts`. ↑↓ moves, ↵ or ⇥ picks, esc dismisses.

**A tag is a scope.** A question naming no file is asked over every open tab, exactly as before; one
naming files is asked over **those alone**:

```
is the id validated before it reaches the query? @routes.ts @lib/db.ts
```

Two files instead of twelve is two files' worth of budget spent on the code the question is about,
and the line under the box says what the tags will do before you ask. Afterwards the status line
says it again, since an answer over two files reads exactly like one over twelve once the question
has scrolled away — and the **model** is told too, so it can say when an answer needs code it cannot
see instead of inventing something to fill the gap.

For a model that [reads the files itself](#models-that-read-the-files-themselves) a tag promises
something different, and the line under the box says which: it keeps the index of **every** tab and
is told to start with the ones you named. Nothing is withheld from it, so nothing is clipped and a
path leading out of the tagged files is one it can follow.

Two things are worth knowing:

- **The first question of a conversation scopes it; a later one adds to it.** A chat carries the
  code it was opened with, and handing it different code would mean throwing the conversation away.
  So a tag on a follow-up brings the file in instead — and only the ones that are not there
  already:

  ```
  you   is the id validated? @routes.ts @lib/db.ts     ← opens the chat over those two
  you   what about @auth.ts and @lib/db.ts?            ← sends auth.ts; points at lib/db.ts
  ```

  The transcript shows the question you typed. The model gets that question with `auth.ts` in
  front of it and one line saying it already has `lib/db.ts`, so nothing is paid for twice — and
  a model that reads its own files is simply told to read them. The line under the box says which
  of the three is about to happen. The agents' box has none of this to worry about: the task _is_
  the run, and it is read when you press Run.

- **A tag has to name an open tab.** `@routes.ts` as the tab is labelled, or `@db.ts` for
  `src/lib/db.ts` where only one tab ends that way. Everything else stays prose — which is what
  lets you paste a Java trace full of `@PathVariable`, or a Python one full of `@app.route`, into
  the box without any of it being read as a file.

### Models that read the files themselves

A model that can call a **tool** is given the files to read rather than the files. Its opening turn
is an **index** — every open file with its language and line count, and nothing of its contents —
and two tools:

| Tool         | Arguments                                                   | Answers with                                     |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------ |
| `list_files` | none                                                        | the open files and their line counts             |
| `read_file`  | `file`, and optionally `start` / `end` (1-based, inclusive) | those lines, numbered from the file's own line 1 |

The gain is the one the budget paragraph below describes: the character budget stops being a clip
over the whole listing and becomes a ceiling on **one read**, so a project too large to fit is no
longer a project the model sees half of — it reads what it needs, a file or a range at a time, and
a read the ceiling cut names the line to continue from. Nothing else about the conversation
changes: the same brief, the same snapshot of the buffer, the same staleness rule.

Which models: the four shipped **OpenRouter** entries (each checked against `tools` in the
`supported_parameters` its own model page lists), any OpenRouter slug or local-server model you
tick **tools** on in the ⚙ tab, and the **ONNX** entries whose chat template has tools in it —
Qwen2.5-Coder and both Gemma 4s. **WebLLM cannot**, and that is its own limitation rather than an
omission: it refuses `tools` for every model outside a fixed list of five Hermes builds, none of
which is in this catalogue. Chrome's built-in model has no tool role at all. Everything not on the
list is handed the whole line-numbered listing exactly as before.

The ONNX side is a different mechanism wearing the same name. There is no API there — there is a
chat template, and the model writes its call into the _text_ — so each family's own syntax has to
be read back out of the stream: Qwen's `<tool_call>` with a JSON object inside, which its template
prints the instructions for, and Gemma 4's `<|tool_call>call:name{…}`, whose tokenizer config
names the regexes for reading one. A model whose template has no tools in it (GLM-Edge) has no
dialect, is never offered any, and is never flagged.

**Every call is printed in the log**, one row per call, in the answer where it happened:

```
read_file routes.ts lines 1-40
read_file lib/db.ts

The id reaches `db.query` on lib/db.ts line 12 …
```

One row is written when there were **no** calls at all:

```
no file was read — this answer is from the file list alone
```

A model handed tools can narrate "I must first read the files" and then simply end its turn — no
call, no row, and an answer resting on nothing but a list of file names that reads exactly like one
resting on the code. Usually that means the server did not turn the model's tool syntax into a
`tool_calls` field, or the model planned instead of calling; neither is visible from the answer, so
the row says it. It is written once per conversation, not once per question: a follow-up answered
from a file already read is ordinary.

Not folded away, because what a model was allowed to read is the first thing worth checking about
an answer it built by reading — an answer that quietly read half a file should not look like one
that read the file it cites. It is still kept out of the conversation's history and out of an
agent's relay: it is what the model _did_, not what it said, the model already holds the contents
in its own history, and the next agent cannot check `read_file routes.ts` against anything. A
question is allowed twelve rounds of reading; at the twelfth the tools are taken away and the model
answers with what it has, printed as a row of its own.

The **⚙ Prompt** button opens that brief for editing — for another kind of review, another output
shape, another language. What you write replaces the role and the two definitions; the open files
are appended below it either way, since they are generated from the editor rather than typed.
**Restore default** puts the shipped brief back, a rewritten one is remembered between visits and
marked on the button — which keeps the cogwheel and drops its words when the pane is dragged narrow — and saving one starts a new chat, since a conversation keeps the prompt it
began with. The model stays loaded through it: the weights have not changed, only the wording.

A rewritten brief also travels: **Copy link** adds a `systemprompt=` to the fragment when there is
one to add, and nothing when the brief is the shipped one, which every reader has anyway. The other
end can be written by hand — see [Parameters](#parameters) — so one link can hand someone the code
and the question to ask about it.

**Start from** beside the box is a shelf of briefs to begin with: the shipped one, and sixteen
**hunters** — one per classic class, from SQL injection and XSS through SSRF, path traversal,
BOLA/IDOR, mass assignment and prototype pollution to unsafe deserialization, open redirect, CSRF,
authentication and weak crypto (`src/lib/hunters.ts`). Each is a complete brief naming that class's
sinks, what actually removes the problem, and the traps on both sides — the pattern that hides a
real finding, and the one that turns a safe line into a false report. They are deliberately
_shorter_ than the shipped brief: a reviewer that already knows what it is hunting needs no
vocabulary lesson, and the characters saved are characters of your code that fit in the window
instead. Picking one only writes the box; what you do to it afterwards is yours, and it is stored
and shared like any brief you typed. The picker shows a name only while the text is still exactly
that brief — edit a word and it says _your own wording_, because by then it is.

The 12 000-character budget covers them together, spent in order with the file on screen first,
so what gets clipped is code you are not looking at. A clip is stated in the prompt — a model
shown half a file should know it — and a file the budget could not reach is named rather than
quietly dropped. For a model that reads the files itself the same figure is spent per `read_file`
instead of once over everything, so nothing is out of reach and there is no clip to warn about.

Answers come back as Markdown, so they are rendered rather than shown with their asterisks on.
`src/lib/markdown.ts` parses the handful of constructs an answer actually uses — fenced code,
headings, bullet and numbered lists, quotes, inline code, emphasis, links — into a block list
that the pane draws with ordinary elements. No `v-html`, so nothing a model writes can become
markup, and no parser dependency. An unterminated fence is code, because a streaming answer is
always mid-block; emphasis is `*`-only, because `snake_case` names in a code answer are more
common than underscore italics; and a link is only a link when it is `http(s)`.

A session is created on the first question and reused for follow-ups, which is what makes it a
conversation — so the code in its system prompt is a **snapshot**. Changing model starts a new
one: different weights, a different context budget and a different system prompt, and carrying
the turns across would misrepresent who said them. Editing, renaming or closing a file mid-chat
does not rewrite it; the pane says the code has changed and offers a new chat, since silently
rebuilding the session would throw the conversation away. Merely switching tabs is not a change:
it reorders the prompt without altering a line of what is in it. Availability is not probed until the
tab is first opened.

## Running a line of agents

The **Agents** tab is the same model asked several questions in a row instead of one, with the
answers carried between them. An **orchestrator** writes each agent's brief; each **agent** reads
the code and reports back; the orchestrator reads that, briefs the next one, and writes the summary
at the end. The shipped team is two agents: the chat pane's own reviewer, then a skeptical triage
pass that rules on what the first one claimed — the second question that makes the first one worth
asking.

**The orchestrator never sees the code.** Its context is its brief and the roster, and nothing
else; it can only ever reason about what the agents reported, which is what keeps a summary from
citing lines nobody read. Every agent sees **every open file**, line-numbered, under its own brief —
the same system prompt the chat pane builds, with the same budget and the same clipping.

A run of two agents is five turns:

    you          →  the task, as you wrote it
    Orchestrator →  brief for Review
    Review       →  report          (sees the files)
    Orchestrator →  brief for Triage
    Triage       →  report          (sees the files, and Review's report in full)
    Orchestrator →  summary

What the run is _about_ is the task you type, not something the orchestrator decides. Its brief
describes the job — brief an agent, read what comes back, carry it to the next, summarise — and
says explicitly that the subject is yours to set; the security expertise lives in the agents' own
briefs, which is the half of the team that can actually read the code. Your task is put in front of
the orchestrator again with every brief it writes, not just the first, because a task mentioned once
is one a small model has drifted away from by the second hop.

The relay is **verbatim**, and that is the pane's doing rather than the orchestrator's: the next
agent is handed the orchestrator's new brief _and_ the previous report copied word for word,
because a file, a line and a name survive a hand-off only if they are copied. The **first** agent
gets your own task copied the same way, ahead of its brief — it is the one hop with nothing else to
go on, and an orchestrator that has never seen the code is a poor route for the details. It matters
most for **Analyze with agents**, where the task is a whole trace: boiled down to a sentence by the
orchestrator, the first agent would be reviewing a flow it had never read. Later agents are not sent
it again — each already has a verbatim copy of its own, and a second copy of a trace would crowd out
the code. The orchestrator is
told twice — in its brief and again each time it is asked — that the report travels on its own, so
it must not summarise, restate or reword a verdict; a model handed a verdict and asked to write
about it will rewrite it otherwise, and a rewritten verdict arrives contradicting the copy beside it
in a voice that sounds just as authoritative. Since "told not to" is not a guarantee, the receiving
agent is also told outright which copy wins: where the brief characterises the report differently,
the report is what counts. What the orchestrator itself is given is clipped at 6 000 characters, and the
clip is stated rather than silent.

What does **not** travel is a reasoning model's thinking. The transcript keeps it, folded into the
row that produced it, but every hop after it is built from the answer alone — working-out is not a
finding, it invites the next agent to treat a discarded line of thought as one, and a context this
small is better spent on the code.

The transcript is read at two depths. Your task and the orchestrator's messages are the spine and
are always open — between them they say what was asked and what came of it. An agent's report is
the bulk of the text, so it arrives **folded**; open it to read it. What an agent was _handed_ is
not shown under it, because it is already in the stream: the brief above it, and the report before
it. The hop in flight is always open — a run is slow, and watching the text arrive is how you know
it is still going.

The task box is for a run that has not begun. Starting one takes it away, and finishing does not
bring it back — a run is one task from beginning to end, and a second task typed under the first
one's findings would be a different run wearing the same transcript. **Clear** hands the box back,
and drops the transcript it would have been appended to.

The **⚙ Agents** button opens the team: the orchestrator's brief, each agent's brief and name, and
buttons to add or remove one. Each agent's brief has the same **Start from** shelf the chat pane
has, with the two shipped briefs beside the hunters — which is how a team is built out of both: an
agent hunting one class, and triage ruling on what it reported. The last agent cannot be removed — an orchestrator with nobody to
brief has no run to make. A rewritten team is remembered between visits, marked on the button, and
rides **Copy link** as an `agents=` bundle; the shipped team is carried by neither, so a later edit
to the defaults reaches everyone who never wrote their own. Saving clears the transcript, since it
was produced by a different set of instructions.

The model picker is **the chat's own**: one selection, one set of weights on the GPU, shared by both
tabs. Switching between them costs nothing, and changing the model in one changes it in the other —
which also drops the conversation and the transcript, because both were produced by weights that
are about to be unloaded.

Each agent can be put on a model of its own, from the same catalogue, in the team editor; the blank
choice puts it back on the run's. The orchestrator always runs on the picked model. A second model
is a second set of weights on the GPU, loaded on the first hop that needs it and kept for the next
run for as long as the team names it — so two agents on the same model share one load, and taking
the last agent off a model unloads it. A team from a link may name a model this browser cannot run;
the roster says so, and a run stops at that agent rather than quietly running it on another.

## How the panes stay in sync

The cursor **offset** is the single source of truth. Node ids are only stable within one
parse, so after every re-parse the selection is re-derived from the offset rather than
carried over. A tree click additionally pins the exact node, since an offset alone can't
tell a node from its same-position ancestors — clicking a `VariableStatement` row and
clicking its `VariableDeclarationList` child would otherwise be indistinguishable.

Programmatic cursor moves are wrapped in a suppression flag so the editor's own change
event isn't mistaken for a user action and bounced back.

Highlights use Monaco's `inlineClassName` rather than `className`: the latter renders as a
positioned box _behind_ the text, the former wraps the text itself, which is what lets a
tint and an underline land on the code.

## Layout

```
src/lib/analyzer.ts        LanguageService over the open files        (pure, tested)
src/lib/astTree.ts         AST → flat node list, offset lookups       (pure, tested)
src/lib/definitions.ts     the definition rules                       (pure, tested)
src/lib/flow.ts            the backward provenance walk               (pure, tested)
src/lib/share.ts           share-link encoding, bundles, fragments     (pure, tested)
src/lib/files.ts           open-file naming and identity              (pure, tested)
src/lib/upload.ts          picked and dropped files, folders walked
src/lib/quickOpen.ts       the quick-open filter and its ranking     (pure, tested)
src/lib/chat.ts            the provider contract, model catalogue, system prompt
src/lib/markdown.ts        the answer renderer's block parser           (pure, tested)
src/lib/monacoSetup.ts     Monaco theme and compiler options
src/lib/sample.ts          seed buffer, exercises every rule
src/composables/useAnalysis.ts  debounced parse, held in a shallowRef
src/composables/useBuffer.ts    the open files: sample / localStorage / link / file open
src/composables/useChat.ts      model choice, session, streamed answers
src/App.vue                shared selection state, wires the panes and the tabs
src/components/EditorPane.vue   Monaco, a model per file, decorations, file drop
src/components/FileTabs.vue     the tab strip: switch, close, rename, add
src/components/QuickOpen.vue    the Cmd+P palette over the open files
src/components/AstPane.vue      tree root, filter, breadcrumb, definition line
src/components/AstNodeRow.vue   recursive row
src/components/TracePane.vue    trace root, summary, external-source jump
src/components/TraceRow.vue     recursive row
src/components/ChatPane.vue     conversation, composer, model picker
src/components/AgentsPane.vue   the run's transcript, the task box, the team editor
src/components/SettingsPane.vue  key, server address, the reader's own catalogue additions
src/lib/providers/*.ts     built-in / WebLLM / Transformers.js adapters
src/components/MarkdownText.vue  answer blocks; MarkdownSpans.vue, inline
src/components/SplitPane.vue    draggable divider
```

Unit tests drive the pure modules over fixture strings. `tests/e2e/app.test.ts` drives the
dev server in headless Chrome, clicking exact characters via Monaco's own coordinate
mapping; `tests/e2e/dist.test.ts` builds for real and loads the output, because the two
disagree about workers (see below).

## Notes

- **`typescript` is pinned to `^6`.** TypeScript 7's npm package dropped the classic
  compiler API — its `exports["."]` is `lib/version.cjs` — so the browser-side AST work
  needs 6.x, which still ships `lib/typescript.js`.
- **Monaco's workers are wired explicitly.** Monaco 0.56 can spawn them itself via
  `new Worker(new URL(…))`, and the dev server copes — but a production build does not:
  Vite copies the core editor worker as a static asset rather than bundling it, and its own
  relative imports then dangle. `src/lib/monacoSetup.ts` sets `MonacoEnvironment.getWorker`
  against `?worker` imports instead. Mind the specifiers: monaco 0.56's exports map is
  `"./*" -> "./esm/vs/*.js"`, so the older `monaco-editor/esm/vs/…` form silently resolves
  to a doubled path that does not exist.
- The main chunk is around 2 MB gzipped, most of it the TypeScript compiler, and Monaco's
  worker carries a second copy in a lazily-loaded chunk. Fine for a developer tool; it's
  the first thing to attack if load time ever matters.
- Monaco reports diagnostics from its own worker, with "cannot find module" suppressed. Its
  models are keyed by file id rather than by name, so it never resolves between tabs even
  though our own analyzer does; the squiggle would say nothing true.
