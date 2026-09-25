/**
 * The filter behind the quick-open palette: which open tabs a typed query names, in the order worth
 * showing them. Pure, so the scoring is pinned by `tests/quickOpen.test.ts` rather than judged by
 * eye through a dialog.
 *
 * Matching is a **subsequence**, not a substring, because that is the gesture a reader arrives with
 * from an editor: `slb` finds `src/lib/base.ts`. What makes such a matcher usable or useless is
 * entirely the ranking — every file in a source tree matches a short query somehow — so the score is
 * built from the three things that actually distinguish a wanted hit from an incidental one: letters
 * that run together, letters that start a word, and letters in the file's own name rather than in
 * the directories above it.
 */

/** Where a name ends and its directories stop: everything after the last `/`. */
function basenameStart(name: string): number {
  return name.lastIndexOf('/') + 1
}

/**
 * Whether the character at `index` starts a word. The separators are the ones a tab name actually
 * uses — `/`, `.`, `-`, `_` — plus a lowercase-to-uppercase hump, which is how `qO` finds
 * `quickOpen.ts`.
 */
function isBoundary(name: string, index: number): boolean {
  if (index === 0) return true
  const before = name[index - 1]!
  if ('/.-_ '.includes(before)) return true
  return before === before.toLowerCase() && name[index] !== name[index]!.toLowerCase()
}

/**
 * The best run of positions matching `query` from `start`, or null. Greedy forward: each query
 * character takes the next position it can, which is also the position that might be contiguous with
 * the one before it. The caller is what makes this good enough — it tries **every** starting position
 * rather than only the first, so `store` on `src/lib/store.ts` is not condemned to the `s` of `src`.
 */
function runFrom(lower: string, query: string, start: number): number[] | null {
  const hits: number[] = []
  let at = start
  for (const char of query) {
    const found = lower.indexOf(char, at)
    if (found < 0) return null
    hits.push(found)
    at = found + 1
  }
  return hits
}

function scoreOf(name: string, hits: readonly number[]): number {
  const base = basenameStart(name)
  let score = 0
  hits.forEach((index, n) => {
    score += 1
    // Letters typed in a row that land in a row: the strongest signal there is, and what separates
    // `db` naming `lib/db.ts` from `db` scattered through `dashboard.ts`.
    if (n > 0 && index === hits[n - 1]! + 1) score += 8
    if (isBoundary(name, index)) score += 6
    // A reader types the file's name far more often than the folders above it.
    if (index >= base) score += 4
  })
  return score
}

export interface QuickMatch<T> {
  file: T
  /** Indices into the name that matched, ascending — what a row underlines. */
  hits: number[]
  score: number
}

/**
 * The tabs a query names, best first. An empty query filters nothing and **reorders nothing**: the
 * caller hands the files in the order it wants them listed (most recently shown first), and that
 * order is what an untyped palette shows.
 *
 * Whitespace in the query is dropped rather than matched, since `db ts` is a reader reaching for
 * `db.ts` and there is no space in any name to find.
 */
export function quickOpen<T extends { name: string }>(
  files: readonly T[],
  query: string,
): QuickMatch<T>[] {
  const needle = query.replace(/\s+/g, '').toLowerCase()
  if (!needle) return files.map((file) => ({ file, hits: [], score: 0 }))

  const matches: QuickMatch<T>[] = []
  for (const file of files) {
    const lower = file.name.toLowerCase()
    let best: QuickMatch<T> | null = null
    for (let start = 0; start <= lower.length - needle.length; start++) {
      if (lower[start] !== needle[0]) continue
      const hits = runFrom(lower, needle, start)
      if (!hits) break
      const score = scoreOf(file.name, hits)
      if (!best || score > best.score) best = { file, hits, score }
    }
    if (best) matches.push(best)
  }

  // A shorter name wins a tie: with two equally good matches, the one carrying less around the
  // match is the one that was more specifically named. Then alphabetically, so the list never
  // reshuffles between two identical scores.
  return matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.file.name.length - b.file.name.length ||
      a.file.name.localeCompare(b.file.name),
  )
}

export interface Segment {
  text: string
  /** Part of what the query matched, and underlined as such. */
  hit: boolean
  /** Part of the directories in front of the name, and dimmed as such. */
  dim: boolean
}

/**
 * A name cut into runs that read the same way, so a row is a `v-for` and not a string of markup.
 * Matched characters and the directory prefix are independent — a query may well match inside a
 * folder name — so a run ends wherever either of them changes.
 */
export function segmentsFor(name: string, hits: readonly number[]): Segment[] {
  const matched = new Set(hits)
  const base = basenameStart(name)
  const segments: Segment[] = []
  for (let index = 0; index < name.length; index++) {
    const hit = matched.has(index)
    const dim = index < base
    const last = segments[segments.length - 1]
    if (last && last.hit === hit && last.dim === dim) last.text += name[index]
    else segments.push({ text: name[index]!, hit, dim })
  }
  return segments
}
