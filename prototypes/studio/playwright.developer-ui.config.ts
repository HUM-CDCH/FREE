import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
import {
  configurePlaywrightStack,
  playwrightWebServerCommand,
} from './e2e/playwrightStack.js'

const stack = configurePlaywrightStack({
  applicationPort: 41_751,
  composeProject: 'free-studio-e2e-developer-ui',
  databaseName: 'free_test_studio_developer_ui',
  oidcPort: 41_753,
  postgresPort: 45_434,
})
const port = stack.applicationPort
const origin = `http://localhost:${port}`
process.env.FREE_PLAYWRIGHT_DEVELOPER_UI = '1'
delete process.env.FREE_PLAYWRIGHT_BASE_PATH

export default defineConfig({
  testDir: './e2e',
  testMatch: 'developer-ui.spec.ts',
  workers: 1,
  globalTeardown: './e2e/globalTeardown.ts',
  use: { baseURL: origin },
  webServer: {
    command: playwrightWebServerCommand,
    url: origin,
    reuseExistingServer: process.env.FREE_PLAYWRIGHT_REUSE_SERVER === '1',
    env: {
      DATABASE_URL: stack.databaseUrl,
      STUDIO_ORIGIN: origin,
      STUDIO_BASE_PATH: '/',
      APPDATA: resolve(
        import.meta.dirname,
        'test-results/config-home-developer',
      ),
      XDG_CONFIG_HOME: resolve(
        import.meta.dirname,
        'test-results/config-home-developer',
      ),
      FREE_ENTRA_REAL: '0',
      FREE_ENTRA_MOCK_ISSUER: stack.oidcIssuer,
      FREE_ENTRA_MOCK_BROWSER_ISSUER: stack.oidcIssuer,
      VITE_SHOW_DEVELOPER_UI: 'true',
    },
  },
})
