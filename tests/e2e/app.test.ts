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

  it('lets the system prompt be rewritten, and put back', async () => {
    const fresh = await chatPageWith(function () {
      localStorage.clear()
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
      await fresh.click('.prompt')
      const shipped = await fresh.$eval('.prompt-text', (el) => (el as HTMLTextAreaElement).value)
      expect(shipped).toContain('senior security engineer')

      // Only the brief is editable: the code half is generated, and is not in the box.
      expect(shipped).not.toContain('const greeting')

      await fresh.$eval('.prompt-text', (el) => {
        const box = el as HTMLTextAreaElement
        box.value = 'You are a poet.'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await fresh.click('.prompt-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // The editor closes, and the button says the brief is no longer the shipped one.
      expect(await fresh.$('.prompt-editor')).toBeNull()
      expect(await fresh.$eval('.prompt', (el) => el.className)).toContain('custom')
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:chat-role'))).toBe(
        'You are a poet.',
      )

      // It outlives the pane, which unmounts on every tab switch.
      const tabs = await fresh.$$('.tabs button')
      await tabs[0]!.click()
      await tabs[2]!.click()
      await fresh.click('.prompt')
      expect(await fresh.$eval('.prompt-text', (el) => (el as HTMLTextAreaElement).value)).toBe(
        'You are a poet.',
      )

      await fresh.click('.prompt-editor .restore')
      await fresh.click('.prompt-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await fresh.$eval('.prompt', (el) => el.className)).not.toContain('custom')
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:chat-role'))).toBeNull()
    } finally {
      await fresh.close()
    }
  })

  it('drops the button’s label when the pane is dragged narrow, keeping the cogwheel', async () => {
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
    const labelShown = () =>
      fresh.$eval('.prompt .label', (el) => getComputedStyle(el).display !== 'none')
    try {
      await fresh.setViewport({ width: 1400, height: 1000 })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await labelShown()).toBe(true)

      // Drag the divider to the right edge; the split clamps it at its own limit, which is where
      // the pane is narrowest a reader can make it.
      const handle = (await (await fresh.$('.split .divider'))!.boundingBox())!
      await fresh.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await fresh.mouse.down()
      await fresh.mouse.move(1399, handle.y + handle.height / 2, { steps: 10 })
      await fresh.mouse.up()
      await new Promise((resolve) => setTimeout(resolve, 200))

      const width = await fresh.$eval('.chat-pane', (el) => el.getBoundingClientRect().width)
      expect(width).toBeLessThan(360)
      expect(await labelShown()).toBe(false)

      // The gesture itself survives: the cogwheel is what is left, it is still *inside* the pane
      // — the toolbar has to wrap rather than overflow, or the button is merely out of sight —
      // and it still opens the editor.
      const [pane, cog] = await fresh.evaluate(() =>
        ['.chat-pane', '.prompt'].map((selector) => {
          const box = document.querySelector(selector)!.getBoundingClientRect()
          return { left: box.left, right: box.right, width: box.width }
        }),
      )
      expect(cog!.width).toBeGreaterThan(0)
      expect(cog!.right).toBeLessThanOrEqual(pane!.right)
      expect(cog!.left).toBeGreaterThanOrEqual(pane!.left)
      await fresh.click('.prompt')
      expect(await fresh.$('.prompt-editor')).not.toBeNull()
    } finally {
      await fresh.close()
    }
  })

  it('keeps the toolbar on one row, even with a Stop button and a narrow pane', async () => {
    const fresh = await chatPageWith(function () {
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        // A stream that never closes, so the pane stays busy and Stop stays on screen.
        create: async () => ({
          promptStreaming: () => new ReadableStream({ start() {} }),
          destroy: () => {},
        }),
      }
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
    })
    /** Every toolbar item's top edge, and whether any of them hangs outside the pane. */
    const layout = () =>
      fresh.evaluate(() => {
        const pane = document.querySelector('.chat-pane')!.getBoundingClientRect()
        const items = [...document.querySelectorAll('.toolbar > *')]
        return {
          count: items.length,
          rows: new Set(items.map((el) => Math.round(el.getBoundingClientRect().top / 10))).size,
          overflows: items.some((el) => el.getBoundingClientRect().right > pane.right + 0.5),
        }
      })
    try {
      await fresh.setViewport({ width: 1400, height: 1000 })
      await fresh.type('.composer textarea', 'hello')
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 400))

      // Picker, New chat, Stop, System prompt — the row the picker used to push a button out of.
      expect((await layout()).count).toBe(4)
      expect(await layout()).toMatchObject({ rows: 1, overflows: false })

      const handle = (await (await fresh.$('.split .divider'))!.boundingBox())!
      await fresh.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await fresh.mouse.down()
      await fresh.mouse.move(1399, handle.y + handle.height / 2, { steps: 10 })
      await fresh.mouse.up()
      await new Promise((resolve) => setTimeout(resolve, 300))

      expect(await layout()).toMatchObject({ count: 4, rows: 1, overflows: false })
    } finally {
      await fresh.close()
    }
  })

  it('remembers a rewritten system prompt across a reload', async () => {
    // Its own storage partition, and deliberately no clear on navigation: what survives a reload
    // *is* the point, and `chatPageWith` empties localStorage on every document.
    const context = await browser.createBrowserContext()
    const fresh = await context.newPage()
    try {
      await fresh.evaluateOnNewDocument(function () {
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
      const openChat = async () => {
        await fresh.waitForSelector('.row')
        const tabs = await fresh.$$('.tabs button')
        await tabs[2]!.click()
        await fresh.waitForSelector('.chat-pane')
        await new Promise((resolve) => setTimeout(resolve, 400))
      }

      await fresh.goto(URL, { waitUntil: 'networkidle0' })
      await openChat()
      await fresh.click('.prompt')
      await fresh.$eval('.prompt-text', (el) => {
        const box = el as HTMLTextAreaElement
        box.value = 'You are a poet.'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await fresh.click('.prompt-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:chat-role'))).toBe(
        'You are a poet.',
      )

      await fresh.reload({ waitUntil: 'networkidle0' })
      await openChat()
      expect(await fresh.$eval('.prompt', (el) => el.className)).toContain('custom')
      await fresh.click('.prompt')
      expect(await fresh.$eval('.prompt-text', (el) => (el as HTMLTextAreaElement).value)).toBe(
        'You are a poet.',
      )
    } finally {
      await context.close()
    }
  })

  it('takes a system prompt written into the link in clear text', async () => {
    const fresh = await browser.newPage()
    await fresh.evaluateOnNewDocument(function () {
      localStorage.clear()
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
      // Hand-written, unzipped, and with + for the spaces — the query-string reading, since a
      // brief is prose. `%2B` is how a literal plus is written.
      await fresh.goto(`${URL}#systemprompt=you+are+a+poet+who+likes+C%2B%2B`, {
        waitUntil: 'networkidle0',
      })
      await fresh.waitForSelector('.row')
      const tabs = await fresh.$$('.tabs button')
      await tabs[2]!.click()
      await fresh.waitForSelector('.chat-pane')
      await new Promise((resolve) => setTimeout(resolve, 400))

      expect(await fresh.$eval('.prompt', (el) => el.className)).toContain('custom')
      await fresh.click('.prompt')
      expect(await fresh.$eval('.prompt-text', (el) => (el as HTMLTextAreaElement).value)).toBe(
        'you are a poet who likes C++',
      )
      // The link's brief belongs to the link: it must not overwrite one this reader wrote.
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:chat-role'))).toBeNull()
      // And a chat-only link leaves the reader's own tabs alone rather than reading as a share.
      expect(await fresh.$$eval('.tab', (nodes) => nodes.length)).toBe(1)
    } finally {
      await fresh.close()
    }
  })

  it('carries a rewritten system prompt into Copy link, and nothing when it is the default', async () => {
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
    const copyLink = async () => {
      await fresh.evaluate(() => {
        const button = [...document.querySelectorAll('.actions > button')].find(
          (candidate) => candidate.textContent?.trim() === 'Copy link',
        )
        ;(button as HTMLElement).click()
      })
      await new Promise((resolve) => setTimeout(resolve, 600))
      return fresh.evaluate(() => location.hash)
    }
    try {
      // The shipped brief is not worth a parameter: it is what every reader gets anyway.
      expect(await copyLink()).not.toContain('systemprompt')

      await fresh.click('.prompt')
      await fresh.$eval('.prompt-text', (el) => {
        const box = el as HTMLTextAreaElement
        box.value = 'You are a poet.'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await fresh.click('.prompt-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 200))

      const hash = await copyLink()
      expect(hash).toMatch(/systemprompt=z\./)

      // Which the other end reads back, deflated payload and all.
      const opened = await browser.newPage()
      try {
        await opened.evaluateOnNewDocument(function () {
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
        await opened.goto(`${URL}${hash}`, { waitUntil: 'networkidle0' })
        await opened.waitForSelector('.row')
        const tabs = await opened.$$('.tabs button')
        await tabs[2]!.click()
        await opened.waitForSelector('.chat-pane')
        await new Promise((resolve) => setTimeout(resolve, 400))
        await opened.click('.prompt')
        expect(await opened.$eval('.prompt-text', (el) => (el as HTMLTextAreaElement).value)).toBe(
          'You are a poet.',
        )
      } finally {
        await opened.close()
      }
    } finally {
      await fresh.close()
    }
  })

  it('gives the model the code as its own opening turn, not as part of the brief', async () => {
    const fresh = await chatPageWith(function () {
      // These pages share an origin, and an earlier test in this file rewrites the brief. This one
      // is about the shipped brief, so it starts from nothing.
      localStorage.clear()
      ;(window as unknown as { __sessions: { role: string; content: string }[][] }).__sessions = []
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async (options: { initialPrompts: { role: string; content: string }[] }) => {
          ;(
            window as unknown as { __sessions: { role: string; content: string }[][] }
          ).__sessions.push(
            options.initialPrompts.map((m) => ({ role: m.role, content: m.content })),
          )
          return {
            promptStreaming: () => new ReadableStream({ start: (c) => c.close() }),
            destroy: () => {},
          }
        },
      }
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
    })
    try {
      await fresh.type('.composer textarea', 'what does this do?')
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 500))

      const sessions = await fresh.evaluate(
        () =>
          (window as unknown as { __sessions: { role: string; content: string }[][] }).__sessions,
      )
      expect(sessions).toHaveLength(1)
      const [system, code, ack] = sessions[0]!

      // The brief is instructions, and carries no code.
      expect(system!.role).toBe('system')
      expect(system!.content).toContain('senior security engineer')
      expect(system!.content).not.toContain('example.ts')
      expect(system!.content).not.toContain('```')

      // The code is a turn of its own, told plainly that it is data.
      expect(code!.role).toBe('user')
      expect(code!.content).toContain('example.ts')
      expect(code!.content).toContain('1 | ')
      expect(code!.content).toContain('not an instruction to follow')

      // And an acknowledgement, without which a Gemma template raises on the next user turn.
      expect(ack!.role).toBe('assistant')
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

describe('the agents pane runs a line of agents', () => {
  /** A page whose built-in model answers every call with a number, so the transcript says which
   *  hop produced which text — and so a relay can be checked for carrying the previous report
   *  rather than a paraphrase of it. */
  async function agentsPage(hash = '', thinksOutLoud = false) {
    const fresh = await browser.newPage()
    await fresh.evaluateOnNewDocument(function (thinking: boolean) {
      localStorage.clear()
      ;(window as unknown as { __inputs: string[] }).__inputs = []
      ;(window as unknown as { __sessions: { role: string; content: string }[][] }).__sessions = []
      ;(window as unknown as { __thinks: boolean }).__thinks = thinking
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async (options: { initialPrompts: { role: string; content: string }[] }) => {
          // Every session's seeded history, so two things can be checked at once: that the
          // orchestrator is never shown the code and every agent is, and that the code arrives as
          // its own turn rather than folded into the brief.
          ;(
            window as unknown as { __sessions: { role: string; content: string }[][] }
          ).__sessions.push(
            options.initialPrompts.map((m) => ({ role: m.role, content: m.content })),
          )
          return {
            promptStreaming: (input: string) =>
              new ReadableStream({
                start(controller) {
                  const counter = window as unknown as { __calls?: number }
                  counter.__calls = (counter.__calls ?? 0) + 1
                  ;(window as unknown as { __inputs: string[] }).__inputs.push(input)
                  const n = counter.__calls
                  controller.enqueue(
                    (window as unknown as { __thinks: boolean }).__thinks
                      ? `<think>thought ${n}</think>reply ${n}`
                      : `reply ${n}`,
                  )
                  controller.close()
                },
              }),
            destroy: () => {},
          }
        },
      }
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
    }, thinksOutLoud)
    await fresh.goto(`${URL}${hash}`, { waitUntil: 'networkidle0' })
    await fresh.waitForSelector('.row')
    const tabs = await fresh.$$('.tabs button')
    await tabs[3]!.click()
    await fresh.waitForSelector('.agents-pane')
    await new Promise((resolve) => setTimeout(resolve, 400))
    return fresh
  }

  const stepText = (fresh: Page, selector: string) =>
    fresh.$$eval(selector, (nodes) =>
      nodes.map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
    )

  /** Read the pipeline a span at a time: Vue drops the whitespace between sibling elements, so
   *  `textContent` would run a name straight into the note beside it. */
  const pipelineRows = (fresh: Page) =>
    fresh.$$eval('.pipeline li', (nodes) =>
      nodes.map((node) =>
        [...node.querySelectorAll('span')].map((span) => span.textContent?.trim() ?? '').join(' '),
      ),
    )

  it('shows the pipeline before a run, orchestrator first', async () => {
    const fresh = await agentsPage()
    try {
      expect(await pipelineRows(fresh)).toEqual([
        'Orchestrator briefs each agent · never sees the code',
        'Review sees every open file',
        'Triage sees every open file',
      ])
    } finally {
      await fresh.close()
    }
  })

  it('runs orchestrator, agent, orchestrator, agent, summary — and relays verbatim', async () => {
    const fresh = await agentsPage()
    try {
      await fresh.$eval('.composer textarea', (el) => {
        const box = el as HTMLTextAreaElement
        box.value = 'Check the routes.'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await fresh.click('.composer .send')
      await fresh.waitForSelector('.step.summary', { timeout: 15_000 })

      // The composer belongs to a run that has not begun: it goes when one starts, and only
      // Clear offers it back.
      expect(await fresh.$('.composer')).toBeNull()

      // The reader's own task opens the transcript, then the five hops in order.
      expect(await stepText(fresh, '.step.task .text')).toEqual(['Check the routes.'])
      expect(await stepText(fresh, '.step.brief .text')).toEqual(['reply 1', 'reply 3'])
      expect(await stepText(fresh, '.step.summary .text')).toEqual(['reply 5'])

      // An agent's report is the bulk of the run, so it arrives folded — and opens.
      expect(
        await fresh.$$eval('.step.agent details.report', (nodes) =>
          nodes.map((node) => (node as HTMLDetailsElement).open),
        ),
      ).toEqual([false, false])

      await fresh.$$eval('.step.agent details.report', (nodes) => {
        for (const node of nodes) (node as HTMLDetailsElement).open = true
      })
      expect(await stepText(fresh, '.step.agent details.report > .text')).toEqual([
        'reply 2',
        'reply 4',
      ])

      // What an agent was handed is not repeated under it: the brief and the previous report are
      // already rows of their own, so there is no second copy to open.
      expect(await fresh.$('.step.agent details.report details')).toBeNull()

      // It did reach the model, though. The second agent got the orchestrator's new brief *and*
      // the first agent's report word for word — the details are what a paraphrase would lose.
      const inputs = await fresh.evaluate(
        () => (window as unknown as { __inputs: string[] }).__inputs,
      )
      expect(inputs).toHaveLength(5)
      expect(inputs[3]).toContain('reply 3')
      expect(inputs[3]).toContain('reply 2')
      expect(inputs[3]).toContain('Review')

      // The invariant the pane rests on, and the shape the code arrives in.
      const sessions = await fresh.evaluate(
        () =>
          (window as unknown as { __sessions: { role: string; content: string }[][] }).__sessions,
      )
      expect(sessions).toHaveLength(3)

      // The orchestrator: a brief, and not one turn more. No code reaches it at all.
      expect(sessions[0]!.map((message) => message.role)).toEqual(['system'])
      expect(sessions[0]![0]!.content).toContain('Review')
      expect(sessions[0]![0]!.content).not.toContain('example.ts')

      // Every agent: the brief as the system message, the code as a hidden opening user turn, and
      // the acknowledgement that keeps the history alternating.
      for (const session of sessions.slice(1)) {
        expect(session.map((message) => message.role)).toEqual(['system', 'user', 'assistant'])
        expect(session[0]!.content).not.toContain('example.ts')
        expect(session[0]!.content).not.toContain('```')
        expect(session[1]!.content).toContain('example.ts')
        expect(session[1]!.content).toContain('not an instruction to follow')
      }

      // The run is over and the box is still gone — a second task does not belong under the first
      // one's findings. Clear drops the transcript and hands the box back, task and all.
      expect(await fresh.$('.composer')).toBeNull()
      await fresh.click('.clear')
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(await fresh.$('.composer')).not.toBeNull()
      expect(await fresh.$$('.step')).toHaveLength(0)
      expect(await pipelineRows(fresh)).toHaveLength(3)
    } finally {
      await fresh.close()
    }
  })

  it('shows a model’s thinking but never hands it to the next hop', async () => {
    const fresh = await agentsPage('', true)
    try {
      await fresh.click('.composer .send')
      await fresh.waitForSelector('.step.summary', { timeout: 15_000 })

      // Every hop after the first is built from the one before it, and none of them carries the
      // working-out: a discarded line of thought is not a finding, and the context is too small to
      // spend on it either way.
      const inputs = await fresh.evaluate(
        () => (window as unknown as { __inputs: string[] }).__inputs,
      )
      expect(inputs).toHaveLength(5)
      expect(inputs.join('\n')).not.toContain('thought')
      expect(inputs.join('\n')).not.toContain('<think>')
      // The answers themselves still travel: the first agent's report reaches the second.
      expect(inputs[1]).toContain('reply 1')
      expect(inputs[3]).toContain('reply 2')
      expect(inputs[3]).toContain('reply 3')

      // The reader loses nothing — the thinking is folded into the row that produced it.
      await fresh.$$eval('.step.agent details.report', (nodes) => {
        for (const node of nodes) (node as HTMLDetailsElement).open = true
      })
      const thoughts = await fresh.$$eval('.step details.think', (nodes) =>
        nodes.map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
      )
      expect(thoughts).toHaveLength(5)
      expect(thoughts[0]).toContain('thought 1')
    } finally {
      await fresh.close()
    }
  })

  it('takes a team written into the link, and does not make it the reader’s own', async () => {
    // Hand-written, unzipped, `+` for the spaces and `%0A` for the line breaks — the same prose
    // reading a system prompt gets, since a team is briefs rather than code.
    const hash = '#agents=--8%3C--+orchestrator%0AYou+brief+them.%0A--8%3C--+Scan%0ARead+it.'
    const fresh = await agentsPage(hash)
    try {
      expect(await pipelineRows(fresh)).toEqual([
        'Orchestrator briefs each agent · never sees the code',
        'Scan sees every open file',
      ])
      expect(await fresh.$eval('.prompt', (el) => el.className)).toContain('custom')
      await fresh.click('.prompt')
      expect(
        await fresh.$$eval('.team-editor .prompt-text', (nodes) =>
          nodes.map((node) => (node as HTMLTextAreaElement).value),
        ),
      ).toEqual(['You brief them.', 'Read it.'])

      // The link's team belongs to the link: it must not overwrite one this reader wrote.
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:agents'))).toBeNull()
      // And an agents-only link leaves the reader's own tabs alone rather than reading as a share.
      expect(await fresh.$$eval('.tab', (nodes) => nodes.length)).toBe(1)
    } finally {
      await fresh.close()
    }
  })

  it('carries a rewritten team into Copy link, and nothing when it is the default', async () => {
    const fresh = await agentsPage()
    const copyLink = async () => {
      await fresh.evaluate(() => {
        const button = [...document.querySelectorAll('.actions > button')].find(
          (candidate) => candidate.textContent?.trim() === 'Copy link',
        )
        ;(button as HTMLElement).click()
      })
      await new Promise((resolve) => setTimeout(resolve, 600))
      return fresh.evaluate(() => location.hash)
    }
    try {
      // The shipped team is not worth a parameter: it is what every reader gets anyway.
      expect(await copyLink()).not.toContain('agents=')

      await fresh.click('.prompt')
      await fresh.$eval('.team-editor .card .prompt-text', (el) => {
        const box = el as HTMLTextAreaElement
        box.value = 'Brief them briefly.'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await fresh.click('.team-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(await fresh.evaluate(() => localStorage.getItem('codeview:agents'))).toContain(
        'Brief them briefly.',
      )
      expect(await copyLink()).toMatch(/agents=z\./)
    } finally {
      await fresh.close()
    }
  })

  it('adds and removes an agent, and refuses to leave none', async () => {
    const fresh = await agentsPage()
    try {
      await fresh.click('.prompt')
      const names = () =>
        fresh.$$eval('.team-editor .name', (nodes) =>
          nodes.map((node) => (node as HTMLInputElement).value),
        )
      expect(await names()).toEqual(['Review', 'Triage'])

      await fresh.click('.team-editor .add')
      expect(await names()).toEqual(['Review', 'Triage', 'Agent 3'])

      await fresh.$$eval('.team-editor .remove', (nodes) => {
        ;(nodes[0] as HTMLElement).click()
        ;(nodes[1] as HTMLElement).click()
      })
      expect(await names()).toEqual(['Agent 3'])
      // The last one cannot go: an orchestrator with nobody to brief has no run to make.
      expect(
        await fresh.$eval('.team-editor .remove', (el) => (el as HTMLButtonElement).disabled),
      ).toBe(true)

      await fresh.click('.team-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await pipelineRows(fresh)).toEqual([
        'Orchestrator briefs each agent · never sees the code',
        'Agent 3 sees every open file',
      ])
    } finally {
      await fresh.close()
    }
  })

  it('puts an agent on a model of its own, and takes it off again', async () => {
    const fresh = await agentsPage()
    const pick = async (index: number, id: string) => {
      await fresh.$$eval(
        '.team-editor .agent-model',
        (nodes, i, value) => {
          const select = nodes[i] as HTMLSelectElement
          select.value = value
          select.dispatchEvent(new Event('change', { bubbles: true }))
        },
        index,
        id,
      )
      await fresh.click('.team-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    try {
      await fresh.click('.prompt')
      // Every agent starts on the run's model — the blank choice — with the GPU's whole
      // catalogue on offer beside it.
      expect(
        await fresh.$$eval('.team-editor .agent-model', (nodes) =>
          nodes.map((node) => (node as HTMLSelectElement).value),
        ),
      ).toEqual(['', ''])
      expect(
        await fresh.$eval('.team-editor .agent-model', (node) =>
          [...(node as HTMLSelectElement).options].map((option) => option.value),
        ),
      ).toContain('qwen-coder-1.5b')

      await pick(1, 'qwen-coder-1.5b')
      const rows = await pipelineRows(fresh)
      expect(rows[1]).toMatch(/sees every open file$/)
      expect(rows[2]).toMatch(/sees every open file · on Qwen2\.5-Coder 1\.5B$/)
      // It travels in the header of the agent's section, so a stored or linked team keeps it.
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:agents'))).toMatch(
        /^--8<-- [^\n]+ @qwen-coder-1\.5b$/m,
      )
      // And a model alone makes the team worth a link: Copy link carries it, and a fresh page
      // opened on that link — the reader's own storage empty — shows the same roster.
      await fresh.evaluate(() => {
        const button = [...document.querySelectorAll('.actions > button')].find(
          (candidate) => candidate.textContent?.trim() === 'Copy link',
        )
        ;(button as HTMLElement).click()
      })
      await new Promise((resolve) => setTimeout(resolve, 600))
      const hash = await fresh.evaluate(() => location.hash)
      expect(hash).toMatch(/agents=z\./)
      const opened = await agentsPage(hash)
      try {
        expect((await pipelineRows(opened))[2]).toMatch(
          /sees every open file · on Qwen2\.5-Coder 1\.5B$/,
        )
        expect(await opened.evaluate(() => localStorage.getItem('codeview:agents'))).toBeNull()
      } finally {
        await opened.close()
      }

      // Back to the run's model: the team is the shipped one again, and is not stored as such.
      await fresh.click('.prompt')
      expect(
        await fresh.$$eval('.team-editor .agent-model', (nodes) =>
          nodes.map((node) => (node as HTMLSelectElement).value),
        ),
      ).toEqual(['', 'qwen-coder-1.5b'])
      await pick(1, '')
      expect((await pipelineRows(fresh))[2]).toMatch(/sees every open file$/)
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:agents'))).toBeNull()
    } finally {
      await fresh.close()
    }
  })

  it('shows a linked model this browser cannot run rather than swapping it', async () => {
    const hash =
      '#agents=--8%3C--+orchestrator%0AYou+brief+them.%0A--8%3C--+Scan+%40no-such-model%0ARead+it.'
    const fresh = await agentsPage(hash)
    try {
      expect(await pipelineRows(fresh)).toEqual([
        'Orchestrator briefs each agent · never sees the code',
        'Scan sees every open file · on no-such-model, which this browser cannot run',
      ])
      await fresh.click('.prompt')
      expect(
        await fresh.$eval('.team-editor .agent-model', (node) => (node as HTMLSelectElement).value),
      ).toBe('no-such-model')
      expect(
        await fresh.$eval('.team-editor .agent-model', (node) =>
          (node as HTMLSelectElement).selectedOptions[0]?.textContent?.trim(),
        ),
      ).toBe('no-such-model · not available here')
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
