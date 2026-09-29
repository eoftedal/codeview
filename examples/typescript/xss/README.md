# DOM cross-site scripting (TypeScript, three files)

`location.search` → `new Draft(author, body)` → `draft.toHtml()` → `innerHTML` in another file.

|         |                                                                     |
| ------- | ------------------------------------------------------------------- |
| Source  | `location.search` and `location.hash` in `main.ts`                  |
| Sink    | `element.innerHTML` in `render.ts`                                  |
| Carrier | the `Draft` wrapper, whose `toHtml` builds the markup in `model.ts` |

Things worth checking a trace against:

- `escapeHtml` exists in `model.ts` and is never called. A review that reports the file as escaped
  because an escaper is in it has read the wrong thing.
- `setStatus` is the short path: one hop from `location.hash` to the sink, no class in between.
- `showStatus` writes `textContent` and is unreachable from any source here.
