import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import puppeteer, { type Browser, type Page } from 'puppeteer'

const PORT = 5199
const URL = `http://localhost:${PORT}/`

let server: ViteDevServer
let browser: Browser
let page: Page
const pageErrors: string[] = []

/**
 * Click a real mouse click at an exact character, located by searching the buffer text. Monaco's
 * own coordinate mapping turns the offset into screen coordinates, so this stays accurate whatever
 * the font metrics are — unlike hunting through the rendered token spans.
 */
async function clickAt(needle: string, offsetInNeedle = 0, occurrence = 0): Promise<void> {
  const point = await page.evaluate(
    ({ needle, offsetInNeedle, occurrence }) => {
      const editor = (window as unknown as { __codeviewEditor?: any }).__codeviewEditor
      if (!editor) return null
      const model = editor.getModel()
      const text: string = model.getValue()

      let index = -1
      for (let i = 0; i <= occurrence; i++) {
        index = text.indexOf(needle, index + 1)
        if (index < 0) return null
      }

      const position = model.getPositionAt(index + offsetInNeedle)
      const visible = editor.getScrolledVisiblePosition(position)
      if (!visible) return null
      const rect = editor.getDomNode().getBoundingClientRect()
      return {
        x: rect.left + visible.left + 1,
        y: rect.top + visible.top + visible.height / 2,
      }
    },
    { needle, offsetInNeedle, occurrence },
  )
  expect(point, `"${needle}" #${occurrence} should be reachable in the editor`).not.toBeNull()
  await page.mouse.click(point!.x, point!.y)
  await new Promise((resolve) => setTimeout(resolve, 150))
}

const definitionText = () =>
  page.$eval('.definition', (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')

const selectedRow = () =>
  page.$eval('.row.selected', (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')

/** Text under each decoration class, read back out of the editor DOM. Monaco renders runs of
 *  spaces as non-breaking spaces, so normalise before comparing. */
const decorated = (className: string) =>
  page.$$eval(`.${className}`, (nodes) =>
    nodes.map((n) => (n.textContent ?? '').replace(/\u00a0/g, ' ')),
  )

beforeAll(async () => {
  server = await createServer({ server: { port: PORT }, logLevel: 'error' })
  await server.listen()

  browser = await puppeteer.launch({
    headless: true,
    // GitHub's runners can't use Chrome's sandbox; locally it stays on.
    args: process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  })
  page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1200 })
  page.on('pageerror', (error) =>
    pageErrors.push(error instanceof Error ? error.message : String(error)),
  )
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })

  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.row')
  await page.waitForSelector('.view-line')
})

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

describe('page load', () => {
  it('renders the tree and the editor without runtime errors', async () => {
    const rows = await page.$$eval('.row', (nodes) => nodes.length)
    expect(rows).toBeGreaterThan(3)
    expect(await page.$eval('.row', (el) => el.textContent)).toContain('SourceFile')
    expect(pageErrors).toEqual([])
  })

  it('reports a node count', async () => {
    expect(await page.$eval('footer', (el) => el.textContent)).toMatch(/\d+ nodes/)
  })
})

describe('editor drives the tree', () => {
  it('selects the AST node under the cursor', async () => {
    await clickAt('const config = {', 6)
    const row = await selectedRow()
    expect(row).toContain('Identifier')
    expect(row).toContain('config')
  })

  it('resolves a parameter rather than the shadowed outer const', async () => {
    // The `greeting` inside greet()'s body, where a parameter of the same name shadows the const.
    await clickAt('${greeting}, ', 2)
    expect(await definitionText()).toContain('parameter `greeting`')
    expect((await decorated('cv-def')).join('')).toBe('greeting: string')
  })

  it('highlights the whole declaration of a variable', async () => {
    await clickAt('} = config', 4)
    expect(await definitionText()).toContain('variable `config`')
    expect((await decorated('cv-def')).join('')).toContain('const config = {')
  })

  it('highlights a property and dims where the object was created', async () => {
    await clickAt('config.retries]', 7)
    expect(await definitionText()).toContain('property `retries`')
    expect((await decorated('cv-def')).join('')).toBe('retries: 3')
    expect((await decorated('cv-def-weak')).join('')).toContain('const config = {')
  })

  it('highlights only the first line of a function declaration', async () => {
    await clickAt('greet(greeting, {', 0)
    expect(await definitionText()).toContain('function `greet`')
    const highlighted = (await decorated('cv-def')).join('')
    expect(highlighted).toBe('function greet(greeting: string, target: { name: string })')
    expect(highlighted).not.toContain('return')
  })

  it('resolves an imported name to its import statement', async () => {
    await clickAt('formatAddress(host', 3)
    expect(await definitionText()).toContain('import `formatAddress`')
    expect((await decorated('cv-def')).join('')).toBe("import { formatAddress } from './format'")
  })

  it('resolves a class rather than its constructor', async () => {
    await clickAt('new Connection(', 4)
    expect(await definitionText()).toContain('class `Connection`')
    expect((await decorated('cv-def')).join('')).toBe('class Connection')
  })
})

