/**
 * Just enough Markdown for a model's answer.
 *
 * Answers come back as Markdown — fenced code, `**bold**`, bullet lists — and rendering them raw
 * puts the asterisks on screen. This turns the text into a small block list, which the pane draws
 * with ordinary elements: no `v-html`, so nothing a model writes can become markup, and no parser
 * dependency for the handful of constructs an answer actually uses.
 *
 * What it deliberately does not do: nested emphasis, tables, reference links, HTML. Those degrade
 * to plain text, which is the right failure for a chat bubble.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; href: string }

export interface ListItem {
  spans: Inline[]
  /** Nesting level, from the item's indentation. */
  depth: number
}

export type Block =
  | { kind: 'paragraph'; spans: Inline[] }
  | { kind: 'think'; text: string }
  | { kind: 'heading'; level: number; spans: Inline[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; spans: Inline[] }
  | { kind: 'rule' }

/**
 * A reasoning model's thinking block. It reaches us two ways: a model left to think out loud, and
 * the *empty* block WebLLM prefills to stop one thinking — that second kind is pure protocol and
 * has no business on screen at all. Anything real is kept, but folded away.
 */
const THINK = /<think>([\s\S]*?)(?:<\/think>|$)/

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const NUMBER = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/

/**
 * Emphasis is `*`-only on purpose: `_` is a word character in the code these answers are about, and
 * `snake_case_names` would come out italicised. Link targets must be http(s), so a `href` can never
 * be built out of anything a model dreamt up.
 */
const INLINE =
  /`([^`\n]+)`|\*\*(?!\s)([^\n]+?)(?<!\s)\*\*|\*(?!\s)([^*\n]+?)(?<!\s)\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

/** Inline spans of one line. Emphasis carries plain text — no nesting, by design. */
export function parseInline(text: string): Inline[] {
  const spans: Inline[] = []
  let last = 0

  for (const match of text.matchAll(INLINE)) {
    const index = match.index
    if (index > last) spans.push({ kind: 'text', text: text.slice(last, index) })
    if (match[1] !== undefined) spans.push({ kind: 'code', text: match[1] })
    else if (match[2] !== undefined) spans.push({ kind: 'strong', text: match[2] })
    else if (match[3] !== undefined) spans.push({ kind: 'em', text: match[3] })
    else spans.push({ kind: 'link', text: match[4]!, href: match[5]! })
    last = index + match[0].length
  }

  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) })
  return spans
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    NUMBER.test(line) ||
    QUOTE.test(line)
  )
}

export function parseMarkdown(source: string): Block[] {
  const think = THINK.exec(source)
  if (think) {
    const before = source.slice(0, think.index)
    const after = source.slice(think.index + think[0].length)
    const thought = think[1]!.trim()
    return [
      ...parseMarkdown(before),
      // An empty block is the suppression marker, not something the model said: drop it whole.
      ...(thought ? [{ kind: 'think' as const, text: thought }] : []),
      ...parseMarkdown(after),
    ]
  }

  const lines = source.split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!

    if (!line.trim()) {
      index++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]![0]!
      const closing = new RegExp(`^\\s{0,3}${marker === '`' ? '`' : '~'}{3,}\\s*$`)
      const body: string[] = []
      index++
      // An unterminated fence is the normal state of a streaming answer, so the rest is the block.
      while (index < lines.length && !closing.test(lines[index]!)) body.push(lines[index++]!)
      if (index < lines.length) index++
      blocks.push({ kind: 'code', language: fence[2] || null, text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        spans: parseInline(heading[2]!),
      })
      index++
      continue
    }

    // Before the bullet rule: `* * *` is a rule, not a list of two empty items.
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      index++
      continue
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = !BULLET.test(line)
      const items: ListItem[] = []
      let start = 1

      while (index < lines.length) {
        const current = lines[index]!
        const bullet = ordered ? null : BULLET.exec(current)
        const numbered = ordered ? NUMBER.exec(current) : null

        if (bullet) {
          items.push({ spans: parseInline(bullet[2]!), depth: Math.floor(bullet[1]!.length / 2) })
        } else if (numbered) {
          if (items.length === 0) start = Number(numbered[2])
          items.push({
            spans: parseInline(numbered[3]!),
            depth: Math.floor(numbered[1]!.length / 2),
          })
        } else if (current.trim() && !isBlockStart(current) && items.length > 0) {
          // A wrapped item: the continuation belongs to the line above it.
          const item = items[items.length - 1]!
          item.spans = parseInline(`${spansToText(item.spans)} ${current.trim()}`)
        } else {
          break
        }
        index++
      }

      blocks.push({ kind: 'list', ordered, start, items })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      const body: string[] = [quote[1]!]
      index++
      while (index < lines.length) {
        const next = QUOTE.exec(lines[index]!)
        if (!next) break
        body.push(next[1]!)
        index++
      }
      blocks.push({ kind: 'quote', spans: parseInline(body.join('\n')) })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index]!.trim() && !isBlockStart(lines[index]!)) {
      paragraph.push(lines[index++]!)
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join('\n')) })
  }

  return blocks
}

/** Re-flattens spans so a wrapped list item can be parsed as one line. */
function spansToText(spans: Inline[]): string {
  return spans
    .map((span) => {
      switch (span.kind) {
        case 'code':
          return `\`${span.text}\``
        case 'strong':
          return `**${span.text}**`
        case 'em':
          return `*${span.text}*`
        case 'link':
          return `[${span.text}](${span.href})`
        default:
          return span.text
      }
    })
    .join('')
}
