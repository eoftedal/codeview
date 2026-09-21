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
not a client: `providers/{builtin,webllm,transformers,openrouter}.ts` implement `availability` /
`load`, and nothing above them knows which model is answering. **Two lifetimes, and conflating
them is the bug that keeps coming back**: a `ModelEngine` owns the loaded weights and outlives
conversations, while a `ChatSession` is a system prompt and its turns. `newChat` drops the session
and keeps the engine — destroying the engine per conversation means reloading the model onto the
GPU on every "New chat". Three of the four providers keep the rule stated everywhere else: no key,
no server, no hosted fallback — every model runs on the reader's machine. `openrouter` is the one
deliberate exception, clearly labelled wherever it's offered: it sends the system prompt, the open
files and every question to OpenRouter's API using a key the reader supplies themselves
(`providers/openrouterKey.ts`, `localStorage` key `codeview:openrouter-key` — the first _secret_
kept there, under the same unencrypted trust model as every other persisted preference in this
app), and it is never included in a share link (`copyShareLink`/`buildFragment` in
`useBuffer.ts`/`App.vue` hand-pick exactly which fields go into the fragment; the key is never one
of them). An OpenRouter entry with no key configured stays visible in the picker rather than
disappearing — `Availability`'s `'needs-key'` — and `useModel`'s `engine()`/`engineFor()` refuse to
load one without a key, throwing a message that names the missing key specifically, before ever
attempting a request. The three shipped OpenRouter entries are not the whole story: a reader can
add any OpenRouter-hosted slug of their own from the same settings panel
(`providers/openrouterModels.ts`, `localStorage` key `codeview:openrouter-models`, turned into an
ordinary `ModelChoice` by `toModelChoice` so nothing downstream treats it differently). `MODELS` in
`chat.ts` is a static list, so `providers/index.ts`'s `allModels()` is what actually merges the
shipped catalogue with the reader's own — `usableModels()` and the new `findModel()` (the one
lookup `useModel`, `useAgents` and the agents pane use in place of `chat.ts`'s own `modelById`,
which only knows the shipped three) both go through it. Adding or removing one does not touch the
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
embeddings, not the 2.3B effective parameters, that make an "E2B" a 3 GB download. That split is also
a **lever on GPU memory**, and the only one those entries have: at q4f16 `embed_tokens` is 1.59 GB
against the decoder's 1.52 on E2B (2.02 against 2.89 on E4B), and it is a lookup table rather than
arithmetic, so `ModelChoice.cpuEmbeddings` runs it on the CPU and leaves the GPU to the decoder
alone. It is **off everywhere** — what it costs is `inputs_embeds` and `per_layer_inputs` crossing
from CPU to GPU on every token, and that has not been measured — so it exists to be flipped on an
entry and timed, not as a default. The record it builds lives in `providers/devices.ts`, its own
module for `ceiling.ts`'s reason, and the rule it encodes is the trap: Transformers.js dispatches a
device record per session **file**, and a file the record does not name falls back to the library's
default, which in a browser is `wasm` — so `SPLIT_SESSIONS` names _both_ sessions, or moving the
embeddings would take the decoder to the CPU with them. That is also why the field is only
meaningful on the Gemma 4 entries: every other ONNX model here is single-session (`model`), with
nothing to split and nothing to name. `tests/chat.test.ts` holds both halves.

