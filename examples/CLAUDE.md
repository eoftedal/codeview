# examples/CLAUDE.md

Guidance for working in this directory. The root `CLAUDE.md` describes the viewer; this describes
the corpus it is read with.

## What these are

Fourteen small applications across five languages, most with at least one flaw put there on
purpose. They are not test fixtures and not minimal reproductions — they exist to be **opened in the
viewer** and read: to check that a trace reaches the source it should reach, that it does not reach
one it should not, and to give a hunter brief or a team of agents something concrete to work on.

`examples/README.md` is the index. Every slug is registered there, and the count in its first
sentence is part of the registration.

## The three rules

**An example provides example functionality.** A slug is a small application that plausibly does
something — a product API, a probe tool, a wire-protocol server — and the flaw lives inside
functionality that has a reason to exist. This is not decoration. A bare repro has one path, and a
trace over it teaches nothing; a real shape has a controller, a carrier, a repository and a second
caller, which is what makes the trace worth following and what gives the negative checks below
somewhere to live. Write the application first and put the flaw where it would actually be.

**No comment and no name reveals the flaw.** Source files carry **no explanatory commentary** — not
a header, not a `// the bug is here`, not a docstring describing a design. Check it before finishing:

```sh
grep -rnE '^\s*(//|#[^!]|/\*|\*)' --include='*.ts' --include='*.py' --include='*.java' \
  --include='*.cs' --include='*.c' --include='*.h' .
```

**The one thing a comment may do is lie.** A comment that claims the code is secure when it is not —
"values are bound rather than written into the query", an audit note, a `@SuppressWarnings` with a
reassuring reason — is the single permitted use of prose in a source file, and it is permitted
because it is not an explanation but a **trap**. It tests the one failure a reviewer reading prose
instead of code will always make. So when writing a slug there is exactly one comment worth typing,
and it is a false claim of safety; the moment a comment is true and useful about security, it has
become an answer key in the wrong file. (Two lines in `java/domain_objects` — a commented-out
`println` and a note about polling the database — are leftover noise from code adapted out of a real
project. Harmless, and not something to reproduce.)

**Names obey exactly the same rule, and `findSafely` is the case to know.** A name may be neutral or
it may mislead, but it may never tell the truth about safety — so `findSafely`, `readSafely`,
`store_name_checked` and every relative are allowed **only when they are a lie**, naming a method
that is not safe at all. Used honestly, on the method that really is parameterised, such a name
hands over the answer before the reader has read a line, and a reviewer being tipped off is not
being tested.

Name the correct alternative whatever a real codebase would call it — `fetch`, `fetch_user`, `load`,
`open_report`, `parseTitle`, `showStatus`, `reach`, `set_name` — and let the query, the bound or the
argument list say which is which. Those are the names the corpus now uses, and each one replaced a
`*Safely` that gave its slug away.

**Only the `README.md` reveals.** It is the answer key, it is the single place anything is explained,
and the viewer never opens it as a tab: a folder open keeps a file only when its extension names a
language it reads (`src/lib/upload.ts`), so the prose sits beside the code without being in it.

`java/misleading_comment` is the slug built entirely out of that permission: its class javadoc, two
of its three method comments and a dated audit note all insist every statement is parameterised, and
two of the three queries are injectable anyway. Reading the prose instead of the code there produces
a specific wrong answer rather than a vague one, which is the whole design.

> **Two slugs are deliberately exempt from the naming sweep.** `typescript/template_strings` and
> `java/domain_objects` are left as they are; everywhere else the `*Safely` names have been renamed,
> and `grep -rniE '(safe|secure|unsafe|sanitiz|validated)'` over the sources comes back empty.

## Shape of a slug

**Every sample is a slug, and slugs are divided by language.** Two levels, always, with no sample
loose at either — the language directory, then the slug:

```
examples/
  <language>/               one of: typescript, python, java, csharp, c
    <slug>/                 lowercase snake_case, naming the flaw class
      README.md             the answer key; never opens as a tab
      <sources>             real-looking module names, under real-looking paths
```

The language directory is a fixed set — it is what the index table's first column reads, and adding
one means the viewer gained a language. **C and C++ share the `c` directory**, as they share a
grammar and a backend; a C++ slug goes there with `.cpp` files rather than into a `cpp/` of its own.

