/**
 * `@` tags in a prompt: which open files a question names, and what a composer offers while one is
 * being typed.
 *
 * **A tag is a scope, not a hint.** A question naming no file is asked over every open tab, as it
 * always was; one naming `@routes.ts` is asked over that file alone — the budget goes to the code
 * the question is actually about rather than to eleven tabs it is not. That is the same narrowing
 * the trace pane's **Analyze this trace** does, and it is now the *only* mechanism: the button
 * writes the tags into the question it sends, so what narrowed a conversation is visible in the
 * conversation, editable before it is asked, and gone the moment the reader deletes it.
 *
 * **A tag is resolved against the open tabs, never parsed as a word.** `@Controller` in a Java
 * excerpt, `@app.route(...)` in a Python one and an email address in prose are all `@`-shaped, and
 * a trace pasted into the box is full of the first kind. So a mention is only a mention where the
 * text after the `@` *is* the name of an open file — the whole name, extension included — or an
 * unambiguous basename of one, which is how a reader would write `db.ts` for `src/lib/db.ts`.
 * Anything else is left as the prose it is.
 *
 * Pure: names in, names out, with no reference to a buffer or a pane.
 */

/** Everything that may sit in front of an `@` for it to open a tag. An identifier character may
 *  not, which is what leaves `user@example.com` alone. */
