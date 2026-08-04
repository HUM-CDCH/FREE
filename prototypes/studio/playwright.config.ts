import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: 'http://localhost:41739' },
  webServer: {
    command: 'pnpm dev --port 41739',
    url: 'http://localhost:41739',
    reuseExistingServer: false,
    // Every persisted read is stubbed in the browser, so no database is reached.
    // The URL only has to parse: without one the store module throws on import
    // and even a request rejected before any read would answer 500, not 422.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/free',
    },
  },
})
