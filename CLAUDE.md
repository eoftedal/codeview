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

**Trace node granularity.** `expand` deliberately _collapses_ the identifier→declaration hop, or
every step in a chain would double. Two exceptions, both in `flow.ts`: `declarationAt`'s `viaObject`
flag means the property fallback answered about a different expression (`req`, not `req.params.id`),
so that hop gets its own row; and `terminateAtDeclaration` gives the _last_ row of a branch the
declaration's span, so a trace starts and ends at a declaration. Changing either changes the shape
every `tests/flow.test.ts` fixture asserts.

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
not a client: `providers/{builtin,webllm,transformers}.ts` implement `availability` / `load`, and nothing above
them knows which model is answering. **Two lifetimes, and conflating them is the bug that keeps
coming back**: a `ModelEngine` owns the loaded weights and outlives conversations, while a
`ChatSession` is a system prompt and its turns. `newChat` drops the session and keeps the engine —
destroying the engine per conversation means reloading the model onto the GPU on every "New chat". No key, no
server, no hosted fallback — every model runs on the reader's machine.

Both WebGPU libraries are **dynamically imported inside workers** (`worker: { format: 'es' }`,
`optimizeDeps.exclude`), so they land in their own chunks and the main bundle is unchanged; check
that with a build before believing an edit. A GPU **adapter** is a fact about the browser, not the
model — Chrome exposes `navigator.gpu` on machines that hand back nothing — so `useChat.probe`
settles it once and drops every downloadable model when there is none. That is what leaves the pane
with the bare "no language model" message rather than a picker full of things that cannot run.
`enable_thinking` is sent only for models flagged `thinking`, and its value is per _question_, not
per session — it rides `AskOptions`, because `extra_body` is a request field. WebLLM turns thinking
off by prefilling an empty `<think>` block, which would corrupt a model that has none. ONNX quantisation is the model's call, not the worker's: a repo's `transformers_js_config` names
what its weights were validated at, and forcing `q4f16` on a model that asks for `q4` (GLM-Edge)
fails. Anything fp16 on WebGPU is suspect for small models — the same reason Gemma 3 is absent,
while Gemma 4 is present because its publisher's own WebGPU demo runs these sessions at q4f16.
The Gemma 4 entries are also the one place a **multimodal** repo is loaded: `text-generation`
instantiates `Gemma4ForCausalLM` against weights whose architecture is
`Gemma4ForConditionalGeneration`, which Transformers.js reads as text-only and fetches
`embed_tokens` plus `decoder_model_merged` alone — never the vision or audio encoder. Nothing in
the provider knows this; it falls out of the repo's own config, which is also where the external
data chunk counts come from. Their size figures are those two files, and it is the per-layer
embeddings, not the 2.3B effective parameters, that make an "E2B" a 3 GB download.

The thinking prefill comes back in the answer, so `markdown.ts` parses `<think>` as a block kind: empty means protocol and is
dropped, non-empty is folded into a `<details>`, and an unterminated one is thinking-in-progress. `useChat` lives in `App.vue`, not in `ChatPane.vue`,
because the pane unmounts on every tab switch and a conversation must not. The system prompt (role,
the source/sink definitions, then **every open file**, line-numbered) is built once per session, so
the code it carries is a snapshot — edits raise a `stale` hint rather than silently rebuilding the
session, which would discard the conversation. The model is given every open file for the same reason the trace
crosses them: a taint flow usually leaves the file it starts in. What it is _not_ given is which
one is on screen beyond the ordering, so answers cite a file with every line number. `maxCodeChars` is the budget for all of them together, spent in the order given
— which is why `promptFiles` puts the file on screen first — and files that do not fit are named
rather than dropped silently. Staleness is measured in **tab order**, so switching tabs (which only
reorders the prompt) does not cost a conversation, while an edit, a rename or a close does. The availability probe waits for the tab to be opened.

Answers are Markdown, rendered by `markdown.ts` → `MarkdownText.vue` → `MarkdownSpans.vue` as
real elements — never `v-html`, which is what keeps model output from becoming markup. The parser's
odd-looking rules are deliberate: an unterminated fence is code (a streaming answer is always
mid-block), emphasis is `*`-only (`_` would italicise `snake_case`), and only `http(s)` targets
become links.

**Pure vs. impure.** `src/lib/{analyzer,astTree,definitions,files,flow,share}.ts` are pure and
unit-tested over fixture strings — the analyzer's fixtures are now _sets_ of files, which is how
cross-file resolution and cross-file traces are tested; everything else is browser-bound and covered only by the e2e suites.
`chat.ts` is the mixed case: `buildSystemPrompt`/`numberLines` are pure, `languageModel()` is not.

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
  and would corrupt hand-written source. Keys are lower-cased; values are left verbatim. `z.` marks
  a deflated payload, `r.` an uncompressed one, and anything unprefixed or undecodable is read as
  literal source.
- **`files=` is `src=` for the whole strip**, and goes through the same `z.`/`r.`/literal rules — a
  hand-written bundle must keep working, which is why it is a text format and not JSON-in-base64.
  One payload for all the tabs, not one per tab: files that import each other compress against each
  other. `serializeFiles`/`parseFiles` round-trip exactly, and the rule that buys it is that **the
  newline before a `--8<--` header belongs to the header** — change that and every file that ends
  without a newline gains one on the way through a link. `copyShareLink` still writes the old
  `src`/`lang`/`filename` form for a lone tab: shorter, and every existing link and embed keeps
  working.
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
