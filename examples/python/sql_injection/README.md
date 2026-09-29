# SQL injection (Python, two files)

`request.args` → `Lookup(name)` → `self.term` → `cursor.execute`.

|         |                                                                 |
| ------- | --------------------------------------------------------------- |
| Source  | `request.args.get` and the `<user_id>` path segment in `app.py` |
| Sink    | `cursor.execute` in `repository.py`, twice                      |
| Carrier | the `Lookup` object, whose `term` is read back inside `where()` |

Things worth checking a trace against:

- `lookup.where()` is an attribute read on a parameter with no type written anywhere, so the only
  way to the value is to follow `lookup` back to `Lookup(name)` and take the argument that filled
  `self.term`.
- The `/users/<user_id>` path is the shorter one, and its f-string is a formatted string rather
  than a literal — the interpolated name is an operand, not text.
- `fetch_user` is the parameterised version of the same query and nothing calls it.
