import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const port = Number(process.env.FREE_PLAYWRIGHT_PORT ?? 41751)
const origin = `http://localhost:${port}`
process.env.FREE_PLAYWRIGHT_PORT = String(port)
process.env.FREE_PLAYWRIGHT_DEVELOPER_UI = '1'
delete process.env.FREE_PLAYWRIGHT_BASE_PATH

export default defineConfig({
  testDir: './e2e',
  testMatch: 'developer-ui.spec.ts',
  workers: 1,
  use: { baseURL: origin },
  webServer: {
    command: `pnpm dev --port ${port}`,
    url: origin,
    reuseExistingServer: process.env.FREE_PLAYWRIGHT_REUSE_SERVER === '1',
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/free',
      STUDIO_ORIGIN: origin,
      STUDIO_BASE_PATH: '/',
      APPDATA: resolve(import.meta.dirname, 'test-results/config-home-developer'),
      XDG_CONFIG_HOME: resolve(
        import.meta.dirname,
        'test-results/config-home-developer',
      ),
      FREE_PLAYWRIGHT_RESEARCHER_EMAIL: 'browser-fixture@example.test',
      FREE_PLAYWRIGHT_RESEARCHER_PASSWORD:
        'E2E authentication password 123!',
      VITE_SHOW_DEVELOPER_UI: 'true',
    },
  },
})
