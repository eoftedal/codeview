# SQL injection through a record and an object initializer (C#, five files)

`[FromRoute] string id` → `new ProductId(id)` → `id.Value` → `SqlCommand`.

|         |                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| Source  | `[FromRoute] string id`, `[FromQuery] string sort` and `[FromQuery] string name` in `ProductController.cs` |
| Sink    | `new SqlCommand(...)` in `ProductRepository.cs`, three times                                               |
| Carrier | the `ProductId` record, and the `ProductFilter` object filled by an initializer                            |

This is the C# twin of `java/sql_injection`, written to the same shape so the two can be read side
by side: the same wrapper, the same second construction off the path, the same unbindable sort
column, the same uncalled safe method. What differs is the spelling, and each difference is a rule
of its own.

Things worth checking a trace against:

- **`Value` is a record component, not a method.** C# generates a property where Java generates an
  accessor, so `id.Value` is a bare member access rather than a call — and the component is still
  the canonical constructor's parameter, with no assignment to walk to.
- **`Map` constructs a second `ProductId`** out of an `IDataReader`, and nothing ever passes that
  one to `Find`. Reaching it from `id.Value` means the receiver was not followed, and the path
  reported is one the program cannot take.
- **`ProductFilter` is filled by an object initializer**, `new ProductFilter { Name = name }`, with
  no constructor involved at all. It is the other way C# gets a value into a member, and a trace
  that only reads argument lists stops at the `new`. `Limit` is set from a default and is not on the
  path.
- **`Search` interpolates into a `LIKE` pattern.** `$"...{filter.Name}..."` is an interpolated
  string, which is not a literal: every hole is an operand. A trace that treated the string as a
  constant would end one step above the flaw.
- **The `sort` path has no wrapper and no parameterised alternative.** A column name cannot be
  bound, so the fix there is an allowlist rather than a parameter — the trace is two hops and ends
  at the query parameter directly.
- **`Fetch` binds the value through a `SqlParameter`**, and is called by nothing. Neither name
  says which is which; the query does.
- The connection string carries a password, which no trace will find because nothing flows into it.
