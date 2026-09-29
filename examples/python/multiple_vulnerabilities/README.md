# Several classic flaws in one app (Python, five files)

A Flask service whose routes are in `app.py` and whose sinks are one import away each.

| Route                      | Flaw                           | Source                      | Sink                                       |
| -------------------------- | ------------------------------ | --------------------------- | ------------------------------------------ |
| `GET /session`             | Insecure deserialization       | the `state` cookie          | `pickle.loads` in `session.py`             |
| `GET /reports/<path:name>` | Path traversal                 | the path segment            | `open` in `store.py`, through `ReportPath` |
| `GET /preview`             | Server-side request forgery    | `request.args["url"]`       | `requests.get` in `fetcher.py`             |
| `POST /profile`            | Unsafe YAML load and `eval`    | the request body and `rule` | `yaml.load` and `eval` in `settings.py`    |
| `app.py`                   | Hardcoded `secret_key`         | —                           | every signed cookie                        |
| `session.py`               | Unsalted SHA-1 password digest | —                           | `fingerprint`                              |
| `fetcher.py`               | TLS verification turned off    | —                           | `verify=False`                             |

Things worth checking a trace against:

- The traversal is the only path with an object on it; the other three are one call each.
- `open_report` is the checked version, in the same file, called by nothing.
- `fingerprint` and `verify=False` are flaws with no flow at all — nothing reaches them from a
  request, and following a value will never find either.
