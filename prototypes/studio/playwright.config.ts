import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const e2eConfigHome = resolve(import.meta.dirname, 'test-results/config-home')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: 'http://localhost:41739' },
  webServer: {
    command: 'pnpm dev --port 41739',
    url: 'http://localhost:41739',
    reuseExistingServer: false,
    // Focused lifecycle runs pass a disposable database; browser-only specs use
    // the fallback URL but do not reach it.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/free',
      STUDIO_ORIGIN: 'http://localhost:41739',
      APPDATA: e2eConfigHome,
      XDG_CONFIG_HOME: e2eConfigHome,
    },
  },
})
