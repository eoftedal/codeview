# Several classic flaws in one controller (Java, five files)

| Route                         | Flaw                                 | Source                       | Sink                                                            |
| ----------------------------- | ------------------------------------ | ---------------------------- | --------------------------------------------------------------- |
| `POST /admin/backup`          | Command injection                    | `@RequestParam String label` | `Runtime.exec` in `BackupService.java`, through `BackupRequest` |
| `POST /admin/feed`            | XML external entities                | the request body             | `DocumentBuilder.parse` in `FeedParser.java`                    |
| `POST /admin/session`         | Insecure deserialization             | the request body             | `ObjectInputStream.readObject` in `Sessions.java`               |
| `GET /admin/users/{id}/token` | Missing function level authorization | —                            | the whole class, which carries no authorization annotation      |
| `Sessions.java`               | Hardcoded signing key and MD5 token  | —                            | `SIGNING_KEY`, `tokenFor`                                       |

Things worth checking a trace against:

- `BackupRequest` is an ordinary class rather than a record, so the step from `command()` back to
  the constructor argument runs through `this.label = label` instead of through a component.
- `destination` is set in the same constructor from a constant and reaches the same command
  string. Only one of the two operands came from the request.
- `parseTitle` is the hardened parse, in the same file, called by nothing.
- The authorization flaw is not a flow: nothing about the value of `id` is wrong, and no trace
  will find what is missing.
