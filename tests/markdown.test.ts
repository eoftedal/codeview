import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, type Block } from '../src/lib/markdown'

/** The rendered text of a block, with the markers the parser consumed put back. */
function text(block: Block): string {
  if (block.kind === 'code' || block.kind === 'think') return block.text
  if (block.kind === 'rule') return '---'
  if (block.kind === 'table') {
    return [block.header, ...block.rows]
      .map((row) => row.map((cell) => cell.map((span) => span.text).join('')).join(' | '))
      .join('\n')
  }
  const spans = block.kind === 'list' ? block.items.flatMap((item) => item.spans) : block.spans
  return spans.map((span) => span.text).join('')
}

describe('inline spans', () => {
  it('picks out code, emphasis and links', () => {
    expect(parseInline('the `id` is **tainted** and *unchecked*')).toEqual([
      { kind: 'text', text: 'the ' },
      { kind: 'code', text: 'id' },
      { kind: 'text', text: ' is ' },
      { kind: 'strong', text: 'tainted' },
      { kind: 'text', text: ' and ' },
      { kind: 'em', text: 'unchecked' },
    ])
  })

  it('leaves snake_case alone — underscores are word characters in code', () => {
    expect(parseInline('user_id and order_id')).toEqual([
      { kind: 'text', text: 'user_id and order_id' },
    ])
  })

  it('does not read a bare asterisk as emphasis', () => {
    expect(parseInline('SELECT * FROM users WHERE id = *')).toEqual([
      { kind: 'text', text: 'SELECT * FROM users WHERE id = *' },
    ])
  })

  it('keeps markers inside code spans verbatim', () => {
    expect(parseInline('`a ** b * c`')).toEqual([{ kind: 'code', text: 'a ** b * c' }])
  })

  it('spells a LaTeX arrow, in text and in emphasis', () => {
    expect(parseInline('req.params.id $\\rightarrow$ db.query')).toEqual([
      { kind: 'text', text: 'req.params.id → db.query' },
    ])
    expect(parseInline('a $$\\to$$ b $\\gets \\mapsto$ c')).toEqual([
      { kind: 'text', text: 'a → b ← ↦ c' },
    ])
    expect(parseInline('**source $\\to$ sink**')).toEqual([
      { kind: 'strong', text: 'source → sink' },
    ])
  })

  it('leaves dollars that are not a macro alone', () => {
    expect(parseInline('costs $5 to $10 a month')).toEqual([
      { kind: 'text', text: 'costs $5 to $10 a month' },
    ])
    // No character of its own, and a prefix of a longer name: both stay as written.
    expect(parseInline('$\\alpha$ and $\\top$')).toEqual([
      { kind: 'text', text: '$\\alpha$ and $\\top$' },
    ])
  })

  it('keeps a macro inside a code span verbatim', () => {
    expect(parseInline('`$\\to$`')).toEqual([{ kind: 'code', text: '$\\to$' }])
  })

  it('takes only http(s) links, so a href can never be script', () => {
    expect(parseInline('[owasp](https://owasp.org)')).toEqual([
      { kind: 'link', text: 'owasp', href: 'https://owasp.org' },
    ])
    expect(parseInline('[x](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[x](javascript:alert(1))' },
    ])
  })
})

describe('a reasoning model’s thinking', () => {
  it('drops the empty block that suppression prefills', () => {
    const blocks = parseMarkdown('<think>\n\n</think>\n\nThe sink is on line 21.')
    expect(blocks).toHaveLength(1)
    expect(text(blocks[0]!)).toBe('The sink is on line 21.')
  })

  it('keeps a real one, folded away from the answer', () => {
    const blocks = parseMarkdown('<think>Let me check line 10.</think>\n\nIt is unsafe.')
    expect(blocks.map((block) => block.kind)).toEqual(['think', 'paragraph'])
    expect(text(blocks[0]!)).toBe('Let me check line 10.')
  })

  it('treats an unterminated block as thinking, since streaming arrives mid-thought', () => {
    const blocks = parseMarkdown('<think>Still working through the')
    expect(blocks).toEqual([{ kind: 'think', text: 'Still working through the' }])
  })

  it('leaves the surrounding answer parsed as usual', () => {
    const blocks = parseMarkdown('Before.\n\n<think>x</think>\n\n- a bullet')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'think', 'list'])
  })
})