describe('tree drives the editor', () => {
  it('selects the clicked node range in the editor', async () => {
    const clicked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.row')]
      const row = rows.find((r) => r.textContent?.includes('FunctionDeclaration'))
      if (!row) return null
      ;(row as HTMLElement).click()
      return row.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    })
    expect(clicked).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(await selectedRow()).toContain('FunctionDeclaration')
    expect((await decorated('cv-selected')).join('')).toContain('function greet(')
  })
})

describe('toolbar', () => {
  it('adds punctuation nodes when tokens are shown', async () => {
    const before = await page.$$eval('.row', (nodes) => nodes.length)
    await page.click('.toggle input')
    await new Promise((resolve) => setTimeout(resolve, 250))
    await page.click('.toolbar button')
    await new Promise((resolve) => setTimeout(resolve, 400))

    const kinds = await page.$$eval('.kind', (nodes) => nodes.map((n) => n.textContent))
    expect(kinds).toContain('OpenBraceToken')
    expect(kinds.length).toBeGreaterThan(before)

    await page.click('.toggle input')
    await new Promise((resolve) => setTimeout(resolve, 250))
  })

  it('filters the tree by kind', async () => {
    await page.type('.filter', 'ClassDeclaration')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const kinds = await page.$$eval('.kind', (nodes) => nodes.map((n) => n.textContent))
    expect(kinds).toContain('ClassDeclaration')
    expect(kinds).not.toContain('ImportDeclaration')
  })
})

describe('layout', () => {
  it('keeps the header inside the pane', async () => {
    const fits = await page.evaluate(() => {
      const pane = document.querySelector('.ast-pane')!.getBoundingClientRect()
      return ['.toolbar', '.status', '.crumbs', '.definition'].map((selector) => {
        const element = document.querySelector(selector)
        if (!element) return { selector, ok: true }
        const rect = element.getBoundingClientRect()
        return { selector, ok: rect.right <= pane.right + 1, right: rect.right, pane: pane.right }
      })
    })
    expect(fits.filter((entry) => !entry.ok)).toEqual([])
  })
})

describe('language switching', () => {
  it('keeps the buffer and re-applies highlights across the model swap', async () => {
    await clickAt('const config = {', 6)
    expect(await definitionText()).toContain('variable `config`')

    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.languages button')]
      ;(buttons.find((b) => b.textContent?.trim() === 'TSX') as HTMLElement).click()
    })
    await new Promise((resolve) => setTimeout(resolve, 500))

    const model = await page.evaluate(() => {
      const m = (window as unknown as { __codeviewEditor: any }).__codeviewEditor.getModel()
      return { uri: m.uri.toString(), lines: m.getLineCount() }
    })
    expect(model.uri).toContain('main.tsx')
    expect(model.lines).toBeGreaterThan(30)
    expect((await decorated('cv-def')).join('')).toContain('const config = {')

    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.languages button')]
      ;(buttons.find((b) => b.textContent?.trim() === 'TS') as HTMLElement).click()
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
})

