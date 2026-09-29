# A comment that lies about the security (Java, four files)

`ReportRepository` says, in its class javadoc and again on two of its three methods, that every
statement is a `PreparedStatement` and that user input is therefore never part of the SQL text.
It uses `prepareStatement` on every query, binds a value with `setString` in every method, and
carries a dated audit note. Two of the three queries are injectable anyway.

The claim is about the wrong moment. `prepareStatement` parameterises the string it is _given_;
it cannot un-concatenate what was put into that string before it arrived.

| Method     | Comment says                                            | Actually                                                                                  |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `find`     | values are bound rather than written into the query     | `team` is concatenated into `sql` before `prepareStatement` sees it; `id` really is bound |
| `recent`   | the team is a bound parameter, not string concatenation | true of `team`, and irrelevant — `orderBy` is appended to the `StringBuilder`             |
| `countFor` | avoids SQL injection by using prepared statements       | true                                                                                      |

|         |                                                                                           |
| ------- | ----------------------------------------------------------------------------------------- |
| Source  | `@RequestParam String team` and `@RequestParam String orderBy` in `ReportController.java` |
| Sink    | `prepareStatement` in `ReportRepository.java`, twice                                      |
| Carrier | the `ReportQuery` record for `find`; a `StringBuilder` for `recent`                       |

## What the sample is for

The three methods carry the same reassurance and differ only in their code, so the comment
distinguishes nothing. A review that reads the javadoc, sees `prepareStatement` and `setString`,
and reports the class as parameterised will have got every one of them wrong — including
`countFor`, which it will have been right about by accident.

`find` is the sharp case: the bound parameter is genuinely bound, so anything looking for the
_absence_ of `setString` finds nothing to report.

## What a trace over it reaches

- From `query.team()` in the concatenated string: back through `new ReportQuery(id, team)` to
  `@RequestParam String team`. The record has two components and only this one is on the path —
  `query.id()` traces to `@PathVariable String id` separately.
- From `orderBy` in the `append` chain: back to `@RequestParam String orderBy`. That is where a
  reader has to start.
- From `sql.toString()`, the expression actually handed to `prepareStatement`: **nothing**. The
  walk stops at `new StringBuilder("SELECT …")` and calls it external. The taint arrives through a
  mutation of an object rather than through a value, and this tool follows values.

That last one is a stated limit rather than a bug, and it is in the sample on purpose: the step
between "what `prepare` was given" and "what was appended to it" is the step a reviewer has to
take unaided.
