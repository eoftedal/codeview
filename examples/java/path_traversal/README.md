# Path traversal (Java, three files)

`@RequestParam String name` → `new DownloadRequest(name, type)` → `request.name()` →
`new File(ROOT, …)` in another file.

|         |                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------- |
| Source  | `@RequestParam String name` and `MultipartFile.getOriginalFilename()` in `DocumentController.java` |
| Sink    | `Files.readAllBytes` and `MultipartFile.transferTo` in `DocumentService.java`                      |
| Carrier | the `DownloadRequest` record, whose second component is a constant                                 |

Things worth checking a trace against:

- The receiver is declared with `var`, so its type is written only on the `new` — following
  `request.name()` back means reading the type off the construction.
- `DownloadRequest` has two components and only the first one is tainted. A trace that reports
  both has expanded the construction instead of the component that was asked about.
- The upload path has no wrapper: the name arrives from a library call rather than a parameter,
  which is the hop most reviews miss.
- `load` is the version with the check, called by nothing.