describe('share links', () => {
  /** A fresh page so the suite's own editor state is left alone. */
  async function loadInNewPage(hash: string) {
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    await fresh.goto(`${URL}${hash}`, { waitUntil: 'networkidle0' })
    await fresh.waitForSelector('.view-line')
    await new Promise((resolve) => setTimeout(resolve, 600))
    const source = await fresh.$$eval('.view-line', (nodes) =>
      nodes.map((node) => (node.textContent ?? '').replace(/\u00a0/g, ' ')).join('\n'),
    )
    const kinds = await fresh.$$eval('.kind', (nodes) => nodes.map((node) => node.textContent))
    return { fresh, source, kinds }
  }

  it('loads a hand-written #src= fragment as plain source', async () => {
    const { fresh, source, kinds } = await loadInNewPage('#src=const%20answer%20%3D%2042&lang=ts')
    try {
      expect(source).toContain('const answer = 42')
      expect(kinds).toContain('VariableStatement')
    } finally {
      await fresh.close()
    }
  })

  it('round-trips the buffer through Copy link', async () => {
    // Clipboard access is denied in headless Chrome; the app catches that and still writes the
    // fragment, which is the part being tested here.
    await page.evaluate(() => {
      // '.actions button' would also match the language buttons nested in .languages.
      const button = [...document.querySelectorAll('.actions > button')].find(
        (candidate) => candidate.textContent?.trim() === 'Copy link',
      )
      ;(button as HTMLElement).click()
    })
    await new Promise((resolve) => setTimeout(resolve, 600))
    const hash = await page.evaluate(() => location.hash)
    expect(hash).toMatch(/^#src=z\./)

    const { fresh, source } = await loadInNewPage(hash)
    try {
      expect(source).toContain('import { formatAddress }')
      expect(source).toContain('const greeting = ')
    } finally {
      await fresh.close()
      await page.evaluate(() => history.replaceState(null, '', location.pathname))
    }
  })
})

describe('embedding parameters', () => {
  async function open(query: string) {
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    await fresh.goto(`${URL}${query}`, { waitUntil: 'networkidle0' })
    await fresh.waitForSelector('.view-line')
    await new Promise((resolve) => setTimeout(resolve, 600))
    return fresh
  }

  it('shows a filename above the editor', async () => {
    const fresh = await open('?filename=App.tsx')
    try {
      expect(await fresh.$eval('.file-name', (el) => el.textContent?.trim())).toBe('App.tsx')
      // The extension picks the language when no lang is given.
      expect(
        await fresh.$$eval('.languages button.active', (nodes) =>
          nodes.map((node) => node.textContent?.trim()),
        ),
      ).toEqual(['TSX'])
    } finally {
      await fresh.close()
    }
  })

  it('shows no filename bar when the parameter is absent', async () => {
    const fresh = await open('')
    try {
      expect(await fresh.$('.file-name')).toBeNull()
    } finally {
      await fresh.close()
    }
  })

  it('hides the header but keeps both panes working', async () => {
    const fresh = await open('?hideHeader')
    try {
      expect(await fresh.$('.app-bar')).toBeNull()
      expect(await fresh.$$eval('.row', (nodes) => nodes.length)).toBeGreaterThan(3)
      expect(await fresh.$$eval('.view-line', (nodes) => nodes.length)).toBeGreaterThan(10)
    } finally {
      await fresh.close()
    }
  })

  it('keeps the filename when the header is hidden', async () => {
    const fresh = await open('?hideHeader=1&filename=embedded.ts')
    try {
      expect(await fresh.$('.app-bar')).toBeNull()
      expect(await fresh.$eval('.file-name', (el) => el.textContent?.trim())).toBe('embedded.ts')
    } finally {
      await fresh.close()
    }
  })

  it('carries the filename through Copy link', async () => {
    const fresh = await open('?filename=src/App.tsx')
    try {
      await fresh.evaluate(() => {
        const button = [...document.querySelectorAll('.actions > button')].find(
          (candidate) => candidate.textContent?.trim() === 'Copy link',
        )
        ;(button as HTMLElement).click()
      })
      await new Promise((resolve) => setTimeout(resolve, 700))

      const hash = await fresh.evaluate(() => location.hash)
      expect(hash).toContain('filename=src%2FApp.tsx')
      expect(hash).toContain('lang=tsx')

      const recipient = await open(hash)
      try {
        expect(await recipient.$eval('.file-name', (el) => el.textContent?.trim())).toBe(
          'src/App.tsx',
        )
      } finally {
        await recipient.close()
      }
    } finally {
      await fresh.close()
    }
  })

  it('takes the parameters from the fragment too', async () => {
    const fresh = await open('#hideHeader&filename=fragment.jsx')
    try {
      expect(await fresh.$('.app-bar')).toBeNull()
      expect(await fresh.$eval('.file-name', (el) => el.textContent?.trim())).toBe('fragment.jsx')
    } finally {
      await fresh.close()
    }
  })

  it('leaves the header alone when the flag is switched off', async () => {
    const fresh = await open('?hideHeader=false')
    try {
      expect(await fresh.$('.app-bar')).not.toBeNull()
    } finally {
      await fresh.close()
    }
  })
})

describe('runtime health', () => {
  it('reports no TypeScript errors on the sample', async () => {
    // Monaco keys its worker off the URI extension; an extensionless one flags valid TS as broken.
    const squiggles = await page.$$eval('.squiggly-error', (nodes) => nodes.length)
    expect(squiggles).toBe(0)
  })

  it('logged no errors across the whole session', () => {
    expect(pageErrors).toEqual([])
  })
})
