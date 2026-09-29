# SQL injection through a record wrapper (Java, four files)

`@PathVariable String id` → `new ProductId(id)` → `id.value()` → `Statement.executeQuery`.

|         |                                                                                       |
| ------- | ------------------------------------------------------------------------------------- |
| Source  | `@PathVariable String id` and `@RequestParam String sort` in `ProductController.java` |
| Sink    | `Statement.executeQuery` in `ProductRepository.java`, twice                           |
| Carrier | the `ProductId` record, constructed in the controller and read in the repository      |

Things worth checking a trace against:

- `value()` is an accessor that appears in no source file: the record generates it, and the
  component it returns is the canonical constructor's parameter. There is no assignment to walk to.
- `map` constructs a second `ProductId` out of a `ResultSet`, and nothing ever passes that one to
  `find`. Reaching it from `id.value()` means the receiver was not followed, and the path reported
  is one the program cannot take.
- The `sort` path has no wrapper and no parameterised alternative: a column name cannot be bound,
  so the fix there is an allowlist rather than a `PreparedStatement`.
- `fetch` binds the value and is called by nothing.
