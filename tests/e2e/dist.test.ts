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
})
