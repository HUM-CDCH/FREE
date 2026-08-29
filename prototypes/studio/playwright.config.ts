import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
import {
  configurePlaywrightStack,
  playwrightWebServerCommand,
} from './e2e/playwrightStack.js'

const stack = configurePlaywrightStack({
  applicationPort: 41_749,
  composeProject: 'free-studio-e2e',
  databaseName: 'free_test_studio',
  oidcPort: 41_748,
  postgresPort: 45_432,
})
const e2eConfigHome = resolve(import.meta.dirname, 'test-results/config-home')
const e2ePort = stack.applicationPort
const e2eOrigin = `http://localhost:${e2ePort}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  globalTeardown: './e2e/globalTeardown.ts',
  use: { baseURL: e2eOrigin },
  webServer: {
    command: playwrightWebServerCommand,
    url: e2eOrigin,
    env: {
      DATABASE_URL: stack.databaseUrl,
      FREE_PLAYWRIGHT_LIFECYCLE_ID: stack.lifecycleId,
      STUDIO_ORIGIN: e2eOrigin,
      STUDIO_BASE_PATH: '/',
      APPDATA: e2eConfigHome,
      XDG_CONFIG_HOME: e2eConfigHome,
      FREE_ENTRA_REAL: '0',
      FREE_ENTRA_MOCK_ISSUER: stack.oidcIssuer,
      FREE_ENTRA_MOCK_BROWSER_ISSUER: stack.oidcIssuer,
    },
  },
})
