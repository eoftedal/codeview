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

A single-buffer AST viewer: Monaco on the left, the TypeScript AST on the right, kept in sync, with
the definition of whatever is under the cursor highlighted. No backend, no multi-file resolution.

**Several files can be open, but only one is ever analysed.** The tab strip
(`FileTabs.vue`, `src/lib/files.ts`) switches which buffer the analyzer, the definitions and the
trace are about; it does not make anything multi-file. `useBuffer` holds `files` plus an active id
and exposes `text`/`language`/`fileName` as writable views onto the active one, which is why
`useAnalysis`, `useChat` and the panes below it still see exactly one buffer and needed no change.
Resist the pull to resolve imports across tabs: `noResolve` is what makes the trace's terminal
condition principled (see below), and cross-file resolution would take that away.

**Two independent TypeScript setups exist, and conflating them causes confusion.**

1. `src/lib/analyzer.ts` — our own `ts.LanguageService` over one in-memory file, running `noLib` +
   `noResolve`. This is what produces the AST and answers `getDefinitionAtPosition`. Everything the
   app actually shows comes from here.
2. `src/lib/monacoSetup.ts` — Monaco's own bundled TS worker, which only powers editor niceties
   (hover, completion, squiggles). Its compiler options are separate and deliberately different.

Because of `noLib`/`noResolve`, a definition outside the buffer has no range to highlight, so
imported names resolve to their import statement. That is the intended answer, not a gap to fix.

**Data flow.** `useBuffer` decides where the open files come from (a link, which describes exactly
one file → localStorage, which restores the whole strip → the sample) and owns
filenames/languages/notice. `useAnalysis` holds a debounced (150 ms) parse in a `shallowRef` and bumps
a `revision` counter. `App.vue` owns the shared selection state and wires the two panes.

**Two questions, two costs.** `resolveDefinition` is one definition lookup and runs on every cursor
move. `traceOrigins` (`src/lib/flow.ts`) walks a value backwards through assignments, returns and
call-site arguments, costing a `getReferencesAtPosition` per parameter it crosses — so it runs only
on explicit request and is cleared on every re-parse. Do not wire it to cursor movement. Both share
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
condition principled: nothing outside the buffer resolves, so a name with no definition _is_ an
external source. There is deliberately no list of interesting globals.

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
fails. Anything fp16 on WebGPU is suspect for small models — the same reason Gemma 3 is absent.

The thinking prefill comes back in the answer, so `markdown.ts` parses `<think>` as a block kind: empty means protocol and is
dropped, non-empty is folded into a `<details>`, and an unterminated one is thinking-in-progress. `useChat` lives in `App.vue`, not in `ChatPane.vue`,
because the pane unmounts on every tab switch and a conversation must not. The system prompt (role,
the source/sink definitions, then **every open file**, line-numbered) is built once per session, so
the code it carries is a snapshot — edits raise a `stale` hint rather than silently rebuilding the
session, which would discard the conversation. The chat is the one part that is not single-buffer:
the analyzer sees the active tab, the model sees them all, because a taint flow usually leaves the
file it starts in. `maxCodeChars` is the budget for all of them together, spent in the order given
— which is why `promptFiles` puts the file on screen first — and files that do not fit are named
rather than dropped silently. Staleness is measured in **tab order**, so switching tabs (which only
reorders the prompt) does not cost a conversation, while an edit, a rename or a close does. The availability probe waits for the tab to be opened.

Answers are Markdown, rendered by `markdown.ts` → `MarkdownText.vue` → `MarkdownSpans.vue` as
real elements — never `v-html`, which is what keeps model output from becoming markup. The parser's
odd-looking rules are deliberate: an unterminated fence is code (a streaming answer is always
mid-block), emphasis is `*`-only (`_` would italicise `snake_case`), and only `http(s)` targets
become links.

**Pure vs. impure.** `src/lib/{analyzer,astTree,definitions,files,flow,share}.ts` are pure and unit-tested
over fixture strings; everything else is browser-bound and covered only by the e2e suites.
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