describe('blocks', () => {
  it('reads a fenced code block with its language', () => {
    const blocks = parseMarkdown('Fix it:\n\n```ts\nconst a = 1\nconst b = 2\n```\n')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.kind).toBe('paragraph')
    expect(blocks[1]).toEqual({ kind: 'code', language: 'ts', text: 'const a = 1\nconst b = 2' })
  })

  it('treats an unterminated fence as code — a streaming answer is always mid-block', () => {
    const blocks = parseMarkdown('```js\ndb.query(sql)')
    expect(blocks).toEqual([{ kind: 'code', language: 'js', text: 'db.query(sql)' }])
  })

  it('reads bullet lists, keeping nesting depth', () => {
    const blocks = parseMarkdown('- source: `req.query.id`\n- sink: `db.query`\n  - line 21\n')
    expect(blocks).toHaveLength(1)
    const list = blocks[0]!
    expect(list.kind === 'list' && list.ordered).toBe(false)
    expect(list.kind === 'list' && list.items.map((item) => item.depth)).toEqual([0, 0, 1])
  })

  it('reads numbered lists from their first number', () => {
    const blocks = parseMarkdown('2. second\n3. third\n')
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true, start: 2 })
  })

  it('folds a wrapped list item back into one item', () => {
    const blocks = parseMarkdown('- the value reaches\n  the sink unescaped\n')
    const list = blocks[0]!
    expect(list.kind === 'list' && list.items).toHaveLength(1)
    expect(text(list)).toBe('the value reaches the sink unescaped')
  })

  it('reads headings, quotes and rules', () => {
    const blocks = parseMarkdown('## Finding\n\n> untrusted\n\n---\n')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'quote', 'rule'])
    expect(blocks[0]).toMatchObject({ level: 2 })
  })

  it('reads `* * *` as a rule, not as a list', () => {
    expect(parseMarkdown('* * *').map((block) => block.kind)).toEqual(['rule'])
  })

  it('keeps a paragraph together and breaks it on a blank line', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree\n')
    expect(blocks.map(text)).toEqual(['one\ntwo', 'three'])
  })

  it('ends a paragraph where a list starts, with no blank line between', () => {
    const blocks = parseMarkdown('Two problems:\n- first\n- second\n')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'list'])
  })

  it('reads a table: header, alignment and rows', () => {
    const blocks = parseMarkdown(
      '| Kind | Where | Why |\n|:-----|:----:|----:|\n| source | `req.body` (a.ts 4) | HTTP body |\n| sink | `db.query` (a.ts 9) | SQL |\n',
    )
    expect(blocks).toHaveLength(1)
    const table = blocks[0]!
    expect(table.kind).toBe('table')
    if (table.kind !== 'table') return
    expect(table.align).toEqual(['left', 'center', 'right'])
    expect(table.header.map((cell) => cell[0]!.text)).toEqual(['Kind', 'Where', 'Why'])
    expect(table.rows).toHaveLength(2)
    // Cells carry inline markup, so a cited name is a code span, not asterisks and backticks.
    expect(table.rows[0]![1]![0]).toEqual({ kind: 'code', text: 'req.body' })
    expect(text(table)).toBe(
      'Kind | Where | Why\nsource | req.body (a.ts 4) | HTTP body\nsink | db.query (a.ts 9) | SQL',
    )
  })

  it('takes a table without outer pipes, and an escaped pipe inside a cell', () => {
    const blocks = parseMarkdown('a | b\n--|--\n`x \\| y` | 2\n')
    const table = blocks[0]!
    expect(table.kind).toBe('table')
    if (table.kind !== 'table') return
    expect(table.align).toEqual([null, null])
    expect(table.rows[0]![0]).toEqual([{ kind: 'code', text: 'x | y' }])
  })

  it('pads a short row and clips a long one to the header’s width', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n')
    const table = blocks[0]!
    if (table.kind !== 'table') throw new Error('not a table')
    expect(table.rows.map((row) => row.length)).toEqual([2, 2])
    expect(table.rows[0]![1]).toEqual([])
  })

  it('is a paragraph until the delimiter row arrives, then a table — streaming order', () => {
    expect(parseMarkdown('| a | b |').map((block) => block.kind)).toEqual(['paragraph'])
    expect(parseMarkdown('| a | b |\n|---|').map((block) => block.kind)).toEqual(['paragraph'])
    expect(parseMarkdown('| a | b |\n|---|---|').map((block) => block.kind)).toEqual(['table'])
  })

  it('ends a table on a blank line or another block, and starts one after a paragraph', () => {
    const blocks = parseMarkdown('Found these:\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.\n')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'table', 'paragraph'])
    const after = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n- item\n')
    expect(after.map((block) => block.kind)).toEqual(['table', 'list'])
  })

  it('does not read a paragraph over a rule as a table', () => {
    const blocks = parseMarkdown('a | b\n---\n')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'rule'])
  })

  it('produces nothing for empty text', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n')).toEqual([])
  })
})
