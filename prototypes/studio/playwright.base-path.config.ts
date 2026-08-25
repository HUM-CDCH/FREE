import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const port = Number(process.env.FREE_PLAYWRIGHT_PORT ?? 41750)
const origin = `http://localhost:${port}`
const basePath = '/free'
process.env.FREE_PLAYWRIGHT_PORT = String(port)
process.env.FREE_PLAYWRIGHT_BASE_PATH = basePath

export default defineConfig({
  testDir: './e2e',
  testMatch: 'canonical-evidence-lifecycle.spec.ts',
  workers: 1,
  use: { baseURL: origin },
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: `${origin}${basePath}/login`,
    reuseExistingServer: process.env.FREE_PLAYWRIGHT_REUSE_SERVER === '1',
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/free',
      STUDIO_ORIGIN: origin,
      STUDIO_BASE_PATH: basePath,
      APPDATA: resolve(import.meta.dirname, 'test-results/config-home'),
      XDG_CONFIG_HOME: resolve(import.meta.dirname, 'test-results/config-home'),
    },
  },
})
