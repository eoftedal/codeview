# Command injection (Python, two files)

`request.args` → `Probe(host)` → `self.host` → `command()` → `subprocess.check_output(..., shell=True)`.

|         |                                                                           |
| ------- | ------------------------------------------------------------------------- |
| Source  | `request.args.get("host")` and the `X-Log-Name` header in `web.py`        |
| Sink    | `subprocess.check_output(..., shell=True)` and `os.system` in `netops.py` |
| Carrier | the `Probe` object; `run` calls `command`, which reads `self.host`        |

Things worth checking a trace against:

- `Probe(host)` is a construction, so the step that matters is `__init__` — nothing in `web.py`
  names it. A trace that stops at the construction and calls it a literal has lost the flow one
  hop before the interesting part.
- `self.count` is set in the same constructor from a literal and reaches the same command string.
  It is an operand of the format, and it is not tainted.
- `reach` passes an argument list, which never reaches a shell, and nothing calls it.