The slug name is the flaw class as a reader would search for it: `sql_injection`, `path_traversal`,
`command_injection`, `buffer_overflow`, `xss`. Three names break that pattern on purpose:
`multiple_vulnerabilities` for a slug with several unrelated flaws, and `misleading_comment` and
`domain_objects`, whose subject is not a flaw class at all. Prefer the flaw class; reach for
a theme only when there genuinely isn't one.

**The same slug name across languages is a feature.** `sql_injection` exists in four languages and
`csharp/sql_injection` was written as the deliberate twin of `java/sql_injection` — same carrier,
same off-path construction, same unbindable column — so the two can be read side by side and the
difference is the language rather than the scenario. When a flaw class already exists elsewhere,
mirror it before inventing something new.

Files arrive under their paths, and a tab name **is** a module path — so imports between the files
must resolve, or the trace stops at the file boundary and the slug is worthless. How that works
differs per language, and it decides where files may sit:

| Language     | What resolves between tabs                                                                |
| ------------ | ----------------------------------------------------------------------------------------- |
| `typescript` | `./db` finds `db.ts`, `lib/db.ts`, `lib/index.ts` — TypeScript's bundler resolution       |
| `python`     | `import db` finds `db.py` or `db/__init__.py`; relative imports resolve from the file     |
| `java`       | `import com.example.Db` finds `com/example/Db.java` or `Db.java`; same-package needs none |
| `csharp`     | nothing — a `using` imports a namespace, so a type is found in **any** open tab           |
| `c`          | `#include "wire.h"` finds `wire.h` by suffix; otherwise any open tab's file scope         |

`java/domain_objects` is the only slug that uses subdirectories (`domain/`, `dto/`), and it can
because Java's import names a path. Keep a slug flat unless the language gives a reason not to.

**One slug is the intended unit.** The strip caps at 50 tabs, and dropping `examples/` whole opens
everything without resolving anything across languages — the backends never share a file set.

## Shape of the README

Follow the existing ones exactly; they are consistent and the consistency is the point.

```markdown
# <Flaw> through <carrier> (<Language>, <N> files)

`<source expression>` → `<carrier>` → `<read>` → `<sink call>`.

|         |                                       |
| ------- | ------------------------------------- |
| Source  | the expression, and the file it is in |
| Sink    | the call, and the file it is in       |
| Carrier | what moves the value between them     |

Things worth checking a trace against:

- one bullet per checkable claim, positive and negative
```

The bullets are the valuable half. Write them as things a reader can **verify against the pane**,
not as a description of the bug — and include at least one **negative** check, a path the trace must
_not_ report.

## What to build in

A slug earns its place by exercising something the viewer has a rule for. The ones already used,
worth reusing:

- **A value carried inside an object** — the sink reads a field and the only way back is through the
  constructor that filled it. Every language here has a spelling: a class, a `record`/positional
  record, a `dataclass`-ish object, a `struct`.
- **A construction that is not on the path** — a repository `map` that also builds the wrapper out of
  a database row. Nothing passes it to the sink, so a trace that reaches it has reported a path the
  program cannot take. This is the single most valuable check in the corpus.
- **A member filled without a constructor** — C#'s `new Filter { Name = name }`, a field assigned
  after construction. A walk that only reads argument lists stops at the `new`.
- **An interpolated string** — an f-string, a `$"…"`, a template literal. These are not literals and
  every hole is an operand; a trace that treats one as a constant ends a step above the flaw.
- **Something unbindable** — a sort column or a table name, which no parameter can carry, so the fix
  is an allowlist and the trace is short and direct.
- **An alternative that is called by nothing** — the same operation done correctly, present so a
  reader has to tell them apart by reading rather than by name.
- **A flaw with no flow at all** — a missing authorization check, a hardcoded key, a weak hash. A
  review that only follows values will not find these, which is why they are here.

## Looking insecure and being secure, and the reverse

**A corpus of obvious flaws only ever tests one half of a review.** A reviewer — a reader, a hunter
brief, a line of agents — is judged as much by what it declines to report as by what it finds, and
neither of those is exercised by code whose flaw is the only interesting thing in it. So the corpus
deliberately holds both directions, and a new slug should be built with the question in mind: _what
in here looks like the answer and is not?_

