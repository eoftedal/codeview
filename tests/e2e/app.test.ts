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

/** The chat tab, third on the row — the settings cogwheel that follows Agents is the fifth, and
 *  is addressed by its class rather than by index. */
async function openChat(target: Page = page): Promise<void> {
  const tabs = await target.$$('.tabs button')
  await tabs[2]!.click()
  await target.waitForSelector('.chat-pane')
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

/** Click "Copy link" and read back the fragment it produced. Copy link never touches the page's
 *  own address bar any more, and whether the real clipboard permission is granted varies by
 *  Chrome version and CI, so `writeText` is patched to capture its argument directly rather than
 *  trusting either of those. */
async function copyLink(target: Page = page): Promise<string> {
  await target.evaluate(() => {
    ;(window as unknown as { __copiedLink: string | null }).__copiedLink = null
    navigator.clipboard.writeText = async (text: string) => {
      ;(window as unknown as { __copiedLink: string | null }).__copiedLink = text
    }
    const button = [...document.querySelectorAll('.actions > button')].find(
      (candidate) => candidate.textContent?.trim() === 'Copy link',
    )
    ;(button as HTMLElement | undefined)?.click()
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const copied = await target.evaluate(
    () => (window as unknown as { __copiedLink: string | null }).__copiedLink,
  )
  const index = copied?.indexOf('#') ?? -1
  return index >= 0 ? copied!.slice(index) : ''
}

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

describe('python', () => {
  /** A fresh page: this suite's shared page holds the TypeScript sample, and a Python buffer
   *  belongs to a different backend entirely. */
  async function openPython(hash: string) {
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    await fresh.goto(`${URL}${hash}`, { waitUntil: 'networkidle0' })
    // The seed buffer renders before the link is applied and the grammar is fetched after that,
    // so waiting for `.row` alone would match the TypeScript tree still on screen.
    await fresh.waitForFunction(
      () => document.querySelector('.row .kind')?.textContent?.trim() === 'module',
      { timeout: 20_000 },
    )
    return fresh
  }

  const SOURCE = 'greeting = "hi"\n\ndef greet(greeting):\n    return greeting\n'

  it('shows a tree-sitter tree, and says PY on the tab', async () => {
    const fresh = await openPython(`#src=${encodeURIComponent(SOURCE)}&lang=py&filename=app.py`)
    const kinds = await fresh.$$eval('.row .kind', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? ''),
    )
    expect(kinds[0]).toBe('module')
    expect(kinds).toContain('function_definition')
    expect(await fresh.$eval('.tab .badge', (el) => el.textContent?.trim())).toBe('PY')
    expect(await fresh.$eval('.languages button.active', (el) => el.textContent?.trim())).toBe('PY')
    await fresh.close()
  })

  it('resolves a definition, preferring the parameter that shadows the module name', async () => {
    const fresh = await openPython(`#src=${encodeURIComponent(SOURCE)}&lang=py&filename=app.py`)
    await clickAt('return greeting', 10, 0, fresh)
    const definition = await fresh.$eval(
      '.definition',
      (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    )
    expect(definition).toContain('parameter `greeting`')
    expect(definition).toContain('line 3')
    await fresh.close()
  })

  it('traces a value back to its sources, across the tab that declares it', async () => {
    const bundle = [
      '--8<-- app.py',
      'from db import fetch',
      '',
      'def handler():',
      '    row = fetch()',
      '    return row',
      '--8<-- db.py',
      'def fetch():',
      '    return "seed"',
    ].join('\n')
    const fresh = await openPython(`#files=${encodeURIComponent(bundle)}&active=app.py`)

    await clickAt('return row', 8, 0, fresh)
    const tabs = await fresh.$$('.tabs button')
    await tabs[1]!.click()
    await fresh.waitForSelector('.trace-pane')
    // Switching to the pane does not run anything — the trace costs a scan, so it waits to be asked.
    expect(await fresh.$eval('.trace-pane .run', (el) => (el as HTMLButtonElement).disabled)).toBe(
      false,
    )
    await fresh.click('.trace-pane .run')
    await new Promise((resolve) => setTimeout(resolve, 200))

    const rows = await fresh.$$eval('.trace-pane .row', (nodes) =>
      nodes.map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
    )
    // The chain leaves app.py through the import and ends on the literal in db.py.
    expect(rows.join(' | ')).toContain('fetch()')
    expect(rows.some((row) => row.includes('"seed"'))).toBe(true)
    await fresh.close()
  })

  it('keeps a Python tab and a TypeScript tab in separate programs', async () => {
    // One bundle, two languages. Each tab must resolve in its own backend, and neither may see
    // the other's declarations — there is no build system here to say what would bridge them.
    const bundle = [
      '--8<-- app.py',
      'from db import run',
      'run()',
      '--8<-- helper.ts',
      "export const shared = 'ts'",
      'shared',
    ].join('\n')
    const fresh = await openPython(`#files=${encodeURIComponent(bundle)}&active=app.py`)

    expect(await fresh.$$eval('.tab .badge', (n) => n.map((e) => e.textContent?.trim()))).toEqual([
      'PY',
      'TS',
    ])

    // The Python tab: `run` is an import of a module no tab holds, so no `defined in`.
    await clickAt('run()', 1, 0, fresh)
    const pythonDefinition = await fresh.$eval(
      '.definition',
      (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    )
    expect(pythonDefinition).toContain('import `run`')
    expect(pythonDefinition).not.toContain('helper.ts')

    // Switch to the TypeScript tab: the other backend answers, and the tree changes shape.
    await fresh.evaluate(() => {
      const tabs = [...document.querySelectorAll('.tab')]
      ;(tabs.find((t) => t.textContent?.includes('helper.ts')) as HTMLElement).click()
    })
    await fresh.waitForFunction(
      () => document.querySelector('.row .kind')?.textContent?.trim() === 'SourceFile',
      { timeout: 10_000 },
    )
    await clickAt('shared', 2, 1, fresh)
    expect(
      await fresh.$eval('.definition', (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
    ).toContain('variable `shared`')
    await fresh.close()
  })
})

describe('java', () => {
  async function openJava(hash: string) {
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    await fresh.goto(`${URL}${hash}`, { waitUntil: 'networkidle0' })
    await fresh.waitForFunction(
      () => document.querySelector('.row .kind')?.textContent?.trim() === 'program',
      { timeout: 20_000 },
    )
    return fresh
  }

  it('shows a tree-sitter tree, says JAVA on the tab, and resolves a field', async () => {
    const source =
      'class A {\n    private String host = "h";\n    String get() { return host; }\n}\n'
    const fresh = await openJava(`#src=${encodeURIComponent(source)}&lang=java&filename=A.java`)

    const kinds = await fresh.$$eval('.row .kind', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? ''),
    )
    expect(kinds[0]).toBe('program')
    expect(kinds).toContain('class_declaration')
    expect(await fresh.$eval('.tab .badge', (el) => el.textContent?.trim())).toBe('JAVA')

    // A field read by bare name — the lookup walks through the class, unlike Python's.
    await clickAt('return host', 8, 0, fresh)
    expect(
      await fresh.$eval('.definition', (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
    ).toContain('property `host`')
    await fresh.close()
  })

  it('traces a value back across the tab that declares it', async () => {
    const bundle = [
      '--8<-- Main.java',
      'class Main {',
      '    void run() {',
      '        Db db = new Db();',
      '        String row = db.load();',
      '        use(row);',
      '    }',
      '}',
      '--8<-- Db.java',
      'class Db {',
      '    String load() { return "seed"; }',
      '}',
    ].join('\n')
    const fresh = await openJava(`#files=${encodeURIComponent(bundle)}&active=Main.java`)

    await clickAt('use(row)', 5, 0, fresh)
    const tabs = await fresh.$$('.tabs button')
    await tabs[1]!.click()
    await fresh.waitForSelector('.trace-pane')
    await fresh.click('.trace-pane .run')
    await new Promise((resolve) => setTimeout(resolve, 200))

    const rows = await fresh.$$eval('.trace-pane .row', (nodes) =>
      nodes.map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
    )
    // The chain crosses into Db.java through the receiver's written-down type.
    expect(rows.join(' | ')).toContain('db.load()')
    expect(rows.some((row) => row.includes('"seed"'))).toBe(true)
    await fresh.close()
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
    // `copyLink` patches `navigator.clipboard.writeText` to capture its argument, since whether the
    // real permission is granted varies by Chrome version and CI — Copy link never touches this
    // page's own address bar, so there's nothing else to read the link back from.
    const hash = await copyLink(page)
    expect(hash).toMatch(/^#src=z\./)

    const { fresh, source } = await loadInNewPage(hash)
    try {
      expect(source).toContain('import { formatAddress }')
      expect(source).toContain('const greeting = ')
    } finally {
      await fresh.close()
    }
  })

  it('drops the fragment once loaded, so an edit survives a reload instead of the link snapping back', async () => {
    const fresh = await browser.newPage()
    try {
      await fresh.setViewport({ width: 1400, height: 1000 })
      await fresh.goto(`${URL}#src=const%20answer%20%3D%2042&lang=ts`, {
        waitUntil: 'networkidle0',
      })
      await fresh.waitForSelector('.view-line')
      await new Promise((resolve) => setTimeout(resolve, 600))

      // The fragment did its one job of loading the buffer, and is already gone from the address
      // bar — a reload from here must fall back to what's stored, not to the link again.
      expect(await fresh.evaluate(() => location.hash)).toBe('')

      await clickAt('const answer', 0, 0, fresh)
      await fresh.keyboard.type('// edited\n')
      // Past the 400ms debounce on the localStorage save this depends on surviving the reload.
      await new Promise((resolve) => setTimeout(resolve, 700))

      await fresh.reload({ waitUntil: 'networkidle0' })
      await fresh.waitForSelector('.view-line')
      await new Promise((resolve) => setTimeout(resolve, 600))

      const source = await fresh.$$eval('.view-line', (nodes) =>
        nodes.map((node) => (node.textContent ?? '').replace(/\u00a0/g, ' ')).join('\n'),
      )
      expect(source).toContain('// edited')
    } finally {
      await fresh.close()
    }
  })
})

describe('embedding parameters', () => {
  async function open(query: string) {
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    // A query with no `src` falls back to whatever the last page stored — and the test before
    // this group deliberately leaves a two-line edit in `localStorage` to prove a reload keeps it.
    // Cleared here so these pages start from the sample, whatever ran before them.
    await fresh.evaluateOnNewDocument(() => localStorage.clear())
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

      const hash = await copyLink(fresh)
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
      const hash = await copyLink(fresh)
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

  it('copies the trace as text, every step naming its own file and line', async () => {
    // What the copy is *for* is pasting into the chat or an agent's task, where there is no editor
    // beside it — so a step in the tab on screen has to name its file too, though the pane does
    // not. `writeText` is patched for the same reason `copyLink` patches it: whether the real
    // clipboard permission is granted varies by Chrome version and CI.
    const copied = await page.evaluate(async () => {
      let text: string | null = null
      navigator.clipboard.writeText = async (written: string) => {
        text = written
      }
      document.querySelector<HTMLElement>('.trace-pane .copy')!.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
      return text as string | null
    })
    expect(copied).toContain('Backward trace of variable `address`')
    const steps = (copied ?? '').split('\n').filter((line) => line.trim().startsWith('- '))
    expect(steps.length).toBeGreaterThan(1)
    for (const step of steps) expect(step).toMatch(/\([\w./-]+ line \d+\)/)
    // The caveat travels with it: a may-analysis pasted without one reads as a claim.
    expect(copied).toContain('may-analysis')
    // And the button says so where the finger already is.
    expect(await page.$eval('.trace-pane .copy', (el) => el.textContent?.trim())).toBe('Copied')
  })

  it('hands the trace to a new chat, over just the files it cites', async () => {
    // The point of the button over copying the text by hand: a conversation opened over the two
    // files the path runs through, not over every tab, so the budget is spent on the code the
    // question is actually about.
    const bundle = [
      '--8<-- app.ts',
      "import { read } from './db'",
      'const raw = read()',
      'const out = raw',
      '--8<-- db.ts',
      'export function read() {',
      '  return process.env.SEED',
      '}',
      '--8<-- unrelated.ts',
      "export const nothing = 'to do with this trace'",
    ].join('\n')
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    await fresh.evaluateOnNewDocument(() => {
      ;(window as unknown as { __prompts: unknown[] }).__prompts = []
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async (options: { initialPrompts?: unknown }) => {
          ;(window as unknown as { __prompts: unknown[] }).__prompts.push(
            options?.initialPrompts ?? [],
          )
          return {
            promptStreaming: () =>
              new ReadableStream({
                start(controller) {
                  controller.enqueue('Read.')
                  controller.close()
                },
              }),
            destroy: () => {},
          }
        },
      }
    })
    try {
      await fresh.goto(`${URL}#files=${encodeURIComponent(bundle)}&active=app.ts`, {
        waitUntil: 'networkidle0',
      })
      await fresh.waitForSelector('.row')
      await clickAt('const out = raw', 12, 0, fresh)
      const tabs = await fresh.$$('.tabs button')
      await tabs[1]!.click()
      await fresh.waitForSelector('.trace-pane')
      await fresh.click('.trace-pane .run')
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Short enough that a whole trace cannot fit: the question is pushed before the chat pane
      // exists, so without a scroll on mount the reader lands on the top of it with the answer
      // forming out of sight.
      await fresh.setViewport({ width: 1400, height: 400 })
      await fresh.click('.trace-pane .analyze')
      await fresh.waitForSelector('.chat-pane')
      await new Promise((resolve) => setTimeout(resolve, 400))

      const scrolled = await fresh.$eval('.chat-pane .body', (el) => ({
        overflows: el.scrollHeight > el.clientHeight,
        atEnd: Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2,
      }))
      expect(scrolled.overflows).toBe(true)
      expect(scrolled.atEnd).toBe(true)

      // The question the reader can see is the one that was asked: the task, then the trace.
      const asked = await fresh.$eval('.chat-pane .message.user', (el) => el.textContent ?? '')
      expect(asked).toContain('Analyze this trace.')
      // The caret on `out = raw` traces `raw`, whose path leaves app.ts through the import.
      expect(asked).toContain(
        'Backward trace of variable `raw`, from app.ts line 2 — 3 steps, 2 files, 1 origin outside the open files.',
      )

      // And what the model was opened over: the two files the trace names, not the third tab.
      const code = await fresh.evaluate(() => {
        const prompts = (window as unknown as { __prompts: { role: string; content: string }[][] })
          .__prompts[0]
        return prompts?.find((turn, index) => index > 0 && turn.role === 'user')?.content ?? ''
      })
      expect(code).toContain('`app.ts`')
      expect(code).toContain('`db.ts`')
      expect(code).not.toContain('unrelated.ts')
      // Said on the pane too, since by the time an answer lands the trace that explains the
      // narrowing is a tab away.
      expect(await fresh.$eval('.chat-pane .clipped', (el) => el.textContent ?? '')).toContain(
        'only the 2 files the question names (app.ts, db.ts)',
      )
    } finally {
      await fresh.close()
    }
  })

  it('takes the wrapper’s own tab to the chat, with no row landing in it', async () => {
    // The Spring shape: a path variable wrapped in a record, the record passed on. This record
    // declares no constructor, so nothing in the trace lands a row in its file — and a model
    // asked whether the value is validated cannot answer without that source. The step records
    // the tab, and `Analyze this trace` spends it.
    const bundle = [
      '--8<-- ProductController.java',
      'class ProductController {',
      '    public ProductDto productById(@PathVariable String id) {',
      '        var productId = new ProductId(id);',
      '        return repo.getPizza(productId);',
      '    }',
      '}',
      '--8<-- ProductId.java',
      'public record ProductId(',
      '    String value',
      ') {}',
    ].join('\n')
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    await fresh.evaluateOnNewDocument(() => {
      ;(window as unknown as { __prompts: unknown[] }).__prompts = []
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async (options: { initialPrompts?: unknown }) => {
          ;(window as unknown as { __prompts: unknown[] }).__prompts.push(
            options?.initialPrompts ?? [],
          )
          return {
            promptStreaming: () =>
              new ReadableStream({
                start(controller) {
                  controller.enqueue('Read.')
                  controller.close()
                },
              }),
            destroy: () => {},
          }
        },
      }
    })
    try {
      await fresh.goto(`${URL}#files=${encodeURIComponent(bundle)}&active=ProductController.java`, {
        waitUntil: 'networkidle0',
      })
      // The Java grammar is fetched after the seed buffer renders, so wait for its tree.
      await fresh.waitForFunction(
        () => document.querySelector('.row .kind')?.textContent?.trim() === 'program',
        { timeout: 20_000 },
      )
      await clickAt('productId);', 3, 0, fresh)
      const tabs = await fresh.$$('.tabs button')
      await tabs[1]!.click()
      await fresh.waitForSelector('.trace-pane')
      await fresh.click('.trace-pane .run')
      await new Promise((resolve) => setTimeout(resolve, 200))

      // The construction is no longer a terminal: the path reaches the @PathVariable.
      const rows = await fresh.$$eval('.trace-pane .row', (nodes) =>
        nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()),
      )
      expect(rows.join(' | ')).toContain('new ProductId(id)')
      expect(rows.some((row) => row.includes('@PathVariable'))).toBe(true)
      // ...and nothing lands a row in the record's own tab.
      expect(rows.some((row) => row.includes('ProductId.java'))).toBe(false)

      await fresh.click('.trace-pane .analyze')
      await fresh.waitForSelector('.chat-pane')
      await new Promise((resolve) => setTimeout(resolve, 400))

      const code = await fresh.evaluate(() => {
        const prompts = (window as unknown as { __prompts: { role: string; content: string }[][] })
          .__prompts[0]
        return prompts?.find((turn, index) => index > 0 && turn.role === 'user')?.content ?? ''
      })
      // Both tabs: the one the trace cites, and the one it only passed through.
      expect(code).toContain('`ProductController.java`')
      expect(code).toContain('`ProductId.java`')
      expect(code).toContain('public record ProductId(')
    } finally {
      await fresh.close()
    }
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
    await openChat(fresh)
    // The GPU probe is async, and what the pane offers depends on how it lands.
    await new Promise((resolve) => setTimeout(resolve, 400))
    return fresh
  }

  /** The cogwheel at the far end of the tab row. A key, a server address and the reader's own
   *  catalogue additions are the same facts for a chat and for an agent run, so they are no longer
   *  reachable through a conversation's own settings — every case below goes here for them. */
  async function openSettings(target: Page): Promise<void> {
    await target.waitForSelector('.tabs button.settings')
    await target.click('.tabs button.settings')
    await target.waitForSelector('.settings-pane')
  }

  async function saveSettings(target: Page): Promise<void> {
    await target.click('.settings-pane .save')
  }

  it('still offers OpenRouter when the browser can run neither of the others', async () => {
    const fresh = await chatPageWith(() => {
      delete (window as unknown as { LanguageModel?: unknown }).LanguageModel
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => null },
        configurable: true,
      })
    })
    try {
      // Nothing on-device can run, but OpenRouter needs neither a browser model nor a GPU — only a
      // key, which is what the status line says is missing rather than the pane going empty.
      const options = await fresh.$$eval('.model option', (nodes) =>
        nodes.map((node) => node.textContent?.trim()),
      )
      expect(options).toEqual([
        'GPT-4o mini (OpenRouter) · no download',
        'Claude Haiku 4.5 (OpenRouter) · no download',
        'Claude Sonnet 5 (OpenRouter) · no download',
        'GLM-5.3 Flash (OpenRouter) · no download',
      ])
      expect(await fresh.$eval('.chat-pane', (el) => el.textContent)).not.toContain(
        'No language model is available in this browser.',
      )
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
      // OpenRouter needs no GPU, so it survives losing the adapter alongside builtin — it is a
      // key, not a browser capability, that these three are missing.
      expect(options).toEqual([
        'Browser built-in · no download',
        'GPT-4o mini (OpenRouter) · no download',
        'Claude Haiku 4.5 (OpenRouter) · no download',
        'Claude Sonnet 5 (OpenRouter) · no download',
        'GLM-5.3 Flash (OpenRouter) · no download',
      ])
    } finally {
      await fresh.close()
    }
  })

  it('offers the whole catalogue on a GPU, with the browser’s own model as the default', async () => {
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

  it('keeps an OpenRouter model selectable with no key, and stops and complains when asked', async () => {
    const fresh = await chatPageWith(function () {
      localStorage.clear()
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
    })
    try {
      // Unlike a GPU-only model on a GPU-less browser, this one is not hidden: what it is missing
      // is a key the reader can supply here, not a browser capability.
      await fresh.select('.model', 'openrouter-gpt-4o-mini')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await fresh.$eval('.status .muted', (el) => el.textContent)).toContain(
        'add an OpenRouter API key',
      )

      await fresh.type('.composer textarea', 'What does this do?')
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 200))

      const failed = await fresh.$eval('.message.failed .text', (el) => el.textContent)
      expect(failed).toContain('needs an OpenRouter API key')
    } finally {
      await fresh.close()
    }
  })

  it('lets an OpenRouter key be entered, used, persisted and cleared — and never shared', async () => {
    // Its own storage partition and browser context, for the same reason the system-prompt reload
    // test uses one: what survives a reload is the point, and `chatPageWith`'s pages share an
    // origin with every other test in this file.
    const context = await browser.createBrowserContext()
    const fresh = await context.newPage()
    try {
      await fresh.evaluateOnNewDocument(function () {
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: async () => ({}) },
          configurable: true,
        })
        const originalFetch = window.fetch.bind(window)
        window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString()
          if (!url.includes('openrouter.ai')) return originalFetch(input, init)
          const encoder = new TextEncoder()
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
              )
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n',
                ),
              )
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            },
          })
          return new Response(body, { status: 200 })
        }) as typeof window.fetch
      })

      await fresh.goto(URL, { waitUntil: 'networkidle0' })
      await fresh.waitForSelector('.row')
      await openChat(fresh)
      await new Promise((resolve) => setTimeout(resolve, 400))

      await openSettings(fresh)
      await fresh.type('#openrouter-key', 'sk-or-test-key')
      await saveSettings(fresh)
      await new Promise((resolve) => setTimeout(resolve, 100))

      // The tab carries the fact, since a key set is invisible from anywhere else in the app.
      expect(await fresh.$eval('.tabs button.settings', (el) => el.className)).toContain('custom')
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:openrouter-key'))).toBe(
        'sk-or-test-key',
      )

      // A question against a keyed OpenRouter model now streams a real reply rather than
      // complaining.
      await openChat(fresh)
      await fresh.select('.model', 'openrouter-gpt-4o-mini')
      await new Promise((resolve) => setTimeout(resolve, 200))
      await fresh.type('.composer textarea', 'What does this do?')
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await fresh.$eval('.message.assistant .text', (el) => el.textContent)).toContain(
        'Hello there',
      )

      // The key is never in the link: Copy link only ever hand-picks the prompt and the agent
      // team into the fragment.
      const hash = await copyLink(fresh)
      expect(hash).not.toContain('sk-or-test-key')
      expect(hash).not.toContain('openrouter')

      // Persists across a reload, since nothing here clears storage on navigation…
      await fresh.reload({ waitUntil: 'networkidle0' })
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:openrouter-key'))).toBe(
        'sk-or-test-key',
      )

      // …and clearing it removes the stored value rather than writing an empty one.
      await openSettings(fresh)
      await fresh.click('.settings-pane .key-row button')
      await saveSettings(fresh)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:openrouter-key'))).toBeNull()
    } finally {
      await context.close()
    }
  })

  it('lets a reader add and remove their own OpenRouter model', async () => {
    const fresh = await chatPageWith(function () {
      localStorage.clear()
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
    })
    try {
      await openSettings(fresh)
      await fresh.type('.models-add .models-input', 'mistralai/mistral-large')
      // The second text input is the optional label.
      const labelInput = await fresh.$$('.models-add .models-input')
      await labelInput[1]!.type('Mistral Large')
      // Two checkboxes on the add row now — thinks, then tools. A slug that lists `tools` among
      // its parameters reads the files itself instead of being handed the listing.
      const flags = await fresh.$$('.models-add .models-think input')
      await flags[1]!.click()
      await fresh.click('.models-add button')
      await saveSettings(fresh)
      await new Promise((resolve) => setTimeout(resolve, 150))

      // It shows up in the picker under the label given it, alongside the shipped three.
      await openChat(fresh)
      const options = await fresh.$$eval('.model option', (nodes) =>
        nodes.map((node) => node.textContent?.trim()),
      )
      expect(options).toContain('Mistral Large · no download')
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:openrouter-models'))).toBe(
        JSON.stringify([
          {
            model: 'mistralai/mistral-large',
            label: 'Mistral Large',
            thinking: false,
            tools: true,
          },
        ]),
      )

      // It behaves exactly like a shipped OpenRouter entry: no key yet, so it stops and complains.
      await fresh.select(
        '.model',
        await fresh.$$eval(
          '.model option',
          (nodes) =>
            (nodes.find((n) => n.textContent?.includes('Mistral Large')) as HTMLOptionElement)
              .value,
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await fresh.$eval('.status .muted', (el) => el.textContent)).toContain(
        'add an OpenRouter API key',
      )

      // Removing it again takes it back out of the picker and out of storage.
      await openSettings(fresh)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await fresh.$$eval('.models-remove', (nodes) => nodes.length)).toBe(1)
      await fresh.click('.models-remove')
      expect(await fresh.$$eval('.models-remove', (nodes) => nodes.length)).toBe(0)
      await saveSettings(fresh)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(
        await fresh.evaluate(() => localStorage.getItem('codeview:openrouter-models')),
      ).toBeNull()
      await openChat(fresh)
      expect(
        await fresh.$$eval('.model option', (nodes) =>
          nodes.map((node) => node.textContent?.trim()),
        ),
      ).not.toContain('Mistral Large · no download')
    } finally {
      await fresh.close()
    }
  })

  it('offers no local model, and requests nothing, until an address is set', async () => {
    // The whole of the opt-in gate: on the deployed site this is the state every reader is in, and
    // nothing about it may reach for `localhost` — that is what would trip Chrome's local-network
    // permission prompt on a page nobody asked to do this.
    const fresh = await chatPageWith(function () {
      localStorage.clear()
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
      const originalFetch = window.fetch.bind(window)
      ;(window as unknown as { __probes: string[] }).__probes = []
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        ;(window as unknown as { __probes: string[] }).__probes.push(url)
        return originalFetch(input, init)
      }) as typeof window.fetch
    })
    try {
      const options = await fresh.$$eval('.model option', (nodes) =>
        nodes.map((node) => node.textContent?.trim()),
      )
      expect(options.some((label) => label?.includes('qwen2.5-coder'))).toBe(false)
      const probes = await fresh.evaluate(
        () => (window as unknown as { __probes: string[] }).__probes,
      )
      expect(probes.some((url) => url.includes('11434'))).toBe(false)
      expect(
        await fresh.evaluate(() => localStorage.getItem('codeview:local-server-url')),
      ).toBeNull()
    } finally {
      await fresh.close()
    }
  })

  it('discovers the models on a local server once its address is set, and answers from one', async () => {
    const fresh = await chatPageWith(function () {
      localStorage.clear()
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
      const originalFetch = window.fetch.bind(window)
      ;(window as unknown as { __inputs: unknown[] }).__inputs = []
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (!url.includes('11434')) return originalFetch(input, init)
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.2:3b' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        ;(window as unknown as { __inputs: unknown[] }).__inputs.push(
          JSON.parse(String(init?.body)),
        )
        const encoder = new TextEncoder()
        const body = new ReadableStream({
          start(controller) {
            // `reasoning_content` is llama.cpp's and LM Studio's spelling of a thought, not
            // OpenRouter's `reasoning` — folded into the same `<think>` block either way.
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"weighing"}}]}\n\n'),
            )
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Served"}}]}\n\n'),
            )
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":" locally"},"finish_reason":"stop"}]}\n\n',
              ),
            )
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        return new Response(body, { status: 200 })
      }) as typeof window.fetch
    })
    try {
      await openSettings(fresh)
      // A bare host is the spelling readers reach for, and it is stored canonical.
      await fresh.type('#local-server-url', 'localhost:11434')
      await saveSettings(fresh)
      await new Promise((resolve) => setTimeout(resolve, 400))

      expect(await fresh.evaluate(() => localStorage.getItem('codeview:local-server-url'))).toBe(
        'http://localhost:11434/v1',
      )
      // The field shows what was *kept*, not what was typed — which is the only way a reader
      // learns the scheme and the `/v1` were added for them.
      expect(await fresh.$eval('#local-server-url', (el) => (el as HTMLInputElement).value)).toBe(
        'http://localhost:11434/v1',
      )

      // Both models the server reported are now in the picker, from the one `/models` call that
      // also settled whether anything was listening.
      await openChat(fresh)
      const options = await fresh.$$eval('.model option', (nodes) =>
        nodes.map((node) => node.textContent?.trim()),
      )
      expect(options).toContain('qwen2.5-coder:7b · no download')
      expect(options).toContain('llama3.2:3b · no download')

      await fresh.select('.model', 'local:qwen2.5-coder:7b')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await fresh.$eval('.status .muted', (el) => el.textContent)).toContain(
        'running on your own server',
      )

      await fresh.type('.composer textarea', 'What does this do?')
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await fresh.$eval('.message.assistant .text', (el) => el.textContent)).toContain(
        'Served locally',
      )

      // The model name reaches the server as its own, not as our namespaced id, and the files ride
      // a user turn rather than the system prompt.
      const sent = (
        await fresh.evaluate(
          () =>
            (window as unknown as { __inputs: { model: string; messages: { role: string }[] }[] })
              .__inputs,
        )
      )[0]!
      expect(sent.model).toBe('qwen2.5-coder:7b')
      expect(sent.messages.map((message) => message.role).slice(0, 3)).toEqual([
        'system',
        'user',
        'assistant',
      ])

      // An address on this machine is no part of a share link, for the same reason the key is not:
      // it means nothing wherever the link is opened.
      const hash = await copyLink(fresh)
      expect(hash).not.toContain('11434')
      expect(hash).not.toContain('localhost')
    } finally {
      await fresh.close()
    }
  })

  it('names the server, not the browser, when nothing answers there', async () => {
    // A server that was up when it was last asked and is down now — which is why the discovered
    // list is kept through a failed probe rather than emptied, and why the model is still pickable.
    const fresh = await chatPageWith(function () {
      localStorage.clear()
      localStorage.setItem('codeview:local-server-url', 'http://localhost:11434/v1')
      localStorage.setItem(
        'codeview:local-server-seen',
        JSON.stringify([{ model: 'qwen2.5-coder:7b', label: 'qwen2.5-coder:7b', thinking: false }]),
      )
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
      const originalFetch = window.fetch.bind(window)
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        // What a browser actually does when nothing is listening, or the origin is refused.
        if (url.includes('11434')) throw new TypeError('Failed to fetch')
        return originalFetch(input, init)
      }) as typeof window.fetch
    })
    try {
      await fresh.select('.model', 'local:qwen2.5-coder:7b')
      await new Promise((resolve) => setTimeout(resolve, 400))

      await fresh.type('.composer textarea', 'What does this do?')
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 400))

      const failed = await fresh.$eval('.message.failed .text', (el) => el.textContent)
      expect(failed).toContain('No server answered at http://localhost:11434/v1')
      // The three causes worth naming, none of which is visible from the browser side.
      expect(failed).toContain('OLLAMA_ORIGINS')
      expect(failed).not.toContain('Failed to fetch')

      // The model it could not reach stays in the picker: one failed probe is not evidence the
      // reader's server is gone for good.
      expect(
        await fresh.$$eval('.model option', (nodes) =>
          nodes.map((node) => node.textContent?.trim()),
        ),
      ).toContain('qwen2.5-coder:7b · no download')
    } finally {
      await fresh.close()
    }
  })

  it('lets a reader name a local model by hand, for a server that lists none', async () => {
    const fresh = await chatPageWith(function () {
      localStorage.clear()
      localStorage.setItem('codeview:local-server-url', 'http://localhost:11434/v1')
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
      const originalFetch = window.fetch.bind(window)
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        // A server with no `/models` route at all — the case the hand-added list exists for.
        if (url.includes('11434')) return new Response('not found', { status: 404 })
        return originalFetch(input, init)
      }) as typeof window.fetch
    })
    try {
      await openSettings(fresh)
      await fresh.type('.models-add.local .models-input', 'deepseek-r1:8b')
      const labelInput = await fresh.$$('.models-add.local .models-input')
      await labelInput[1]!.type('DeepSeek R1')
      await fresh.click('.models-add.local .models-think input')
      await fresh.click('.models-add.local button')
      await saveSettings(fresh)
      await new Promise((resolve) => setTimeout(resolve, 300))

      await openChat(fresh)
      expect(
        await fresh.$$eval('.model option', (nodes) =>
          nodes.map((node) => node.textContent?.trim()),
        ),
      ).toContain('DeepSeek R1 · no download')
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:local-server-models'))).toBe(
        JSON.stringify([
          { model: 'deepseek-r1:8b', label: 'DeepSeek R1', thinking: true, tools: false },
        ]),
      )

      // Flagged as thinking, which is the one thing `/models` could never have told us — so the
      // checkbox is on offer for it.
      await fresh.select('.model', 'local:deepseek-r1:8b')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await fresh.$('.reason')).not.toBeNull()
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

  it('writes a hunting brief into the box, and stops claiming it once it is edited', async () => {
    const fresh = await chatPageWith(function () {
      localStorage.clear()
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async () => ({
          promptStreaming: () => new ReadableStream({ start: (c) => c.close() }),
          destroy: () => {},
        }),
      }
    })
    try {
      await fresh.click('.prompt')
      // The shipped brief is in the shelf too, so the picker names it rather than going blank on
      // a prompt nobody has touched.
      expect(await fresh.$eval('.template', (el) => (el as HTMLSelectElement).value)).toBe(
        'General taint review',
      )

      await fresh.$eval('.template', (el) => {
        const select = el as HTMLSelectElement
        select.value = 'Prototype pollution'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      const picked = await fresh.$eval('.prompt-text', (el) => (el as HTMLTextAreaElement).value)
      expect(picked).toContain('__proto__')
      // A hunter is brief on purpose: the code and the brief share one window.
      expect(picked.length).toBeLessThan(4_000)

      // Picking only writes the box — the choice itself is not kept, so an edited hunter is
      // the reader's own wording and the picker says so.
      await fresh.$eval('.prompt-text', (el) => {
        const box = el as HTMLTextAreaElement
        box.value = `${box.value}\n\nAlso check the merge helpers.`
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(await fresh.$eval('.template', (el) => (el as HTMLSelectElement).value)).toBe('')

      await fresh.click('.prompt-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await fresh.$eval('.prompt', (el) => el.className)).toContain('custom')
      expect(await fresh.evaluate(() => localStorage.getItem('codeview:chat-role'))).toContain(
        'Also check the merge helpers.',
      )
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

  it('scrolls a wide code block inside itself rather than widening the log', async () => {
    // A model answering about code answers *with* code, and a fenced line is as long as it is. The
    // bubble must keep the reader's width and let the block scroll — a log that scrolls sideways
    // moves the text out from under the eye that is reading it.
    const fresh = await chatPageWith(function () {
      // A default-width pane: an earlier case in this file drags the divider and the split is
      // remembered, and this one is about the code block's width, not the pane's.
      localStorage.clear()
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async () => ({
          promptStreaming: () =>
            new ReadableStream({
              start(controller) {
                const wide = `const query = \`SELECT * FROM users WHERE id = '${'x'.repeat(400)}'\``
                controller.enqueue('```ts\n' + wide + '\n```\n\n')
                // Many columns rather than one long cell: a cell's prose wraps (which is what a
                // reader wants), so what a table cannot do is fit twelve columns into a narrow pane.
                const columns = Array.from({ length: 12 }, (_, i) => `column ${i + 1}`)
                controller.enqueue(`| ${columns.join(' | ')} |\n`)
                controller.enqueue(`|${columns.map(() => '---').join('|')}|\n`)
                controller.enqueue(`| ${columns.map((_, i) => `value ${i + 1}`).join(' | ')} |\n`)
                controller.close()
              },
            }),
          destroy: () => {},
        }),
      }
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
        configurable: true,
      })
    })
    try {
      await fresh.type('.composer textarea', 'show me')
      await fresh.click('.composer .send')
      await fresh.waitForSelector('.message.assistant .md .code')

      const measured = await fresh.evaluate(() => {
        const pick = (selector: string) => document.querySelector(selector)!
        const box = (selector: string) => {
          const el = pick(selector)
          return { scroll: el.scrollWidth, client: el.clientWidth }
        }
        return {
          pane: box('.chat-pane'),
          log: box('.chat-pane .body'),
          bubble: box('.message.assistant .text'),
          code: box('.message.assistant .md .code'),
          table: box('.message.assistant .md .table'),
        }
      })

      // The block and the table are each wider than their box — that is the point of the line we
      // put in — and each is the one thing that scrolls.
      expect(measured.code.scroll).toBeGreaterThan(measured.code.client)
      expect(measured.table.scroll).toBeGreaterThan(measured.table.client)
      // Nothing above them overflows: not the bubble, not the log, not the pane.
      expect(measured.bubble.scroll).toBeLessThanOrEqual(measured.bubble.client)
      expect(measured.log.scroll).toBeLessThanOrEqual(measured.log.client)
      expect(measured.pane.scroll).toBeLessThanOrEqual(measured.pane.client)
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
      const reopenChat = async () => {
        await fresh.waitForSelector('.row')
        await openChat(fresh)
        await new Promise((resolve) => setTimeout(resolve, 400))
      }

      await fresh.goto(URL, { waitUntil: 'networkidle0' })
      await reopenChat()
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
      await reopenChat()
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
    try {
      // The shipped brief is not worth a parameter: it is what every reader gets anyway.
      expect(await copyLink(fresh)).not.toContain('systemprompt')

      await fresh.click('.prompt')
      await fresh.$eval('.prompt-text', (el) => {
        const box = el as HTMLTextAreaElement
        box.value = 'You are a poet.'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await fresh.click('.prompt-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 200))

      const hash = await copyLink(fresh)
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

describe('a question that names its files with @', () => {
  // Each file says something no other one does, so what reached the model can be told apart from
  // what did not.
  const BUNDLE = [
    '--8<-- app.ts',
    "import { read } from './db'",
    'const raw = read()',
    'const out = raw',
    '--8<-- db.ts',
    'export function read() {',
    '  return process.env.SEED',
    '}',
    '--8<-- auth.ts',
    'export const allow = true',
    '--8<-- unrelated.ts',
    "export const nothing = 'to do with this question'",
  ].join('\n')

  /** A page whose browser model records the turns each session was opened with. */
  async function taggingPage(seed: () => void = () => {}): Promise<Page> {
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    // Pages share an origin, so a model another case picked is still remembered here — and a
    // question answered by something other than the stub below leaves nothing to read back.
    // Registered before the seed, which sets storage of its own.
    await fresh.evaluateOnNewDocument(() => localStorage.clear())
    await fresh.evaluateOnNewDocument(seed)
    await fresh.evaluateOnNewDocument(() => {
      ;(window as unknown as { __prompts: unknown[] }).__prompts = []
      ;(window as unknown as { __asked: string[] }).__asked = []
      ;(window as unknown as { LanguageModel: unknown }).LanguageModel = {
        availability: async () => 'available',
        create: async (options: { initialPrompts?: unknown }) => {
          ;(window as unknown as { __prompts: unknown[] }).__prompts.push(
            options?.initialPrompts ?? [],
          )
          return {
            // What actually reached the model, which is not always what the transcript shows.
            promptStreaming: (input: string) => {
              ;(window as unknown as { __asked: string[] }).__asked.push(input)
              return new ReadableStream({
                start(controller) {
                  controller.enqueue('Read.')
                  controller.close()
                },
              })
            },
            destroy: () => {},
          }
        },
      }
    })
    await fresh.goto(`${URL}#files=${encodeURIComponent(BUNDLE)}&active=app.ts`, {
      waitUntil: 'networkidle0',
    })
    await fresh.waitForSelector('.row')
    await openChat(fresh)
    return fresh
  }

  /** The opening turn of the first session this page built — the listing, or the index. */
  const openingTurn = (target: Page) =>
    target.evaluate(() => {
      const prompts = (window as unknown as { __prompts: { role: string; content: string }[][] })
        .__prompts[0]
      return prompts?.find((turn, index) => index > 0 && turn.role === 'user')?.content ?? ''
    })

  it('completes a half-typed tag from the open tabs, the way Cmd+P does', async () => {
    const fresh = await taggingPage()
    try {
      await fresh.type('.composer textarea', 'where does this go? @db')
      await fresh.waitForSelector('.composer .mentions')
      // The same subsequence matcher the palette uses, over the same names — a reader has one
      // gesture for naming a file here, not two.
      expect(
        await fresh.$$eval('.composer .mention', (nodes) =>
          nodes.map((node) => node.textContent?.trim()),
        ),
      ).toEqual(['db.ts'])

      await fresh.keyboard.press('Enter')
      expect(
        await fresh.$eval('.composer textarea', (el) => (el as HTMLTextAreaElement).value),
      ).toBe('where does this go? @db.ts ')
      // Picking closes the list and leaves the caret in the sentence rather than in a dialog.
      expect(await fresh.$('.composer .mentions')).toBeNull()

      // And the reader is told what the tag will do *before* the question is asked, since after it
      // an answer over one file reads exactly like one over three.
      expect(await fresh.$eval('.composer-area .scope', (el) => el.textContent ?? '')).toContain(
        'db.ts — only these go to the model',
      )
    } finally {
      await fresh.close()
    }
  })

  it('opens the conversation over the tagged file alone', async () => {
    const fresh = await taggingPage()
    try {
      await fresh.type('.composer textarea', 'is @db.ts trusted?')
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 400))

      const code = await openingTurn(fresh)
      expect(code).toContain('`db.ts`')
      expect(code).not.toContain('`app.ts`')
      expect(code).not.toContain('unrelated.ts')
      // Told it is a selection, too: the brief asks it to say when an answer needs code it cannot
      // see, which it cannot judge if the listing claims to be the whole editor.
      expect(code).toContain('not all of it')

      expect(await fresh.$eval('.chat-pane .clipped', (el) => el.textContent ?? '')).toContain(
        'only the file the question names (db.ts)',
      )
    } finally {
      await fresh.close()
    }
  })

  it('leaves an untagged question over every open tab', async () => {
    const fresh = await taggingPage()
    try {
      await fresh.type('.composer textarea', 'what does this do?')
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 400))

      const code = await openingTurn(fresh)
      for (const name of ['app.ts', 'db.ts', 'auth.ts', 'unrelated.ts'])
        expect(code).toContain(`\`${name}\``)
      expect(await fresh.$('.chat-pane .clipped')).toBeNull()
    } finally {
      await fresh.close()
    }
  })

  it('adds a tagged file to a running conversation, and sends no file twice', async () => {
    // A session carries the code it was built with, so a later tag cannot re-scope it — what it
    // can do is add. The reader sees the question they typed; the model gets that question with
    // the file it did not have in front of it, and a pointer for the one it did.
    const fresh = await taggingPage()
    try {
      await fresh.type('.composer textarea', 'is @db.ts trusted?')
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await openingTurn(fresh)).not.toContain('allow')

      await fresh.type('.composer textarea', 'what about @auth.ts and @db.ts?')
      expect(await fresh.$eval('.composer-area .scope', (el) => el.textContent ?? '')).toContain(
        'auth.ts will be added to this chat; db.ts is already in it',
      )
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 400))

      const asked = await fresh.evaluate(() => (window as unknown as { __asked: string[] }).__asked)
      // The first question went as typed; the second carries the one file it needed.
      expect(asked[0]).toBe('is @db.ts trusted?')
      expect(asked[1]).toContain('One more file from the editor, which you did not have before')
      expect(asked[1]).toContain('1 | export const allow = true')
      expect(asked[1]).toContain('You already have `db.ts`')
      // Not a second copy of what it already holds.
      expect(asked[1]).not.toContain('process.env.SEED')
      // And the question itself is still at the end of it, tags and all.
      expect(asked[1]!.endsWith('what about @auth.ts and @db.ts?')).toBe(true)

      // What the reader sees is what the reader wrote — none of the above.
      expect(
        await fresh.$$eval('.chat-pane .message.user .text', (nodes) =>
          nodes.map((node) => node.textContent ?? ''),
        ),
      ).toEqual(['is @db.ts trusted?', 'what about @auth.ts and @db.ts?'])

      // And the conversation now carries both, which the status line has to say.
      expect(await fresh.$eval('.chat-pane .clipped', (el) => el.textContent ?? '')).toContain(
        'only the 2 files the question names (db.ts, auth.ts)',
      )
    } finally {
      await fresh.close()
    }
  })

  it('points a model that reads its own files at the tags, and hands it none of them', async () => {
    // The other half of the feature. There is nothing to save by choosing for a model that can
    // open a file itself, and narrowing what it may open would take away the one thing the tool
    // path has — so it keeps the index of every tab and is told where to start.
    const fresh = await taggingPage(function () {
      localStorage.setItem('codeview:local-server-url', 'http://localhost:11434/v1')
      localStorage.setItem(
        'codeview:local-server-models',
        JSON.stringify([{ model: 'tooled', label: 'Tooled', thinking: false, tools: true }]),
      )
      const originalFetch = window.fetch.bind(window)
      ;(window as unknown as { __inputs: unknown[] }).__inputs = []
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (!url.includes('11434')) return originalFetch(input, init)
        if (url.endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'tooled' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        ;(window as unknown as { __inputs: unknown[] }).__inputs.push(
          JSON.parse(String(init?.body)),
        )
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"content":"Read it."},"finish_reason":"stop"}]}\n\n',
                ),
              )
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            },
          }),
          { status: 200 },
        )
      }) as typeof window.fetch
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 600))
      await fresh.select('.model', 'local:tooled')
      await new Promise((resolve) => setTimeout(resolve, 300))

      await fresh.type('.composer textarea', 'is @db.ts trusted?')
      expect(await fresh.$eval('.composer-area .scope', (el) => el.textContent ?? '')).toContain(
        'the rest can still be read',
      )
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 500))

      const sent = await fresh.evaluate(
        () =>
          (
            window as unknown as {
              __inputs: { messages: { role: string; content: string }[]; tools?: unknown[] }[]
            }
          ).__inputs[0]!,
      )
      const opening = sent.messages.find(
        (message, index) => index > 0 && message.role === 'user',
      )!.content
      // Every tab is still listed and still readable — and the tagged one is where to start.
      expect(opening).toContain('`unrelated.ts`')
      expect(opening).toContain('The question names `db.ts` — read them with read_file')
      // The index, not the code: nothing was handed over.
      expect(opening).not.toContain('process.env.SEED')
      expect(sent.tools).toHaveLength(2)
      // Nothing was withheld, so there is nothing to warn about — which is exactly what makes the
      // tool path worth taking.
      expect(await fresh.$('.chat-pane .clipped')).toBeNull()

      // And a tag on a *follow-up* needs no file either: this conversation withheld nothing, so
      // the tag is a pointer at something the model can already open for itself.
      await fresh.type('.composer textarea', 'and @auth.ts?')
      expect(await fresh.$eval('.composer-area .scope', (el) => el.textContent ?? '')).toContain(
        'auth.ts — the model is told to read it',
      )
      await fresh.click('.composer .send')
      await new Promise((resolve) => setTimeout(resolve, 500))

      const second = await fresh.evaluate(() =>
        (
          window as unknown as { __inputs: { messages: { role: string; content: string }[] }[] }
        ).__inputs.at(-1)!,
      )
      const question = second.messages.at(-1)!.content
      expect(question).toContain('The question names `auth.ts` — read it before you answer.')
      expect(question).not.toContain('export const allow')
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

  it('runs the team over a trace, over the files it cites', async () => {
    // The trace pane's second button. Same question as the chat's, same files — what differs is
    // that a line of agents reads them instead of one conversation.
    const bundle = [
      '--8<-- app.ts',
      "import { read } from './db'",
      'const raw = read()',
      'const out = raw',
      '--8<-- db.ts',
      'export function read() {',
      '  return process.env.SEED',
      '}',
      '--8<-- unrelated.ts',
      "export const nothing = 'to do with this trace'",
    ].join('\n')
    const fresh = await agentsPage(`#files=${encodeURIComponent(bundle)}&active=app.ts`)
    try {
      const tabs = await fresh.$$('.tabs button')
      await tabs[1]!.click()
      await fresh.waitForSelector('.trace-pane')
      await clickAt('const out = raw', 12, 0, fresh)
      await fresh.click('.trace-pane .run')
      await new Promise((resolve) => setTimeout(resolve, 200))

      await fresh.click('.trace-pane .analyze.agents')
      await fresh.waitForSelector('.agents-pane')
      await new Promise((resolve) => setTimeout(resolve, 1200))

      // The run opens with the trace as the task, so what was asked is in the transcript.
      const task = await stepText(fresh, '.step.task')
      expect(task[0]).toContain('Analyze this trace.')
      expect(task[0]).toContain('Backward trace of variable `raw`')

      // Every agent was given the traced files and not the third tab — one snapshot, so the
      // narrowing serves the whole run.
      const listings = await fresh.evaluate(() =>
        (window as unknown as { __sessions: { role: string; content: string }[][] }).__sessions
          .flat()
          .filter((message) => message.role === 'user' && message.content.includes('```'))
          .map((message) => message.content),
      )
      expect(listings.length).toBeGreaterThan(0)
      for (const listing of listings) {
        expect(listing).toContain('`app.ts`')
        expect(listing).toContain('`db.ts`')
        expect(listing).not.toContain('unrelated.ts')
        // And told it is a selection: the brief asks it to say when an answer needs code it
        // cannot see, which it cannot judge if the listing claims to be the whole editor.
        expect(listing).toContain('not all of it')
      }

      // The reader is told the same thing on every agent's row.
      expect((await stepText(fresh, '.clipped')).join(' ')).toContain(
        'only the 2 files the question names (app.ts, db.ts)',
      )

      // And the transcript is at its end rather than at the top of the task, which is a whole
      // trace and was filed before this pane existed.
      const scrolled = await fresh.$eval('.agents-pane .body', (el) => ({
        overflows: el.scrollHeight > el.clientHeight,
        atEnd: Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2,
      }))
      expect(scrolled.overflows).toBe(true)
      expect(scrolled.atEnd).toBe(true)
    } finally {
      await fresh.close()
    }
  })

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
        'Adversarial Triage sees every open file',
      ])
    } finally {
      await fresh.close()
    }
  })

  it('narrows a run to the files the task names, and says so on the roster', async () => {
    // The agents' box has no equivalent of the chat's catch: the task *is* the run's scope, read
    // when Run is pressed, so rewriting the box rewrites the selection.
    const bundle = [
      '--8<-- app.ts',
      "const raw = 'seed'",
      '--8<-- db.ts',
      'export const query = 1',
      '--8<-- unrelated.ts',
      "export const nothing = 'to do with this run'",
    ].join('\n')
    const fresh = await agentsPage(`#files=${encodeURIComponent(bundle)}&active=app.ts`)
    try {
      await fresh.$eval('.composer textarea', (el) => {
        const box = el as HTMLTextAreaElement
        box.value = 'Check @db.ts only.'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      // The roster says what each agent will actually be shown, before the run rather than after.
      expect(await pipelineRows(fresh)).toEqual([
        'Orchestrator briefs each agent · never sees the code',
        'Review sees the file the task names',
        'Adversarial Triage sees the file the task names',
      ])
      expect(await fresh.$eval('.composer-area .scope', (el) => el.textContent ?? '')).toContain(
        'db.ts — only these go to the model',
      )

      await fresh.click('.composer .send')
      await fresh.waitForSelector('.step.summary', { timeout: 15_000 })

      const listings = await fresh.evaluate(() =>
        (window as unknown as { __sessions: { role: string; content: string }[][] }).__sessions
          .flat()
          .filter((message) => message.role === 'user' && message.content.includes('```'))
          .map((message) => message.content),
      )
      expect(listings.length).toBeGreaterThan(0)
      for (const listing of listings) {
        expect(listing).toContain('`db.ts`')
        expect(listing).not.toContain('`app.ts`')
        expect(listing).not.toContain('unrelated.ts')
      }
      expect((await stepText(fresh, '.clipped')).join(' ')).toContain(
        'only the file the question names (db.ts)',
      )
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

      // An agent's report is the bulk of the run, so it arrives open rather than folded — a reader
      // watching a review wants to see the findings, not a row of summaries to click through.
      expect(
        await fresh.$$eval('.step.agent details.report', (nodes) =>
          nodes.map((node) => (node as HTMLDetailsElement).open),
        ),
      ).toEqual([true, true])

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

      // The reader loses nothing — the thinking is folded into the row that produced it, itself
      // rendered as markdown now rather than as a raw block of text.
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
    try {
      // The shipped team is not worth a parameter: it is what every reader gets anyway.
      expect(await copyLink(fresh)).not.toContain('agents=')

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
      expect(await copyLink(fresh)).toMatch(/agents=z\./)
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
      expect(await names()).toEqual(['Review', 'Adversarial Triage'])

      await fresh.click('.team-editor .add')
      expect(await names()).toEqual(['Review', 'Adversarial Triage', 'Agent 3'])

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

  it('starts an agent from a hunting brief, which then travels as its own', async () => {
    const fresh = await agentsPage()
    try {
      await fresh.click('.prompt')
      // Both shipped briefs are in the same shelf as the hunters: a team is built out of both —
      // one agent hunting a class, another ruling on what it reported.
      expect(
        await fresh.$$eval('.team-editor .template', (nodes) =>
          nodes.map((node) => (node as HTMLSelectElement).value),
        ),
      ).toEqual(['Full taint review', 'Adversarial triage'])

      await fresh.$$eval('.team-editor .template', (nodes) => {
        const select = nodes[0] as HTMLSelectElement
        select.value = 'SQL & NoSQL injection'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(
        await fresh.$$eval('.team-editor .prompt-text', (nodes) =>
          (nodes[1] as HTMLTextAreaElement).value.slice(0, 120),
        ),
      ).toContain('SQL & NoSQL injection')

      await fresh.$$eval('.team-editor .name', (nodes) => {
        const box = nodes[0] as HTMLInputElement
        box.value = 'SQLi'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await fresh.click('.team-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await pipelineRows(fresh)).toEqual([
        'Orchestrator briefs each agent · never sees the code',
        'SQLi sees every open file',
        'Adversarial Triage sees every open file',
      ])

      // From here it is an ordinary brief of the reader's: stored, and round-tripped through the
      // `--8<--` bundle a team link is made of.
      const stored = await fresh.evaluate(() => localStorage.getItem('codeview:agents'))
      expect(stored).toContain('--8<-- SQLi\n')
      expect(stored).toContain('bound value')
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
      const hash = await copyLink(fresh)
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

  it('stops and complains about a missing OpenRouter key rather than a generic failure', async () => {
    const fresh = await agentsPage()
    try {
      await fresh.click('.prompt')
      await fresh.$$eval('.team-editor .agent-model', (nodes) => {
        const select = nodes[1] as HTMLSelectElement
        select.value = 'openrouter-gpt-4o-mini'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await fresh.click('.team-editor .save')
      await new Promise((resolve) => setTimeout(resolve, 200))

      await fresh.$eval('.composer textarea', (el) => {
        const box = el as HTMLTextAreaElement
        box.value = 'Check the routes.'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await fresh.click('.composer .send')
      await fresh.waitForSelector('.step.failed', { timeout: 15_000 })

      // Specific to the missing key — not "cannot run in this browser" (it can, once one is set)
      // and not a raw fetch error, since the key is checked before any request is attempted.
      const failed = await fresh.$eval('.step.failed .text', (el) => el.textContent)
      expect(failed).toContain('needs an OpenRouter API key')
    } finally {
      await fresh.close()
    }
  })
})

/**
 * A dropped folder, which is the one half of opening files that no unit test can reach: the walk
 * runs on `FileSystemEntry` handles taken out of a live `DataTransfer`, and Puppeteer cannot drag a
 * real directory onto the page. So the entries are synthesised — faithfully to the two things about
 * the API that actually bite. `readEntries` hands back a **batch at a time** and ends with an empty
 * one, so the fake hands over one child per call; and a `DataTransfer` is dead by the first await,
 * which is why `filesFromDrop` takes every entry synchronously and why this breaks if it stops.
 */
describe('dropping a folder', () => {
  /** A tree as plain data, so it crosses into the page without being stringified as code. */
  interface Entry {
    name: string
    text?: string
    children?: Entry[]
  }

  /** Drop `tree` on the editor pane and report what the strip and the notice say afterwards. */
  async function dropTree(
    tree: Entry | null,
  ): Promise<{ tabs: (string | undefined)[]; notice: string | null }> {
    const fresh = await browser.newPage()
    try {
      await fresh.setViewport({ width: 1400, height: 1000 })
      await fresh.evaluateOnNewDocument(() => localStorage.clear())
      await fresh.goto(URL, { waitUntil: 'networkidle0' })
      await fresh.waitForSelector('.view-line')
      await new Promise((resolve) => setTimeout(resolve, 500))

      return await fresh.evaluate(async (root: Entry | null) => {
        const entryFor = (node: Entry): unknown =>
          node.children
            ? {
                isFile: false,
                isDirectory: true,
                name: node.name,
                createReader: () => {
                  const children = node.children!.map(entryFor)
                  let at = 0
                  return {
                    readEntries: (ok: (batch: unknown[]) => void) =>
                      ok(at < children.length ? [children[at++]] : []),
                  }
                },
              }
            : {
                isFile: true,
                isDirectory: false,
                name: node.name,
                file: (ok: (file: File) => void) => ok(new File([node.text ?? ''], node.name)),
              }

        const event = new Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperty(event, 'dataTransfer', {
          value: {
            // A null tree is a drop carrying no files at all — a selection dragged about inside the
            // editor, which bubbles a `drop` up here too.
            items: root
              ? [{ kind: 'file', webkitGetAsEntry: () => entryFor(root) }]
              : [{ kind: 'string', type: 'text/plain' }],
            files: [],
          },
        })
        document.querySelector('.editor-pane')!.dispatchEvent(event)
        await new Promise((resolve) => setTimeout(resolve, 900))

        return {
          tabs: [...document.querySelectorAll('.tab .file-name')].map((node) =>
            node.textContent?.trim(),
          ),
          notice: document.querySelector('.notice')?.textContent?.trim() ?? null,
        }
      }, tree)
    } finally {
      await fresh.close()
    }
  }

  it('walks the subfolders, skips what it cannot read, and names the tabs by path', async () => {
    const result = await dropTree({
      name: 'proj',
      children: [
        { name: 'app.ts', text: "import { load } from './lib/db'\nexport const a = load()\n" },
        { name: 'README.md', text: '# not source\n' },
        { name: 'node_modules', children: [{ name: 'index.js', text: 'module.exports = 1' }] },
        { name: '.git', children: [{ name: 'hook.js', text: 'nope' }] },
        {
          name: 'lib',
          children: [
            { name: 'db.ts', text: 'export function load() {\n  return 1\n}\n' },
            { name: 'notes.txt', text: 'nope' },
          ],
        },
      ],
    })

    // `proj` itself is gone from every name — every file shared it — and the nested one keeps the
    // path that makes `./lib/db` resolve to it. The markdown, the text file, `node_modules` and
    // `.git` are all simply absent, and said nothing: that is what skipping means here.
    expect(result.tabs).toEqual(['example.ts', 'app.ts', 'lib/db.ts'])
    expect(result.notice).toBeNull()
  })

  it('says so when a folder holds nothing it can read, rather than doing nothing in silence', async () => {
    const result = await dropTree({
      name: 'docs',
      children: [{ name: 'guide.md', text: '# hi\n' }],
    })
    expect(result.tabs).toEqual(['example.ts'])
    expect(result.notice).toBe('Nothing opened — no files this viewer can parse in there.')
  })

  it('ignores a drop that carries no files at all', async () => {
    const result = await dropTree(null)
    expect(result.tabs).toEqual(['example.ts'])
    expect(result.notice).toBeNull()
  })
})

/**
 * Quick open. The keyboard route is the whole feature, and two things about it can only be seen in a
 * browser: the gesture has to survive Monaco having focus — it is registered on `window` in the
 * capture phase for that reason — and Cmd+P is the browser's own print shortcut, so the same handler
 * has to be the one that swallows it.
 */
describe('quick open', () => {
  async function palettePage(): Promise<Page> {
    const fresh = await browser.newPage()
    await fresh.setViewport({ width: 1400, height: 1000 })
    await fresh.evaluateOnNewDocument(() => localStorage.clear())
    await fresh.goto(URL, { waitUntil: 'networkidle0' })
    await fresh.waitForSelector('.view-line')
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Three more tabs, one of them nested, so there is something to search and a path to match in.
    await fresh.evaluate(async () => {
      const file = (name: string, text: string) => ({
        isFile: true,
        isDirectory: false,
        name,
        file: (ok: (given: File) => void) => ok(new File([text], name)),
      })
      const dir = (name: string, children: unknown[]) => ({
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => {
          let at = 0
          return {
            readEntries: (ok: (batch: unknown[]) => void) =>
              ok(at < children.length ? [children[at++]] : []),
          }
        },
      })
      const event = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          items: [
            {
              kind: 'file',
              webkitGetAsEntry: () =>
                dir('proj', [
                  file('handler.ts', 'export const h = 1\n'),
                  dir('lib', [
                    file('store.ts', 'export const s = 2\n'),
                    file('db.ts', 'export const d = 3\n'),
                  ]),
                ]),
            },
          ],
          files: [],
        },
      })
      document.querySelector('.editor-pane')!.dispatchEvent(event)
      await new Promise((resolve) => setTimeout(resolve, 900))
    })
    return fresh
  }

  async function quickOpenKey(target: Page): Promise<void> {
    await target.keyboard.down('Meta')
    await target.keyboard.press('KeyP')
    await target.keyboard.up('Meta')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  const rows = (target: Page) =>
    target.$$eval('.quick-open .result .name', (nodes) =>
      nodes.map((node) => node.textContent?.trim()),
    )

  const armed = (target: Page) =>
    target.$eval('.quick-open .result.armed .name', (el) => el.textContent?.trim())

  const activeTab = (target: Page) =>
    target.$eval('.tab.active .file-name', (el) => el.textContent?.trim())

  it('opens over the editor, filters as you type, and marks what matched', async () => {
    const fresh = await palettePage()
    try {
      // Focus inside Monaco first: this is the case a listener on the editor's own node would win
      // and one bound anywhere but the capture phase would lose.
      await fresh.click('.editor')
      await quickOpenKey(fresh)
      expect(await fresh.$('.quick-open')).not.toBeNull()

      await fresh.keyboard.type('lbdb')
      await new Promise((resolve) => setTimeout(resolve, 200))
      // A subsequence, not a substring: `lbdb` threads through `lib/db.ts` and nothing else.
      expect(await rows(fresh)).toEqual(['lib/db.ts'])
      expect(
        await fresh.$$eval('.quick-open .result.armed .hit', (nodes) =>
          nodes.map((node) => node.textContent),
        ),
      ).toEqual(['l', 'b', 'db'])

      await fresh.keyboard.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await fresh.$('.quick-open')).toBeNull()
      expect(await activeTab(fresh)).toBe('lib/db.ts')
      // The keyboard is handed back to the buffer, so the palette is not a detour.
      expect(await fresh.evaluate(() => document.activeElement?.closest('.editor') !== null)).toBe(
        true,
      )
    } finally {
      await fresh.close()
    }
  })

  /** The reason the list is ordered by recency at all: Cmd+P then Enter is a toggle between the two
   *  files you are working in, which is the gesture readers arrive expecting. */
  it('arms the file you were in before, so Cmd+P and Enter toggles between two', async () => {
    const fresh = await palettePage()
    try {
      await fresh.click('.editor')
      await quickOpenKey(fresh)
      await fresh.keyboard.type('handler')
      await new Promise((resolve) => setTimeout(resolve, 150))
      await fresh.keyboard.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await activeTab(fresh)).toBe('handler.ts')

      await quickOpenKey(fresh)
      // The tab on screen heads the list — arming it would make Enter do nothing — so the row below
      // it is armed instead.
      expect((await rows(fresh))[0]).toBe('handler.ts')
      expect(await armed(fresh)).toBe('lib/db.ts')
      await fresh.keyboard.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await activeTab(fresh)).toBe('lib/db.ts')

      await quickOpenKey(fresh)
      expect(await armed(fresh)).toBe('handler.ts')
      await fresh.keyboard.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await activeTab(fresh)).toBe('handler.ts')
    } finally {
      await fresh.close()
    }
  })

  it('walks the list, says when nothing matches, and dismisses without picking', async () => {
    const fresh = await palettePage()
    try {
      await fresh.click('.editor')
      await quickOpenKey(fresh)
      await fresh.keyboard.press('ArrowDown')
      await fresh.keyboard.press('ArrowDown')
      const walked = await armed(fresh)
      await fresh.keyboard.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await activeTab(fresh)).toBe(walked)

      // A query nothing answers says so, and Enter on it holds rather than dismissing: mid-word is
      // far likelier than a request to close.
      await quickOpenKey(fresh)
      await fresh.keyboard.type('zzzz')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await fresh.$eval('.quick-open .empty', (el) => el.textContent?.trim())).toBe(
        'No open file matches that.',
      )
      await fresh.keyboard.press('Enter')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await fresh.$('.quick-open')).not.toBeNull()

      const before = await activeTab(fresh)
      await fresh.keyboard.press('Escape')
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(await fresh.$('.quick-open')).toBeNull()
      expect(await activeTab(fresh)).toBe(before)

      // And the same key closes it again, so the gesture is a toggle in both directions.
      await quickOpenKey(fresh)
      expect(await fresh.$('.quick-open')).not.toBeNull()
      await quickOpenKey(fresh)
      expect(await fresh.$('.quick-open')).toBeNull()
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
