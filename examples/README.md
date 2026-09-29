# Deliberately vulnerable code samples

Fourteen small applications, most with at least one flaw put there on purpose and one with none at
all. They exist to be read with this viewer: to check that a trace reaches the source it should
reach, that it does not reach one it should not, and to have something concrete in the editor when
trying out a hunter brief or a team of agents. One of them — `c/buffer_overflow` — is for a language
with no trace at all, and is written for the tree, the definitions and a hunter instead.

**None of this is code to copy.** Nearly every sample has a working exploit in it, several have
hardcoded credentials, and the correct version of an operation usually sits in the same file as the
flawed one, called by nothing.

**Nothing in the code tells you which is which.** No source file explains itself and no name gives
the answer away: the correct alternative is called `fetch`, `load`, `open_report` or `parseTitle`,
not `findSafely`, because a reviewer who is being tipped off is not being tested. The only prose
allowed in a source file is a _false_ claim of security — which is what `java/misleading_comment` is
made of. The `README.md` in each slug folder is the answer key, and it is the only one.

## Opening one

Drop a slug folder onto the editor, or use the folder button. The files arrive under their paths,
so the imports between them resolve and a trace walks along them; the `README.md` beside them is
not a language this viewer reads and is skipped rather than opening as a tab.

One folder at a time is the intended unit. Dropping `examples/` whole opens everything, and since
the four tree-sitter backends and the TypeScript one never share a file set, nothing resolves
between a `.py` and a `.java` anyway. C and C++ are the one pair that do share a backend, which is
what lets `server.c` resolve into `wire.h`.

## What is in them

| Language     | Slug                       | Flaws                                                                                                                                        | Files |
| ------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `typescript` | `sql_injection`            | SQL injection through a wrapper class                                                                                                        | 3     |
| `typescript` | `xss`                      | DOM cross-site scripting, two paths to `innerHTML`                                                                                           | 3     |
| `typescript` | `multiple_vulnerabilities` | Path traversal, command injection, broken object level authorization, open redirect, MD5 passwords, unverified JWT, hardcoded secret         | 4     |
| `typescript` | `template_strings`         | None. A tagged template that binds every value, so the interpolation only looks like injection                                               | 2     |
| `python`     | `sql_injection`            | SQL injection, by `%` format and by f-string                                                                                                 | 2     |
| `python`     | `command_injection`        | `shell=True` and `os.system`, one behind an object                                                                                           | 2     |
| `python`     | `multiple_vulnerabilities` | Pickle deserialization, path traversal, SSRF, `yaml.load`, `eval`, hardcoded key, SHA-1 passwords, TLS verification off                      | 5     |
| `java`       | `sql_injection`            | SQL injection through a record component, plus an unsortable-column concatenation                                                            | 4     |
| `java`       | `path_traversal`           | Traversal reading and writing, through a record and through an upload name                                                                   | 3     |
| `java`       | `multiple_vulnerabilities` | Command injection, XXE, Java deserialization, missing function level authorization, hardcoded key, MD5 tokens                                | 5     |
| `java`       | `misleading_comment`       | SQL injection behind a `PreparedStatement`, and a comment that says otherwise                                                                | 4     |
| `java`       | `domain_objects`           | Looks like SQL-injection in several instances but some are safe due to input validation (although still a bad pattern defense-in-depth wise) | 16    |
| `csharp`     | `sql_injection`            | SQL injection through a record component, through an object initializer, and through an interpolated `LIKE` pattern                          | 5     |
| `c`          | `buffer_overflow`          | Unbounded `memcpy` from a peer-chosen length, off-by-one, integer overflow before `malloc`, use-after-free and double free                   | 3     |

Most slug folders have a `README.md` naming the source, the sink, what carries the value between
them, and what a trace over it is worth checking against — including, in several of them, a path
that looks reachable and is not.

## What they were written to exercise

The samples are not only a list of bugs. Each one leans on something the viewer has a rule for:

- **A value carried inside an object.** `OrderQuery` in TypeScript, `Lookup` and `Probe` in Python,
  `ProductId` and `BackupRequest` in Java — the sink reads a field, and the only way to the source
  is back through the constructor that filled it.
- **A record component.** `ProductId.value()` in Java is an accessor that appears in no source file,
  and `DownloadRequest` has one tainted component and one constant one. C# spells the same thing
  `ProductId.Value` — a property rather than a call — which is why `csharp/sql_injection` was written
  as the deliberate twin of `java/sql_injection`: same carrier, same traps, so the only difference
  read side by side is the language.
- **A construction that is not on the path.** `ProductRepository.map` builds a second `ProductId`
  out of a database row. Nothing passes it to `find`, so a trace that reaches it has reported a
  path the program cannot take.
- **A value in an object initializer.** `ProductFilter` in C# is filled by `new ProductFilter { Name = name }`
  with no constructor involved, which is the other way a member gets a value and the one a walk over
  argument lists alone misses.
- **A flaw with no flow at all.** The missing authorization checks, the hardcoded keys and the weak
  hashes have no tainted value to follow. They are in here because a review that only follows
  values will not find them.
- **A flaw in a language with no trace.** `c/buffer_overflow` cannot be followed by the viewer at
  all, deliberately — its carrier is a pointer, which is the reason C ships without a trace. It is
  the sample for checking that the tree and the definitions are worth something on their own, and
  that a hunter brief finds what no walk here can.
- **Code that looks like the flaw and is not.** `typescript/template_strings` interpolates a request
  value straight into a SQL string, which is the exact silhouette of injection, and is safe twice
  over — the tag binds every value and the id was parsed by a schema first. `java/domain_objects` is
  the same lesson at length. A reviewer is judged as much by what it declines to report, and these
  are what judge it.
- **A comment that is confidently wrong.** `java/misleading_comment` claims parameterised queries
  throughout, uses `prepareStatement` everywhere, binds a value in every method, and is injectable
  in two of its three. It is the one sample where reading the prose instead of the code produces a
  specific wrong answer rather than a vague one.

## Adding one

`CLAUDE.md` in this folder has the conventions: the slug layout, the two rules about comments and
names above, what to build in so a slug exercises something the viewer has a rule for, the three
edits that register it here, and how to verify the trace does what its README claims before you
trust it.