Both poles are already present, and they are the models to copy:

- **Looks insecure, is secure.** `typescript/template_strings` interpolates a request value straight
  into a SQL string — `` query`… WHERE id = ${productId}` `` — which is the exact silhouette of the
  flaw. It is safe twice over: `query` is a **tagged template** that joins the strings with `?` and
  binds every value, and the id was parsed through a zod schema upstream. Its row in the index reads
  "None." and that is the whole point; a review that reports it has failed.
- **Looks secure, is not.** `java/misleading_comment` uses `prepareStatement` on every query, binds a
  value with `setString` in every method, and carries a dated audit note — and two of its three
  queries are injectable, because `prepareStatement` parameterises the string it is _given_ and
  cannot un-concatenate what went in before. Its comments are the lie the rule above permits — the
  artefact rather than an explanation of one.

Three rules follow, and the third is the one that is easy to get wrong:

**A slug may have no flaw at all.** Say "None." in the index row, plainly, and do not soften it —
a reader who cannot trust the index cannot use the negative cases. `typescript/template_strings` has
no `README.md`, which is a gap rather than a pattern: a no-flaw slug needs one _more_ than the others,
because the reader needs somewhere to check that being unable to find anything was correct.

**Put a near-miss inside a slug that does have a flaw.** The value that reaches the same sink and is
not tainted (`self.count` in `python/command_injection`), the record component that is constant while
its sibling is not (`java/path_traversal`), the member set from a default (`ProductFilter.Limit` in
`csharp/sql_injection`). Name it in the README's bullets as something the trace should **not**
report, alongside the path it should.

**Whatever makes the safe version safe has to be readable in the slug.** This is the trap. If the
sanitiser lives in a library, in a framework's default, or in a tab the reader does not have open,
then "looks insecure, is secure" is indistinguishable from "is insecure" and the sample teaches
nothing but doubt. `template_strings` works precisely because `query` is defined eight lines below
the call that uses it, in the same file — the reader can see the `strings.join('?')` and settle the
question. Import the protection from outside the slug and you have written a puzzle with no
answer in the box.

## Languages without a trace

**C and C++ have no backward trace, deliberately** (root `CLAUDE.md` says why: the carrier is a
pointer). A C slug therefore cannot promise the "check the trace reaches the right source" workflow
every other slug is written around, and its README must **say so up front** rather than leave a
reader pressing a disabled button. Write it for the tree, the definitions across `#include`, and a
hunter brief — `Memory safety` is the one written for it. `c/buffer_overflow` is the worked example.

## Registering a new slug

Three edits in `examples/README.md`, and all three matter:

1. The count in the first sentence.
2. A row in the table — language, slug, flaws, file count.
3. A bullet under **What they were written to exercise**, but only if the slug brings something the
   list does not already have. It is a list of rules exercised, not a changelog.

## Verifying before you finish

Do not assume the trace does what the README claims — it is the claim most easily wrong, and a wrong
answer key is worse than no slug. Write a throwaway vitest file, run it, read the output, delete it:

```ts
// tests/tmp-slug.test.ts — delete after reading
const parser = await csharpParser() // or cParser, javaParser, pythonParser
const files = NAMES.map((n) => {
  const text = readFileSync(`examples/csharp/<slug>/${n}`, 'utf8')
  return { name: n, root: parser.parse(text)!.rootNode, text }
})
const trace = traceCSharpOrigins(sinkFile, files, sinkFile.text.indexOf('<sink>') + OFFSET)
// walk trace.nodes and console.log each row, then check it against the README's bullets
```

Check three things: **every file parses with no `ERROR` node**; the trace from each sink reaches the
source the README names; and the negative check holds — the off-path construction does **not**
appear. For a C slug, check the definitions resolve across the `#include` instead.

The corpus is not in the CI gate, so this is the only thing standing between a wrong README and a
reader who trusts it.

## Safety

**None of this is code to copy**, and the top-level README says so for a reason: nearly every sample
has a working flaw in it and several carry hardcoded credentials. Keep credentials obviously fake
(`hunter2`, `db.internal`), keep payloads no more specific than the flaw needs, and never add a
ready-to-run exploit — the flaw is the lesson, the exploit is not.
