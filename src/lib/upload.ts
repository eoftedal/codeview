/**
 * Where the browser's picked and dropped things become named files. The two halves of a folder open
 * arrive completely differently and neither is interchangeable with the other:
 *
 * A **directory picker** (`webkitdirectory`) has already walked the tree by the time the change
 * event fires — its `FileList` is flat, every entry carrying its path in `webkitRelativePath`, root
 * segment included. There is nothing to traverse and no way to stop it walking a `node_modules`, so
 * the ignore rule is applied afterwards, to the paths.
 *
 * A **drop** hands over nothing of the kind: `dataTransfer.files` holds one bogus entry per dropped
 * folder, which fails on the first read. The tree has to be walked here, from entries that are only
 * reachable **synchronously, inside the event, before the first await** — a `DataTransfer` is
 * emptied the moment the handler yields. So `filesFromDrop` takes every entry first and does all of
 * its waiting afterwards, and a drop handler must call it before awaiting anything itself.
 */
import { isIgnoredDir, languageForFile, type NamedFile } from './files'

/** Bounds on the walk, not features: a folder dropped from the wrong level — a home directory, a
 *  whole drive — would otherwise be traversed in full to have nearly all of it thrown away by the
 *  tab cap. Entries counts what was looked at, since that is where the cost is; files counts the
 *  handles actually asked for, and is a comfortable multiple of `MAX_OPEN_FILES` so that the fifty
 *  tabs which do open are still chosen from a real spread of the tree. */
const MAX_WALK_ENTRIES = 20_000
const MAX_WALK_FILES = 500

/** Picked files, named by path where the browser gave us one. A plain multi-file pick has no
 *  `webkitRelativePath`, so those keep the bare name they always had. */
export function filesFromInput(list: FileList | null): NamedFile[] {
  return [...(list ?? [])].map((file) => ({ name: file.webkitRelativePath || file.name, file }))
}

/**
 * `readEntries` hands back a batch at a time and signals the end with an empty one — Chrome's is
 * 100 entries — so it is called until it does. Reading a single batch is the bug this shape exists
 * to avoid: a directory of 150 files would quietly open 100 of them.
 */
function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = (): void =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all)
        else {
          all.push(...batch)
          next()
        }
      }, reject)
    next()
  })
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

interface Step {
  entry: FileSystemEntry
  /** The path of the directory holding it, empty for what was dropped itself. */
  prefix: string
}

/**
 * The walk, and it is **breadth-first on purpose**: depth-first plus a bound would stop somewhere
 * inside the first subdirectory it entered and never reach the files beside it, while a level at a
 * time means whatever `MAX_WALK_FILES` cuts off is the deepest thing found — which is exactly what
 * the tab cap was going to discard anyway.
 */
async function walk(roots: readonly FileSystemEntry[]): Promise<NamedFile[]> {
  const found: NamedFile[] = []
  let level: Step[] = roots.map((entry) => ({ entry, prefix: '' }))
  let seen = 0

  while (level.length > 0 && found.length < MAX_WALK_FILES && seen < MAX_WALK_ENTRIES) {
    const next: Step[] = []
    for (const { entry, prefix } of level) {
      if (found.length >= MAX_WALK_FILES || seen >= MAX_WALK_ENTRIES) break
      seen++
      const name = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory) {
        // `prefix` is empty only for what the reader actually dropped, and that is never stepped
        // over: dragging a folder called `dist` is asking for `dist`.
        if (prefix && isIgnoredDir(entry.name)) continue
        for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) {
          next.push({ entry: child, prefix: name })
        }
        continue
      }
      if (!entry.isFile) continue
      // A loose file was dropped by name, so it is kept whatever its extension — refusing it should
      // say so, and silence on a dropped `notes.md` reads as a broken drop target. Inside a folder
      // the opposite holds: a repository's images and lockfiles are what "skip what isn't
      // supported" means, and naming each of them is a wall of text rather than a notice. Asking
      // for the handle last is what keeps that skip cheap.
      if (!prefix || languageForFile(name)) {
        found.push({ name, file: await fileOf(entry as FileSystemFileEntry) })
      }
    }
    level = next
  }
  return found
}

/**
 * Everything dropped, folders walked. The synchronous prologue is load-bearing: `webkitGetAsEntry`
 * is called on every item before this function awaits anything, because the `DataTransfer` does not
 * survive the first yield. A browser that hands back no entries at all falls back to
 * `dataTransfer.files`, which is what a plain multi-file drop has always used.
 *
 * **Null means the drop carried no files** — a selection dragged about inside the editor bubbles a
 * `drop` here too — and is quite different from an empty array, which means files were dropped and
 * the walk found nothing in them worth opening. That has to be reported, so the two are kept apart.
 */
export async function filesFromDrop(transfer: DataTransfer | null): Promise<NamedFile[] | null> {
  if (!transfer) return null
  const entries = [...transfer.items]
    .map((item) => (item.kind === 'file' ? (item.webkitGetAsEntry?.() ?? null) : null))
    .filter((entry): entry is FileSystemEntry => !!entry)
  const loose = filesFromInput(transfer.files)
  if (entries.length === 0) return loose.length > 0 ? loose : null
  return await walk(entries)
}
