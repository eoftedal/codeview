# codeview

**Live demo:** https://eoftedal.github.io/codeview/

Explore a TypeScript or JavaScript file as a syntax tree. Monaco on the left, the AST on
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
| `lang`         | `ts`, `tsx`, `js` or `jsx`                                                                                         |
| `filename`     | names the tab; its extension picks the language when `lang` is absent. **Copy link** carries it along              |
| `hideHeader`   | hides the title bar, language switcher and buttons, for embedding                                                  |
| `systemprompt` | the chat's brief — `z.`/`r.` payload, or literal text. **Copy link** carries it only when you have rewritten it    |
| `agents`       | the agents tab's team, as a `--8<--` bundle — same rules. **Copy link** carries it only when you have rewritten it |

Any of these describes what the link is about, so it opens with those files rather than the
tabs the reader happened to leave open. Without them, the last session comes back whole;
the seed buffer arrives as `example.ts`, because every tab needs a name. `systemprompt` and
`agents` are the exceptions on both counts: neither says anything about which files are open, so
they leave the reader's tabs alone, and both belong to the link rather than to the reader — they
are not written to `localStorage`, so opening someone else's link cannot overwrite a brief or a
team you wrote yourself. Both can be written out in the clear, spaces and all:

    #systemprompt=you+are+a+reviewer+who+only+reports+SQL+injection

    #agents=--8%3C--+orchestrator%0AYou+brief+them.%0A--8%3C--+Scan%0ARead+the+routes.

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

## Tracing a value back to its sources

The definition question stops after one step. **Trace** — the button in the right pane, `Alt+T` in
the editor, or the editor's context menu — keeps going, and answers _where did this value actually
come from?_

Each step is one hop backwards. A variable leads to its initializer and to every later assignment;
a call leads into the callee's `return` statements; a parameter leads out to every call site and the
argument sitting at its index. That last edge is the one that makes it worth having — it is the step
you otherwise make by hand, scrolling to find who calls this thing.

The walk ends where it honestly can:

| Terminal          | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `defined here`    | a constant, a function, or an object built on the spot        |
| `another module`  | an import of something no tab holds — `express`, `node:fs`    |
| `outside`         | a name with no declaration at all — a global, say             |
| `uncalled here`   | a parameter of a function nothing open calls                  |
| `caller supplies` | a parameter of a function handed to something else to invoke  |
| `seen above`      | a cycle — the same declaration is already expanded further up |

**The walk crosses files.** An import between tabs resolves, so the trace follows a value into the
callee's body wherever it lives — and back out again, because find-all-references crosses an import
too, so a parameter still reaches the argument at every call site including the ones in other tabs.
Each step is labelled with the file it is in (`store.ts:6`), the summary says how many files the
path touched, and clicking a step in another tab opens it. The editor only decorates the steps in
the tab on screen: a span is an offset into one file and means nothing in another.

`noLib` does the interesting work at the end. Because nothing resolves into the standard library,
**a name with no definition is by construction external** — so `process.env.TOKEN` and
`document.location` fall out as sources with no list of dangerous globals to maintain. An
unresolvable call keeps its arguments and its receiver as children, so `untrusted.trim()` still
leads back to `untrusted` rather than dead-ending on an unknown method.

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
part of the brief. It is not sent as a `tool` message: a tool message is a reply to a tool call and
there is no call to reply to, and of the three model back-ends here one has no tool role at all,
one cannot render the call the message would answer, and one runs chat templates that reject the
role outright. The acknowledgement is there because some chat templates refuse two user turns in a
row.

The **⚙ System prompt** button opens that brief for editing — for another kind of review, another output
shape, another language. What you write replaces the role and the two definitions; the open files
are appended below it either way, since they are generated from the editor rather than typed.
**Restore default** puts the shipped brief back, a rewritten one is remembered between visits and
marked on the button — which keeps the cogwheel and drops its words when the pane is dragged narrow — and saving one starts a new chat, since a conversation keeps the prompt it
began with. The model stays loaded through it: the weights have not changed, only the wording.

A rewritten brief also travels: **Copy link** adds a `systemprompt=` to the fragment when there is
one to add, and nothing when the brief is the shipped one, which every reader has anyway. The other
end can be written by hand — see [Parameters](#parameters) — so one link can hand someone the code
and the question to ask about it.

The 12 000-character budget covers them together, spent in order with the file on screen first,
so what gets clipped is code you are not looking at. A clip is stated in the prompt — a model
shown half a file should know it — and a file the budget could not reach is named rather than
quietly dropped.

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
because a file, a line and a name survive a hand-off only if they are copied. The orchestrator is
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
buttons to add or remove one. The last agent cannot be removed — an orchestrator with nobody to
brief has no run to make. A rewritten team is remembered between visits, marked on the button, and
rides **Copy link** as an `agents=` bundle; the shipped team is carried by neither, so a later edit
to the defaults reaches everyone who never wrote their own. Saving clears the transcript, since it
was produced by a different set of instructions.

The model picker is **the chat's own**: one selection, one set of weights on the GPU, shared by both
tabs. Switching between them costs nothing, and changing the model in one changes it in the other —
which also drops the conversation and the transcript, because both were produced by weights that
are about to be unloaded.

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
src/components/AstPane.vue      tree root, filter, breadcrumb, definition line
src/components/AstNodeRow.vue   recursive row
src/components/TracePane.vue    trace root, summary, external-source jump
src/components/TraceRow.vue     recursive row
src/components/ChatPane.vue     conversation, composer, model picker
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
