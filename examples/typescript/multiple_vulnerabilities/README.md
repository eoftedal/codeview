# Several classic flaws in one app (TypeScript, four files)

An Express service whose routes are in `server.ts` and whose sinks are spread over three more.

| Route               | Flaw                              | Source                 | Sink                                                  |
| ------------------- | --------------------------------- | ---------------------- | ----------------------------------------------------- |
| `GET /avatar`       | Path traversal                    | `req.query.name`       | `readFileSync` in `storage.ts`                        |
| `POST /reports`     | Command injection                 | `req.body.name`        | `exec` in `shell.ts`, through the `ExportJob` wrapper |
| `GET /invoices/:id` | Broken object level authorization | `req.params.id`        | the lookup, with no owner check anywhere on the path  |
| `GET /login/done`   | Open redirect                     | `req.query.next`       | `res.redirect` in the same file                       |
| `POST /login`       | Unsalted MD5 password hash        | —                      | `hashPassword` in `auth.ts`                           |
| `GET /me`           | Signature never verified          | `Authorization` header | `jwt.decode` in `auth.ts`                             |
| `auth.ts`           | Hardcoded signing secret          | —                      | `JWT_SECRET`                                          |

Things worth checking a trace against:

- The command injection is the only one with a wrapper object on the path: the name is read back
  out of `this.name` inside `command()`, a method of a class built one function away.
- `isInsideUploads` in `storage.ts` is the containment check, written and never called.
- `/invoices/:id` has nothing wrong with the _value_ — following it finds no escaping bug at all.
  What is missing is a comparison against the session, which is not a step in any flow.
