import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/e2e/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Puppeteer drives one shared page; parallel files would fight over it.
    fileParallelism: false,
  },
})
