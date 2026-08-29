import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
import {
  configurePlaywrightStack,
  playwrightWebServerCommand,
} from './e2e/playwrightStack.js'

const stack = configurePlaywrightStack({
  applicationPort: 41_750,
  composeProject: 'free-studio-e2e-base-path',
  databaseName: 'free_test_studio_base_path',
  oidcPort: 41_752,
  postgresPort: 45_433,
})
const port = stack.applicationPort
const origin = `http://localhost:${port}`
const basePath = '/free'
process.env.FREE_PLAYWRIGHT_BASE_PATH = basePath

export default defineConfig({
  testDir: './e2e',
  testMatch: 'canonical-evidence-lifecycle.spec.ts',
  workers: 1,
  globalTeardown: './e2e/globalTeardown.ts',
  use: { baseURL: origin },
  webServer: {
    command: playwrightWebServerCommand,
    url: `${origin}${basePath}/auth/signed-out`,
    env: {
      DATABASE_URL: stack.databaseUrl,
      FREE_PLAYWRIGHT_LIFECYCLE_ID: stack.lifecycleId,
      STUDIO_ORIGIN: origin,
      STUDIO_BASE_PATH: basePath,
      APPDATA: resolve(import.meta.dirname, 'test-results/config-home'),
      XDG_CONFIG_HOME: resolve(import.meta.dirname, 'test-results/config-home'),
      FREE_ENTRA_REAL: '0',
      FREE_ENTRA_MOCK_ISSUER: stack.oidcIssuer,
      FREE_ENTRA_MOCK_BROWSER_ISSUER: stack.oidcIssuer,
    },
  },
})
