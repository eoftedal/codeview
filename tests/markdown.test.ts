import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, type Block } from '../src/lib/markdown'

/** The rendered text of a block, with the markers the parser consumed put back. */
function text(block: Block): string {
  if (block.kind === 'code') return block.text
  if (block.kind === 'rule') return '---'
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

  it('takes only http(s) links, so a href can never be script', () => {
    expect(parseInline('[owasp](https://owasp.org)')).toEqual([
      { kind: 'link', text: 'owasp', href: 'https://owasp.org' },
    ])
    expect(parseInline('[x](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[x](javascript:alert(1))' },
    ])
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

  it('produces nothing for empty text', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n')).toEqual([])
  })
})
