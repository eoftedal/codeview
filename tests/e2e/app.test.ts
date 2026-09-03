import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
async function clickAt(
  needle: string,
  offsetInNeedle = 0,
  occurrence = 0,
  target: Page = page,
): Promise<void> {
  const point = await target.evaluate(
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
  await target.mouse.click(point!.x, point!.y)
  await new Promise((resolve) => setTimeout(resolve, 150))
}

const definitionText = () =>
  page.$eval('.definition', (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')

const selectedRow = () =>
  page.$eval('.row.selected', (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')

/** Text under each decoration class, read back out of the editor DOM. Monaco renders runs of
 *  spaces as non-breaking spaces, so normalise before comparing. */
const decorated = (className: string, target: Page = page) =>
  target.$$eval(`.${className}`, (nodes) =>
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
    // The URI is keyed by file id, but its extension still has to follow the language.
    expect(model.uri).toMatch(/\.tsx$/)
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

  it('names the sample itself when the parameter is absent', async () => {
    const fresh = await open('')
    try {
      // Every tab needs a name, so the seed buffer arrives under one.
      expect(await fresh.$eval('.file-name', (el) => el.textContent?.trim())).toBe('example.ts')
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

  it('carries every open tab through Copy link, and opens them again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeview-'))
    const context = await browser.createBrowserContext()
    const fresh = await context.newPage()
    try {
      await fresh.setViewport({ width: 1400, height: 1000 })
      await fresh.goto(URL, { waitUntil: 'networkidle0' })
      await fresh.waitForSelector('.view-line')
      await new Promise((resolve) => setTimeout(resolve, 500))

      const store = join(directory, 'store.ts')
      const handler = join(directory, 'handler.ts')
      writeFileSync(store, "export const rows = ['a', 'b']\n")
      writeFileSync(handler, "import { rows } from './store'\nexport const first = rows[0]\n")
      const input = (await fresh.$('input[type=file]'))!
      await input.uploadFile(store, handler)
      await new Promise((resolve) => setTimeout(resolve, 900))

      await fresh.evaluate(() => {
        const button = [...document.querySelectorAll('.actions > button')].find(
          (candidate) => candidate.textContent?.trim() === 'Copy link',
        )
        ;(button as HTMLElement).click()
      })
      await new Promise((resolve) => setTimeout(resolve, 800))

      const hash = await fresh.evaluate(() => location.hash)
      // Deflated, and it names the tab that was on screen.
      expect(hash).toMatch(/^#files=z\./)
      expect(hash).toContain('active=handler.ts')

      const recipient = await context.newPage()
      try {
        await recipient.goto(`${URL}${hash}`, { waitUntil: 'networkidle0' })
        await recipient.waitForSelector('.view-line')
        await new Promise((resolve) => setTimeout(resolve, 900))

        // Their tabs, their names, and the one they were looking at — not the reader's own strip.
        expect(
          await recipient.$$eval('.tab .file-name', (nodes) =>
            nodes.map((node) => node.textContent?.trim()),
          ),
          // Every tab, the sample the page opened with included.
        ).toEqual(['example.ts', 'store.ts', 'handler.ts'])
        expect(
          await recipient.$eval('.tab.active .file-name', (el) => el.textContent?.trim()),
        ).toBe('handler.ts')

        const source = await recipient.$$eval('.view-line', (nodes) =>
          nodes.map((node) => (node.textContent ?? '').replace(/\u00a0/g, ' ')).join('\n'),
        )
        expect(source).toContain("import { rows } from './store'")
      } finally {
        await recipient.close()
      }
    } finally {
      await context.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('opens a hand-written multi-file fragment, uncompressed', async () => {
    const payload = encodeURIComponent(
      "--8<-- a.ts\nexport const a = 1\n--8<-- b.ts\nimport { a } from './a'\nexport const b = a\n",
    )
    const fresh = await open(`#files=${payload}&active=b.ts`)
    try {
      expect(
        await fresh.$$eval('.tab .file-name', (nodes) =>
          nodes.map((node) => node.textContent?.trim()),
        ),
      ).toEqual(['a.ts', 'b.ts'])
      expect(await fresh.$eval('.tab.active .file-name', (el) => el.textContent?.trim())).toBe(
        'b.ts',
      )
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

describe('flow trace', () => {
  const traceRows = () =>
    page.$$eval('.trace-pane .row', (nodes) =>
      nodes.map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim()),
    )

  const openTraceTab = async () => {
    const tabs = await page.$$('.tabs button')
    await tabs[1]!.click()
    await page.waitForSelector('.trace-pane')
  }

  it('walks a value back through an imported call to its sources', async () => {
    // `address` is built from formatAddress(host, port ?? defaults.port) — an imported function,
    // so the result originates outside the buffer while the arguments still trace back inside it.
    await clickAt('address = formatAddress', 2)
    await openTraceTab()
    await page.click('.trace-pane .run')
    await new Promise((resolve) => setTimeout(resolve, 150))

    const rows = await traceRows()
    expect(rows[0]).toContain('variable `address`')
    expect(rows.join(' ')).toContain('formatAddress(host, port')
    // The import is a terminal the walk cannot see past.
    expect(rows.some((row) => row.includes('another module'))).toBe(true)
    // ...but the arguments still reach the object literal `host` was destructured from.
    expect(rows.some((row) => row.includes("'localhost'"))).toBe(true)
  })

  it('marks external origins in the editor and counts them on the tab', async () => {
    expect((await decorated('cv-flow-external')).length).toBeGreaterThan(0)
    expect((await decorated('cv-flow')).length).toBeGreaterThan(0)
    const badge = await page.$eval('.tabs .badge', (el) => el.textContent?.trim())
    expect(Number(badge)).toBeGreaterThan(0)
  })

  it('selects a step when its row is clicked', async () => {
    const rows = await page.$$('.trace-pane .row')
    await rows[1]!.click()
    expect(await page.$eval('.trace-pane .row.selected', (el) => el.textContent)).toBeTruthy()
  })

  it('ends at a constant when nothing external feeds the value', async () => {
    await clickAt('const greeting', 8)
    await page.click('.trace-pane .run')
    await new Promise((resolve) => setTimeout(resolve, 150))

    const rows = await traceRows()
    expect(rows[0]).toContain('variable `greeting`')
    expect(rows.some((row) => row.includes('defined here'))).toBe(true)
    expect(await page.$('.tabs .badge')).toBeNull()
  })

  it('traces from the editor keybinding, leaving Monaco’s own gestures alone', async () => {
    const tabs = await page.$$('.tabs button')
    await tabs[0]!.click()

    // Occurrence 1: the sample mentions `config.retries` in a comment first.
    await clickAt('config.retries', 9, 1)
    await page.keyboard.down('Alt')
    await page.keyboard.press('KeyT')
    await page.keyboard.up('Alt')
    await page.waitForSelector('.trace-pane')
    await new Promise((resolve) => setTimeout(resolve, 150))

    const rows = await traceRows()
    expect(rows[0]).toContain('`retries`')
    // A click modifier would have opened Monaco's definition peek over the editor instead.
    expect(await page.$('.monaco-editor .peekview-widget')).toBeNull()
  })

  it('drops the trace when the buffer changes, since every span has shifted', async () => {
    await page.click('.trace-pane .run')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await traceRows()).length).toBeGreaterThan(0)

    await clickAt('const greeting', 0)
    await page.keyboard.type('\n')
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(await traceRows()).toEqual([])
    expect(await page.$eval('.trace-pane .empty', (el) => el.textContent)).toContain('Trace')
  })
})

describe('the chat pane picks a model honestly', () => {
  /** A page with whatever models we say the browser has. The chat pane settles this once, on the
   *  first look at the tab, so each case needs its own page rather than a reload. */
  async function chatPageWith(setup: () => void) {
    const fresh = await browser.newPage()
    await fresh.evaluateOnNewDocument(setup)
    await fresh.goto(URL, { waitUntil: 'networkidle0' })
    await fresh.waitForSelector('.row')
    const tabs = await fresh.$$('.tabs button')
    await tabs[2]!.click()
    await fresh.waitForSelector('.chat-pane')
    // The GPU probe is async, and what the pane offers depends on how it lands.
    await new Promise((resolve) => setTimeout(resolve, 400))
    return fresh
  }

  it('says only that nothing is available when the browser can run neither', async () => {
    const fresh = await chatPageWith(() => {
      delete (window as unknown as { LanguageModel?: unknown }).LanguageModel
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => null },
        configurable: true,
      })
    })
    try {
      expect(await fresh.$eval('.chat-pane', (el) => el.textContent?.trim())).toBe(
        'No language model is available in this browser.',
      )
      expect(await fresh.$('.model')).toBeNull()
    } finally {
      await fresh.close()
    }
  })

  it('drops the downloadable models when WebGPU hands back no adapter', async () => {
    const fresh = await chatPageWith(function () {
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async () => ({
          promptStreaming: () => new ReadableStream({ start: (c) => c.close() }),
          destroy: () => {},
        }),
      }
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => null },
        configurable: true,
      })
    })
    try {
      const options = await fresh.$$eval('.model option', (nodes) =>
        nodes.map((node) => node.textContent?.trim()),
      )
      expect(options).toEqual(['Browser built-in · no download'])
    } finally {
      await fresh.close()
    }
  })

  it('offers the whole catalogue on a GPU, with the browser’s own model as the default', async () => {
    const fresh = await chatPageWith(function () {
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async () => ({
          promptStreaming: () => new ReadableStream({ start: (c) => c.close() }),
          destroy: () => {},
        }),
      }
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
    })
    try {
      const options = await fresh.$$eval('.model option', (nodes) =>
        nodes.map((node) => node.textContent?.trim()),
      )
      expect(options[0]).toBe('Browser built-in · no download')
      expect(options).toContain('Qwen2.5-Coder 1.5B · ~1.6 GB')
      expect(options).toContain('Qwen3.5 4B · ~3.9 GB')
      // The one with nothing to download is what a first visit lands on.
      expect(await fresh.$eval('.model', (el) => (el as HTMLSelectElement).value)).toBe('builtin')
    } finally {
      await fresh.close()
    }
  })

  it('offers thinking only on a model that has it, and off by default', async () => {
    const fresh = await chatPageWith(function () {
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async () => ({
          promptStreaming: () => new ReadableStream({ start: (c) => c.close() }),
          destroy: () => {},
        }),
      }
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
    })
    try {
      // The browser's own model has no thinking mode, so there is nothing to offer.
      expect(await fresh.$('.reason')).toBeNull()

      // Selecting only changes the choice; the weights are not fetched until a question is asked.
      await fresh.select('.model', 'qwen3.5-2b')
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(await fresh.$('.reason')).not.toBeNull()
      expect(await fresh.$eval('.reason input', (el) => (el as HTMLInputElement).checked)).toBe(
        false,
      )
    } finally {
      await fresh.close()
    }
  })
})

describe('file tabs', () => {
  /** A page with an empty localStorage, so the strip starts at exactly one tab. */
  async function tabsPage(): Promise<Page> {
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    await fresh.evaluateOnNewDocument(() => localStorage.clear())
    await fresh.goto(URL, { waitUntil: 'networkidle0' })
    await fresh.waitForSelector('.view-line')
    await new Promise((resolve) => setTimeout(resolve, 500))
    return fresh
  }

  const tabNames = (target: Page) =>
    target.$$eval('.tab .file-name', (nodes) => nodes.map((node) => node.textContent?.trim()))

  it('opens with one tab, which has no close button', async () => {
    const fresh = await tabsPage()
    try {
      expect(await tabNames(fresh)).toEqual(['example.ts'])
      // Closing the last tab would leave no buffer, so it is not offered.
      expect(await fresh.$('.tab .close')).toBeNull()
    } finally {
      await fresh.close()
    }
  })

  it('adds a blank file, keeps the other one, and closes it again', async () => {
    const fresh = await tabsPage()
    try {
      await fresh.click('.file-tabs .add')
      await new Promise((resolve) => setTimeout(resolve, 400))

      expect(await tabNames(fresh)).toEqual(['example.ts', 'untitled-1.ts'])
      expect(await fresh.$eval('.tab.active .file-name', (el) => el.textContent?.trim())).toBe(
        'untitled-1.ts',
      )
      // A new file is blank, and the tree is the empty source file it parses to.
      const blank = await fresh.$$eval('.view-line', (nodes) =>
        nodes.map((node) => (node.textContent ?? '').replace(/\u00a0/g, ' ').trim()).join(''),
      )
      expect(blank).toBe('')
      expect(await fresh.$eval('.row', (el) => el.textContent)).toContain('SourceFile')

      const tabs = await fresh.$$('.tab')
      await tabs[0]!.click()
      await new Promise((resolve) => setTimeout(resolve, 500))
      // The sample was waiting where it was left, not thrown away by the trip to the other tab.
      expect(await fresh.$$eval('.row', (nodes) => nodes.length)).toBeGreaterThan(3)
      expect(await fresh.$eval('.tab.active .file-name', (el) => el.textContent?.trim())).toBe(
        'example.ts',
      )

      const closers = await fresh.$$('.tab .close')
      await closers[1]!.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await tabNames(fresh)).toEqual(['example.ts'])
    } finally {
      await fresh.close()
    }
  })

  it('renames from the tab’s own context menu, and follows the extension', async () => {
    const fresh = await tabsPage()
    try {
      const tab = (await fresh.$('.tab'))!
      const box = (await tab.boundingBox())!
      await fresh.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' })
      await fresh.waitForSelector('.file-tabs .menu')

      // The first item is Rename.
      await fresh.click('.file-tabs .menu button')
      await fresh.waitForSelector('.tab .rename')
      // Only the stem starts out selected, so the extension survives being typed over.
      await fresh.keyboard.type('Widget')
      await fresh.keyboard.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await tabNames(fresh)).toEqual(['Widget.ts'])

      await fresh.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' })
      await fresh.waitForSelector('.file-tabs .menu')
      await fresh.click('.file-tabs .menu button')
      await fresh.waitForSelector('.tab .rename')
      // Past the selected stem, then over the extension itself.
      await fresh.keyboard.press('End')
      for (let i = 0; i < 3; i++) await fresh.keyboard.press('Backspace')
      await fresh.keyboard.type('.jsx')
      await fresh.keyboard.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(await tabNames(fresh)).toEqual(['Widget.jsx'])
      // A new extension is a new language, the same as it is for an opened file.
      expect(await fresh.$eval('.tab.active .badge', (el) => el.textContent?.trim())).toBe('JSX')
      expect(
        await fresh.$$eval('.languages button.active', (nodes) =>
          nodes.map((node) => node.textContent?.trim()),
        ),
      ).toEqual(['JSX'])
    } finally {
      await fresh.close()
    }
  })

  it('remembers every file, its name and the one that was showing', async () => {
    // Its own storage partition: `tabsPage` clears on every navigation, which a reload would
    // undo the point of.
    const context = await browser.createBrowserContext()
    const fresh = await context.newPage()
    try {
      await fresh.setViewport({ width: 1400, height: 1000 })
      await fresh.goto(URL, { waitUntil: 'networkidle0' })
      await fresh.waitForSelector('.view-line')
      await new Promise((resolve) => setTimeout(resolve, 500))

      await fresh.click('.file-tabs .add')
      await new Promise((resolve) => setTimeout(resolve, 300))
      const tab = (await fresh.$$('.tab'))[1]!
      const box = (await tab.boundingBox())!
      await fresh.mouse.click(box.x + 25, box.y + box.height / 2, { button: 'right' })
      await fresh.waitForSelector('.file-tabs .menu')
      await fresh.click('.file-tabs .menu button')
      await fresh.waitForSelector('.tab .rename')
      await fresh.keyboard.type('service')
      await fresh.keyboard.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 300))
      await fresh.click('.editor')
      await fresh.keyboard.type('const secret = 42')
      // Past the save debounce.
      await new Promise((resolve) => setTimeout(resolve, 900))

      await fresh.reload({ waitUntil: 'networkidle0' })
      await fresh.waitForSelector('.view-line')
      await new Promise((resolve) => setTimeout(resolve, 700))

      expect(await tabNames(fresh)).toEqual(['example.ts', 'service.ts'])
      expect(await fresh.$eval('.tab.active .file-name', (el) => el.textContent?.trim())).toBe(
        'service.ts',
      )
      const source = await fresh.$$eval('.view-line', (nodes) =>
        nodes.map((node) => (node.textContent ?? '').replace(/\u00a0/g, ' ')).join('\n'),
      )
      expect(source).toContain('const secret = 42')
    } finally {
      await context.close()
    }
  })

  it('opens several picked files at once, under their own names', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeview-'))
    const fresh = await tabsPage()
    try {
      const first = join(directory, 'alpha.ts')
      const second = join(directory, 'beta.jsx')
      writeFileSync(first, 'export const alpha = 1\n')
      writeFileSync(second, 'export const beta = <p>hi</p>\n')

      const input = (await fresh.$('input[type=file]'))!
      await input.uploadFile(first, second)
      await new Promise((resolve) => setTimeout(resolve, 700))

      expect(await tabNames(fresh)).toEqual(['example.ts', 'alpha.ts', 'beta.jsx'])
      // The last one picked is the one you land on.
      expect(await fresh.$eval('.tab.active .file-name', (el) => el.textContent?.trim())).toBe(
        'beta.jsx',
      )
      const source = await fresh.$$eval('.view-line', (nodes) =>
        nodes.map((node) => (node.textContent ?? '').replace(/\u00a0/g, ' ')).join('\n'),
      )
      expect(source).toContain('const beta = <p>hi</p>')
    } finally {
      await fresh.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('a trace that leaves the file', () => {
  const HANDLER = `import { getProduct } from './store'

app.get('/product/:id', (req) => {
  const row = getProduct(req.params.id)
  return row
})
`
  const STORE = `export function getProduct(productId) {
  const query = \`SELECT * FROM Products WHERE id = \${productId}\`
  return run(query)
}
`

  const traceRows = (target: Page) =>
    target.$$eval('.trace-pane .row', (nodes) =>
      nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()),
    )

  it('walks into the imported tab, labels the steps, and opens the tab on a click', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeview-'))
    const context = await browser.createBrowserContext()
    const fresh = await context.newPage()
    try {
      await fresh.setViewport({ width: 1500, height: 1000 })
      await fresh.goto(URL, { waitUntil: 'networkidle0' })
      await fresh.waitForSelector('.view-line')
      await new Promise((resolve) => setTimeout(resolve, 500))

      const store = join(directory, 'store.ts')
      const handler = join(directory, 'handler.ts')
      writeFileSync(store, STORE)
      writeFileSync(handler, HANDLER)
      const input = (await fresh.$('input[type=file]'))!
      // handler.ts last, so it is the tab on screen.
      await input.uploadFile(store, handler)
      await new Promise((resolve) => setTimeout(resolve, 900))
      expect(await fresh.$eval('.tab.active .file-name', (el) => el.textContent?.trim())).toBe(
        'handler.ts',
      )

      await clickAt('return row', 8, 0, fresh)
      await fresh.keyboard.down('Alt')
      await fresh.keyboard.press('KeyT')
      await fresh.keyboard.up('Alt')
      await fresh.waitForSelector('.trace-pane')
      await new Promise((resolve) => setTimeout(resolve, 250))

      const rows = await traceRows(fresh)
      // The query is built in the other tab, and the walk reached it.
      expect(rows.join(' ')).toContain('SELECT * FROM Products')
      // ...then came back out of it, to the request field at the call site.
      expect(rows.join(' ')).toContain('req.params')
      expect(rows.some((row) => row.includes('store.ts:'))).toBe(true)
      expect(await fresh.$eval('.trace-pane .across', (el) => el.textContent?.trim())).toBe(
        '2 files',
      )

      // Only the steps in the tab on screen are decorated: a span means nothing in another file.
      // Monaco splits a decorated range across token spans, so compare the joined text.
      const flow = (await decorated('cv-flow', fresh)).join('')
      expect(flow).toContain('req.params.id')
      expect(flow).not.toContain('SELECT')

      const clicked = await fresh.evaluate(() => {
        const row = [...document.querySelectorAll('.trace-pane .row')].find((node) =>
          (node.textContent ?? '').includes('SELECT * FROM Products'),
        )
        if (!row) return false
        ;(row as HTMLElement).click()
        return true
      })
      expect(clicked).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 700))

      // The step's own tab is opened, and the trace survives the switch — nothing was edited.
      expect(await fresh.$eval('.tab.active .file-name', (el) => el.textContent?.trim())).toBe(
        'store.ts',
      )
      expect((await traceRows(fresh)).length).toBeGreaterThan(0)
      expect((await decorated('cv-flow', fresh)).join('')).toContain('SELECT')
    } finally {
      await context.close()
      rmSync(directory, { recursive: true, force: true })
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
