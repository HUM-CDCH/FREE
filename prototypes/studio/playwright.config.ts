import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const e2eConfigHome = resolve(import.meta.dirname, 'test-results/config-home')
const e2ePort = Number(process.env.FREE_PLAYWRIGHT_PORT ?? 41749)
if (!Number.isSafeInteger(e2ePort) || e2ePort < 1 || e2ePort > 65_535)
  throw new Error('FREE_PLAYWRIGHT_PORT must be a valid TCP port.')
const e2eOrigin = `http://localhost:${e2ePort}`
const browserOnlyAuthentication =
  !process.env.EXTRACTION_TEST_DATABASE_URL && !process.env.SCHEMA_ORDER_E2E

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: e2eOrigin },
  webServer: {
    command: `pnpm dev --port ${e2ePort}`,
    url: e2eOrigin,
    reuseExistingServer: false,
    // Focused lifecycle runs pass a disposable database; browser-only specs use
    // the fallback URL but do not reach it.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/free',
      STUDIO_ORIGIN: e2eOrigin,
      STUDIO_BASE_PATH: '/',
      APPDATA: e2eConfigHome,
      XDG_CONFIG_HOME: e2eConfigHome,
      ...(browserOnlyAuthentication
        ? {
            FREE_PLAYWRIGHT_RESEARCHER_EMAIL:
              'browser-fixture@example.test',
            FREE_PLAYWRIGHT_RESEARCHER_PASSWORD:
              'E2E authentication password 123!',
          }
        : {}),
    },
  },
})
