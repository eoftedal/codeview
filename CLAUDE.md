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

**Two independent TypeScript setups exist, and conflating them causes confusion.**

1. `src/lib/analyzer.ts` — our own `ts.LanguageService` over one in-memory file, running `noLib` +
   `noResolve`. This is what produces the AST and answers `getDefinitionAtPosition`. Everything the
   app actually shows comes from here.
2. `src/lib/monacoSetup.ts` — Monaco's own bundled TS worker, which only powers editor niceties
   (hover, completion, squiggles). Its compiler options are separate and deliberately different.

Because of `noLib`/`noResolve`, a definition outside the buffer has no range to highlight, so
imported names resolve to their import statement. That is the intended answer, not a gap to fix.

**Data flow.** `useBuffer` decides the buffer's source (share link → localStorage → sample) and owns
filename/language/notice. `useAnalysis` holds a debounced (150 ms) parse in a `shallowRef` and bumps
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

**The chat tab is a third question with a third cost.** `src/lib/chat.ts` reaches for Chrome's
on-device `LanguageModel` global and nothing else — no key, no fetch, no fallback provider; if the
global is missing the pane says so and stops. `useChat` lives in `App.vue`, not in `ChatPane.vue`,
because the pane unmounts on every tab switch and a conversation must not. The system prompt (role,
the source/sink definitions, the line-numbered buffer) is built once per session, so the code it
carries is a snapshot — edits raise a `stale` hint rather than silently rebuilding the session,
which would discard the conversation. The availability probe waits for the tab to be opened.

Answers are Markdown, rendered by `markdown.ts` → `MarkdownText.vue` → `MarkdownSpans.vue` as
real elements — never `v-html`, which is what keeps model output from becoming markup. The parser's
odd-looking rules are deliberate: an unterminated fence is code (a streaming answer is always
mid-block), emphasis is `*`-only (`_` would italicise `snake_case`), and only `http(s)` targets
become links.

**Pure vs. impure.** `src/lib/{analyzer,astTree,definitions,flow,share}.ts` are pure and unit-tested
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
- **Monaco models need a real file extension in their URI** (`inmemory://codeview/main.tsx`); the TS
  worker keys off it and will flag valid TypeScript as errors without it.
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