The thinking prefill comes back in the answer, so `markdown.ts` parses `<think>` as a block kind: empty means protocol and is
dropped, non-empty is folded into a `<details>`, and an unterminated one is thinking-in-progress. `useChat` lives in `App.vue`, not in `ChatPane.vue`,
because the pane unmounts on every tab switch and a conversation must not. The system prompt (role,
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
Weakening any of the three is how a "mitigated" reaches the next agent as a "confirmed"; what the _orchestrator_ is given is clipped at `MAX_RELAY_CHARS`, and the clip
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
the name the picker shows, the complete system prompt — built from a shared opening and closing
around the per-class half in `FOCUS`, so a change to how a finding is reported is one edit rather
than fifteen. Both panes offer them (`ChatPane`'s settings panel, and every agent card in
`AgentsPane`, where the two shipped briefs sit in the same select), and picking one **only writes
the textarea**: there is no hunter id kept, no new key in a link and nothing downstream that knows
a brief came from here — an edited hunter is simply a brief of the reader's own, which is why the
select shows a name only while the text still equals that brief exactly and says _your own wording_
otherwise. They are deliberately shorter than `DEFAULT_ROLE` and capped at `HUNTER_CHAR_CAP`: brief
and code share one window, and a reviewer that already knows the class it is hunting does not need
`REVIEWER_BRIEF`'s vocabulary lesson. Two invariants `tests/hunters.test.ts` holds: each carries the
citation-and-honesty rules (check the name is on the line, one numbered step per hop, say plainly
when nothing is found) and hunts one class only — and none may contain a `--8<--` line, since a
hunter usually ends up as an agent's role and rides a team bundle.

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
handoff at the receiving agent's. **OpenRouter has its own ceiling**, `MAX_HOSTED_TOKENS`, not
`ceiling.ts`'s: on that API `max_tokens` also pays for the reasoning, and nothing hosted is looping.
Its thought does not arrive in the text either — it is `delta.reasoning` beside `delta.content` —
so `foldReasoning` in `providers/thoughts.ts` turns it into the `<think>` block everything else
already handles, on every stream regardless of the thinking flag, since a custom slug may reason
unasked. The shipped Review agent runs on `DEFAULT_REVIEW`, not `DEFAULT_ROLE`: the same
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
become links. A model reaching for LaTeX mid-sentence gets one concession: a `$…$` run
holding nothing _but_ arrow macros is spelled as the character (`SYMBOLS` in `markdown.ts`,
and adding a symbol means adding a row). Nothing but — which is what leaves `$5 to $10`, and
any macro the table has no character for, exactly as written.

**The brief is the system prompt; the code is a turn.** `buildSystemPrompt(role)` now returns the
brief and nothing else, and `buildCodeMessage({files, maxCodeChars})` returns the listing, which
`ModelEngine.chat(system, code)` seeds as a **hidden opening exchange** — a user turn carrying the
files, then `CODE_ACK` — ahead of the first real question. Instructions and data are different kinds
of thing, and a model told which is which is harder to talk out of its brief by something written in
a comment; the code message says so in its first sentence. **It is not a `tool` message, and that
was checked rather than assumed**: a tool message answers a tool call and there is none, Chrome's
Prompt API has no tool role at all (`initialPrompts` is system/user/assistant), WebLLM's
`ChatCompletionToolMessageParam` demands a `tool_call_id` while MLC drops an assistant turn's
`tool_calls` when rendering — so the call could never exist — and `apply_chat_template` runs the
model's own Jinja, which Gemma's has no tool branch in. **`CODE_ACK` is load-bearing, not polite**:
Gemma's template raises on two user turns in a row, so the seeded history has to stay alternating.
The agents' orchestrator calls `chat(system)` with no second argument, which is now the whole
mechanism by which it never sees a file.

**Pure vs. impure.** `src/lib/{agents,analyzer,astTree,definitions,files,flow,share}.ts` are pure and
unit-tested over fixture strings — the analyzer's fixtures are now _sets_ of files, which is how
cross-file resolution and cross-file traces are tested; everything else is browser-bound and covered only by the e2e suites.
`chat.ts` is the mixed case: `buildSystemPrompt`/`numberLines`/`promptFiles`/`describeStatus` are
pure, the `MODELS` catalogue is data, and only the provider seam is not. `stream.ts` is the shared
read loop both panes accumulate an answer with, and it is where an answer learns it was **cut off**:
both providers cap generation at one `MAX_NEW_TOKENS` (`providers/ceiling.ts`, its own module so
the ONNX worker's bundle does not pull the catalogue in for a number) — a ceiling against a model
that never emits its end of turn, not a per-model figure and not a target, so it is deliberately
generous and shared between thinking and answer. The ONNX worker counts tokens with a stopping
criterion and reports reaching it on `done`; WebLLM reports `finish_reason: 'length'`, which is
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
