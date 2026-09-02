# codeview

**Live demo:** https://eoftedal.github.io/codeview/

Explore a TypeScript or JavaScript file as a syntax tree. Monaco on the left, the AST on
the right, kept in sync both ways: move the cursor and the tree follows, click a node and
the editor follows.

On top of that, whatever sits under the cursor gets its **definition** highlighted — the
declaration a name actually resolves to, not the first thing with a matching name. Ask for a
**trace** and it goes further, walking that value back through assignments, return values and
call-site arguments until it reaches a constant, an import, or something the file cannot see.

Vue 3 + TypeScript, no backend — the code you paste never leaves the browser.

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

Paste or type into the editor, open a local file (button or drag-and-drop), or share a
buffer with **Copy link**. The buffer is kept in `localStorage` between visits.

A share link carries the whole buffer in the URL fragment, which browsers never send to
the server — so shared code stays between the people holding the link. **Copy link** writes
`#src=z.<payload>`: raw DEFLATE (via `CompressionStream`, no dependency), then base64url.
Anything without a `z.` prefix is read literally, so a link can also be written by hand:

    #src=const%20answer%20%3D%2042&lang=ts

The fragment is parsed without `URLSearchParams`, which decodes `+` as a space and would
quietly corrupt hand-written source. A prefixed payload that fails to decode is treated as
literal too — source starting with `z.` is likelier than a corrupt link.

## Parameters

Read from the query string and the fragment alike, the fragment winning where both name a
key. Key names are case-insensitive, since these get typed by hand.

| Parameter    | Effect                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `src`        | the buffer — `z.`/`r.` payload, or literal source                                                              |
| `lang`       | `ts`, `tsx`, `js` or `jsx`                                                                                     |
| `filename`   | shown above the editor; its extension picks the language when `lang` is absent. **Copy link** carries it along |
| `hideHeader` | hides the title bar, language switcher and buttons, for embedding                                              |

`hideHeader` needs no value, though `=false`/`=0`/`=no`/`=off` turns it off. It leaves the
filename bar alone, so an embed can still say which file it is showing:

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

The analyzer runs with `noLib` and `noResolve`: nothing resolves into the standard library
or into another file, because a definition outside the buffer has no range to highlight
anyway. Imported names stop at their import statement, which is the honest answer for a
single-buffer view.

## Tracing a value back to its sources

The definition question stops after one step. **Trace** — the button in the right pane, `Alt+T` in
the editor, or the editor's context menu — keeps going, and answers _where did this value actually
come from?_

Each step is one hop backwards. A variable leads to its initializer and to every later assignment;
a call leads into the callee's `return` statements; a parameter leads out to every call site and the
argument sitting at its index. That last edge is the one that makes it worth having — it is the step
you otherwise make by hand, scrolling to find who calls this thing.

The walk ends where it honestly can:

| Terminal            | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `defined here`      | a constant, a function, or an object built on the spot        |
| `another module`    | an import — the declaration is in a file this view cannot see |
| `outside this file` | a name with no declaration at all — a global, say             |
| `uncalled here`     | a parameter of a function nothing in the buffer calls         |
| `caller supplies`   | a parameter of a function handed to something else to invoke  |
| `seen above`        | a cycle — the same declaration is already expanded further up |

`noLib` does the interesting work here. Because nothing resolves into the standard library or
another file, **a name with no definition is by construction external to the buffer** — so
`process.env.TOKEN` and `document.location` fall out as sources with no list of dangerous globals to
maintain. An unresolvable call keeps its arguments and its receiver as children, so
`untrusted.trim()` still leads back to `untrusted` rather than dead-ending on an unknown method.

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

### What it does not do

It is a _may_-analysis: it shows every path that **could** reach the value, with no path sensitivity
and no alias analysis. Concretely, it will miss things.

- **Aliasing.** `const p = o; p.x` loses the connection — property provenance only works when the
  object's creation site is statically reachable.
- **Callbacks.** In `[1, 2].map((n) => …)` the arrow's parent _is_ the call, so there is no named
  callee whose references could be searched. `n` is reported as external, which is the true answer:
  its value comes from `map`'s implementation.
- **Mutation.** `arr.push(tainted)` followed by `arr[0]` is not tracked.
- **`this` and class fields** assigned in a constructor are only partly followed.
- **Standard library calls** report as external, since `noLib` means `Math.max` is as unknown as
  anything else. Honest, but noisy.

A trace runs only when asked, and is dropped as soon as the buffer changes — every span in it is an
offset into text that has since moved. Unlike the definition highlight, which is one lookup per
cursor move, a trace costs a reference query per parameter it walks through.

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
src/lib/analyzer.ts        in-memory LanguageService, TS node lookup  (pure, tested)
src/lib/astTree.ts         AST → flat node list, offset lookups       (pure, tested)
src/lib/definitions.ts     the definition rules                       (pure, tested)
src/lib/flow.ts            the backward provenance walk               (pure, tested)
src/lib/share.ts           share-link encoding, fragment parsing       (pure, tested)
src/lib/monacoSetup.ts     Monaco theme and compiler options
src/lib/sample.ts          seed buffer, exercises every rule
src/composables/useAnalysis.ts  debounced parse, held in a shallowRef
src/composables/useBuffer.ts    sample / localStorage / share link / file open
src/App.vue                shared selection state, wires the panes and the tabs
src/components/EditorPane.vue   Monaco, decorations, cursor events, file drop
src/components/AstPane.vue      tree root, filter, breadcrumb, definition line
src/components/AstNodeRow.vue   recursive row
src/components/TracePane.vue    trace root, summary, external-source jump
src/components/TraceRow.vue     recursive row
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
- Monaco reports diagnostics from its own worker, with "cannot find module" suppressed —
  in a single-buffer viewer an import can never resolve, so the squiggle says nothing.
