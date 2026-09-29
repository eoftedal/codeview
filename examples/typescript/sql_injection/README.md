# SQL injection (TypeScript, three files)

`req.query.customer` → `OrderFilter` → interpolated WHERE clause → `new OrderQuery(where)` →
`pool.query` in another file.

|         |                                                                                      |
| ------- | ------------------------------------------------------------------------------------ |
| Source  | `req.query.customer`, `req.query.status`, `req.body.customer` in `routes.ts`         |
| Sink    | `pool.query` in `db.ts`                                                              |
| Carrier | the `OrderQuery` wrapper class, constructed in `orderService.ts` and read in `db.ts` |

Things worth checking a trace against:

- The value crosses two imports, so the definition of `findOrders` is in a tab the editor is not
  showing when the cursor is in `routes.ts`.
- `q.where` is a field read on a wrapper, so following it means following the receiver back to
  `new OrderQuery(where)` and picking the argument that filled that field.
- `orderById` in the same file is the parameterised version, and nothing flows into it — a trace
  that reaches it has followed a path the code never takes.