const OPENS = /[\s([{<"'`,;:]/

/** What may follow one: a name ends where a name ends, so `@db.ts` inside `@db.tsx` is not a
 *  match for `db.ts`. */
const NAME_CHAR = /[A-Za-z0-9_.\-/]/

/** Trailing punctuation a reader writes *after* a tag rather than as part of it — `@db.ts, and…`.
 *  Only stripped from the fallback token; a name that really ends this way still matches whole. */
const TRAILING = /[.,;:!?)\]}'"`]+$/

export interface Mention {
  /** Offset of the `@`. */
  start: number
  /** Offset just past the name, so `text.slice(start, end)` is the tag as written. */
  end: number
  /** The open file it names, or null where nothing open answers to it — a Java annotation, a
   *  decorator, a stray address. A null mention is prose and changes nothing. */
  name: string | null
}

function opensMention(text: string, at: number): boolean {
  return at === 0 || OPENS.test(text[at - 1]!)
}

/**
 * The file a tag at `at` names, longest name first — so `@lib/db.ts` is not read as `db.ts` with a
 * stray prefix when both tabs are open.
 */
function matchName(text: string, at: number, names: readonly string[]): string | null {
  const candidates = [...names].sort((a, b) => b.length - a.length)
  const lower = text.toLowerCase()
  for (const name of candidates) {
    if (!lower.startsWith(name.toLowerCase(), at)) continue
    const after = text[at + name.length]
    if (after === undefined || !NAME_CHAR.test(after)) return name
  }
  return null
}

/**
 * A name written the way a reader says it in prose — `db.ts` for `src/lib/db.ts`. Accepted only
 * where it is unambiguous: two tabs ending the same way are two files, and guessing between them
 * would narrow a question onto the wrong one. The same rule `read_file` follows in `tools.ts`.
 */
function matchBasename(token: string, names: readonly string[]): string | null {
  const wanted = token.replace(/^\.?\//, '').toLowerCase()
  if (!wanted) return null
  const exact = names.find((name) => name.toLowerCase() === wanted)
  if (exact) return exact
  const suffix = names.filter((name) => name.toLowerCase().endsWith(`/${wanted}`))
  return suffix.length === 1 ? suffix[0]! : null
}

/** Every `@` in the text, with what it names — including the ones that name nothing, since a
 *  composer may want to say so. */
export function findMentions(text: string, names: readonly string[]): Mention[] {
  const found: Mention[] = []
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (!opensMention(text, at)) continue
    const whole = matchName(text, at + 1, names)
    if (whole) {
      found.push({ start: at, end: at + 1 + whole.length, name: whole })
      at += whole.length
      continue
    }
    // Nothing open is spelled that way. Take what was written and try it as a basename, which is
    // the one forgiveness worth having: a reader naming `db.ts` for a tab called `lib/db.ts`.
    const raw = /^[^\s@]*/.exec(text.slice(at + 1))![0]
    const token = raw.replace(TRAILING, '')
    found.push({ start: at, end: at + 1 + token.length, name: matchBasename(token, names) })
  }
  return found
}

/**
 * The open files a question names, in the order it first names them — which is also the order they
 * are spent in, since a code budget is filled from the front. Deduplicated, and spelled the way the
 * tab is rather than the way the tag was.
 */
export function mentionedFiles(text: string, names: readonly string[]): string[] {
  const picked: string[] = []
  for (const mention of findMentions(text, names)) {
    if (mention.name && !picked.includes(mention.name)) picked.push(mention.name)
  }
  return picked
}

export interface MentionQuery {
  /** Offset of the `@` being typed. */
  start: number
  /** What has been typed after it, which is what the completion list filters on. */
  query: string
}

/**
 * The tag the caret is inside, for a composer to complete — or null when it is not in one.
 *
 * Deliberately not `findMentions`: that answers about finished text, where a tag either names an
 * open file or is prose. Half a name names nothing yet, and a completion list that waited for a
 * name to be complete would never appear.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  for (let at = caret - 1; at >= 0; at -= 1) {
    const char = text[at]!
    if (char === '@')
      return opensMention(text, at) ? { start: at, query: text.slice(at + 1, caret) } : null
    // A tag is one run: whitespace ends it, and a second `@` starts a new one.
    if (/\s/.test(char)) return null
  }
  return null
}

/**
 * The text with the tag being typed replaced by a chosen name, and where the caret then belongs.
 *
 * The *whole* token is replaced, not merely the part before the caret: completing in the middle of
 * a half-typed name must not leave its tail behind. A space is added after the name unless one is
 * already there, so tagging two files in a row reads as two tags rather than one long one.
 */
export function applyMention(
  text: string,
  start: number,
  name: string,
): { text: string; caret: number } {
  let end = start + 1
  while (end < text.length && !/\s/.test(text[end]!)) end += 1
  const rest = text.slice(end)
  const gap = rest.startsWith(' ') ? '' : ' '
  return {
    text: `${text.slice(0, start)}@${name}${gap}${rest}`,
    // Past the space, not before it: a caret left between the name and a space already there
    // would make the next character typed part of the tag, which is the one thing completing it
    // was supposed to settle.
    caret: start + 1 + name.length + 1,
  }
}

/**
 * What a pane says about a narrowed conversation or run, once the answer is the thing on screen.
 *
 * Worth saying at all because the narrowing is easy to forget: an answer over two files reads
 * exactly like one over twelve, and the tags that caused it may be far up a transcript by the time
 * it lands.
 */
export function describeScope(names: readonly string[]): string {
  const what = names.length === 1 ? 'the file' : `the ${names.length} files`
  return `only ${what} the question names (${names.join(', ')})`
}

/**
 * The same fact said *before* the question is asked, under the composer — where what matters is
 * what the tags are about to do rather than what they did.
 *
 * Two versions, because they are two different promises. A model handed the code is handed these
 * files and no others. A model that reads files itself is handed nothing: it is told to read these
 * first and left free to open any of the rest, which is the whole reason a tool-calling model is
 * given the index of every tab.
 */
export function describeDraftScope(names: readonly string[], reads: boolean): string {
  const list = names.join(', ')
  return reads
    ? `${list} — read first, and the rest can still be read`
    : `${list} — only these go to the model`
}

/**
 * The same line for a question asked into a conversation that already has one — where a tag does
 * something different and has to say so.
 *
 * A conversation cannot be re-scoped: it carries the code it was opened with. What a later tag can
 * do is **add** to it, which is what it does — so the three outcomes are named apart. A file the
 * conversation lacks is about to be sent with the question; one it already has is pointed at rather
 * than sent twice; and where the model reads its own files there is nothing to send either way.
 */
export function describeAddedFiles(
  added: readonly string[],
  known: readonly string[],
  reads: boolean,
): string {
  if (reads) {
    const all = [...added, ...known]
    return `${all.join(', ')} — the model is told to read ${all.length === 1 ? 'it' : 'them'}`
  }
  const parts: string[] = []
  if (added.length > 0) parts.push(`${added.join(', ')} will be added to this chat`)
  if (known.length > 0) {
    parts.push(`${known.join(', ')} ${known.length === 1 ? 'is' : 'are'} already in it`)
  }
  return parts.join('; ')
}
