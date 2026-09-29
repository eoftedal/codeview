import { readdirSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build, preview, type PreviewServer } from 'vite'
import puppeteer, { type Browser, type Page } from 'puppeteer'

/**
 * The dev server is forgiving about how Monaco's workers are loaded; a production bundle is not.
 * This suite builds for real and loads the output, which is the only place that difference shows.
 */
const PORT = 5200

let server: PreviewServer
let browser: Browser
let page: Page
const pageErrors: string[] = []
const wasmResponses: string[] = []

/**
 * Responses that mean the asset was not served. Deliberately not "anything but 200": the runtime
 * glue and the core wasm are cached across the grammar cases below, so the second and third get a
 * legitimate 304. What this exists to catch is a silent 404 — an asset `base: './'` resolved
 * wrongly shows up only as a pane that never fills.
 */
function failedWasm(): string[] {
  return wasmResponses.filter((entry) => Number(entry.slice(0, 3)) >= 400)
}

beforeAll(async () => {
  await build({ logLevel: 'error' })
  server = await preview({ preview: { port: PORT, strictPort: true }, logLevel: 'error' })

  browser = await puppeteer.launch({
    headless: true,
    args: process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  })
  page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 1400 })
  page.on('pageerror', (error) =>
    pageErrors.push(error instanceof Error ? error.message : String(error)),
  )
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })
  page.on('response', (response) => {
    const name = response.url().split('/').pop() ?? ''
    if (/tree-sitter/.test(name)) wasmResponses.push(`${response.status()} ${name}`)
  })

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.row')
  await page.waitForSelector('.view-line')
  // Workers are spawned lazily, so give them a moment to fail if they are going to.
  await new Promise((resolve) => setTimeout(resolve, 3000))
})

afterAll(async () => {
  await browser?.close()
  server?.httpServer.close()
})

describe('production bundle', () => {
  it('bundles both Monaco workers as real chunks', () => {
    // A worker Vite copies as a static asset instead of bundling loses its own relative imports.
    const assets = readdirSync('dist/assets')
    expect(assets.some((name) => name.startsWith('editor.worker'))).toBe(true)
    expect(assets.some((name) => name.startsWith('ts.worker'))).toBe(true)
    // The Python grammar is fetched at runtime from a `?url` asset, so dev — which serves
    // everything from `/` — proves nothing about the build, which runs under `base: './'`. These
    // three are the runtime glue, its wasm, and the grammar.
    expect(assets.some((name) => /^tree-sitter-[^.]+\.js$/.test(name))).toBe(true)
    expect(assets.some((name) => /^tree-sitter-[^.]+\.wasm$/.test(name))).toBe(true)
    expect(assets.some((name) => /^tree-sitter-python-[^.]+\.wasm$/.test(name))).toBe(true)
    expect(assets.some((name) => /^tree-sitter-java-[^.]+\.wasm$/.test(name))).toBe(true)
    // One grammar for C and C++ — tree-sitter-cpp is built as a superset of C's, and the package
    // ships no `tree-sitter-c.wasm` at all.
    expect(assets.some((name) => /^tree-sitter-cpp-[^.]+\.wasm$/.test(name))).toBe(true)
    expect(assets.some((name) => /^tree-sitter-c-sharp-[^.]+\.wasm$/.test(name))).toBe(true)
  })

  it('loads with no console or page errors', () => {
    expect(pageErrors).toEqual([])
  })

  it('renders the editor and the tree', async () => {
    expect(await page.$$eval('.row', (nodes) => nodes.length)).toBeGreaterThan(3)
    expect(await page.$$eval('.view-line', (nodes) => nodes.length)).toBeGreaterThan(10)
  })

  it('still resolves definitions', async () => {
    const point = await page.evaluate(() => {
      // No dev test hook in a production build, and Monaco merges adjacent same-class tokens into
      // one span — so walk the text nodes and range over the exact substring.
      const needle = 'formatAddress'
      let seen = 0
      for (const line of document.querySelectorAll('.view-line')) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = (node.textContent ?? '').indexOf(needle)
          if (index < 0) continue
          if (seen++ < 1) continue // the first hit is the import itself; take the call site
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + needle.length)
          const rect = range.getBoundingClientRect()
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        }
      }
      return null
    })
    expect(point).not.toBeNull()
    await page.mouse.click(point!.x, point!.y)
    await new Promise((resolve) => setTimeout(resolve, 250))

    const definition = await page.$eval(
      '.definition',
      (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    )
    expect(definition).toContain('import `formatAddress`')
  })

  /**
   * The whole runtime path in one case: `base: './'` resolution of three `?url` assets, the
   * dynamic `import()` of a UMD bundle, emscripten's `locateFile`, and `Language.load`. Dev serves
   * everything from `/` and so proves none of it.
   */
  it('fetches and runs the Python grammar', async () => {
    const source = 'greeting = "hi"\ndef greet(name):\n    return name\n'
    // `goto` to a URL that differs only in its fragment is an in-page navigation, so the app is
    // never re-created and never re-reads the link. Reload to actually boot it on this hash.
    await page.goto(`http://localhost:${PORT}/#src=${encodeURIComponent(source)}&lang=py`)
    await page.reload({ waitUntil: 'networkidle0' })
    // The seed buffer parses and renders before the link has been applied, and the grammar is
    // fetched after that — so waiting for `.row` would match the TypeScript tree still on screen.
    await page.waitForFunction(
      () => document.querySelector('.row .kind')?.textContent?.trim() === 'module',
      { timeout: 15_000 },
    )

    const kinds = await page.$$eval('.row .kind', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? ''),
    )
    expect(kinds[0]).toBe('module')
    expect(kinds).toContain('function_definition')

    expect(wasmResponses.length).toBeGreaterThan(0)
    expect(failedWasm()).toEqual([])
  })

  /** The same runtime path for the two grammars added last, and the largest assets in the app. */
  it('fetches and runs the C grammar', async () => {
    const source = 'int add(int a, int b) {\n  return a + b;\n}\n'
    await page.goto(`http://localhost:${PORT}/#src=${encodeURIComponent(source)}&lang=c`)
    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForFunction(
      () => document.querySelector('.row .kind')?.textContent?.trim() === 'translation_unit',
      { timeout: 20_000 },
    )

    const kinds = await page.$$eval('.row .kind', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? ''),
    )
    expect(kinds).toContain('function_definition')
    expect(failedWasm()).toEqual([])
  })

  it('fetches and runs the C# grammar', async () => {
    const source = 'class A {\n  string Greet(string name) { return name; }\n}\n'
    await page.goto(`http://localhost:${PORT}/#src=${encodeURIComponent(source)}&lang=cs`)
    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForFunction(
      () => document.querySelector('.row .kind')?.textContent?.trim() === 'compilation_unit',
      { timeout: 20_000 },
    )

    const kinds = await page.$$eval('.row .kind', (nodes) =>
      nodes.map((node) => node.textContent?.trim() ?? ''),
    )
    // A row the pane has not expanded is not in the DOM, so assert on a depth-1 kind.
    expect(kinds).toContain('class_declaration')
    expect(failedWasm()).toEqual([])
  })
})
