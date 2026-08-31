import { defineConfig } from 'vitest/config'

// Unit tests only. The browser suite needs a real Chromium and lives in tests/e2e —
// see vitest.e2e.config.ts and `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['tests/*.test.ts'],
  },
})
