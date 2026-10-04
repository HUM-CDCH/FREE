import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
import { configurePlaywrightStack, playwrightWebServerCommand } from './e2e/playwrightStack.js'

const stack = configurePlaywrightStack({
  applicationPort: 41_761,
  composeProject: 'free-studio-service-e2e',
  databaseName: 'free_test_real_service',
  oidcPort: 41_762,
  postgresPort: 45_435,
})
const origin = `http://localhost:${stack.applicationPort}`
const serviceTests = resolve(import.meta.dirname, '../../artifacts/service-tests')
const state = resolve(serviceTests, 'state')
process.env.FREE_PLAYWRIGHT_SERVICE_URL = 'http://127.0.0.1:41764'
process.env.FREE_PLAYWRIGHT_SOURCE_INBOX = resolve(state, 'source-inbox')

export default defineConfig({
  testDir: './e2e',
  testMatch: ['real-service.spec.ts', 'real-service-gc.spec.ts', 'real-service-reuse.spec.ts', 'real-model-route.spec.ts', 'real-application-route.spec.ts', 'gliformer-route.spec.ts', 'durable-service.spec.ts'],
  outputDir: resolve(serviceTests, 'results'),
  workers: 1,
  timeout: 600_000,
  globalTeardown: './e2e/globalTeardown.ts',
  use: { baseURL: origin, channel: 'chromium' },
  webServer: {
    command: playwrightWebServerCommand,
    url: origin,
    timeout: 300_000,
    env: {
      DATABASE_URL: stack.databaseUrl,
      KEI_EXP_URL: process.env.FREE_PLAYWRIGHT_SERVICE_URL,
      FREE_PLAYWRIGHT_LIFECYCLE_ID: stack.lifecycleId,
      STUDIO_ORIGIN: origin,
      STUDIO_BASE_PATH: '/',
      XDG_DATA_HOME: state,
      // The real kei worker reads staged uploads from here (KEI_SOURCE_INBOX, Task 13).
      FREE_SOURCE_INBOX: process.env.FREE_PLAYWRIGHT_SOURCE_INBOX,
      FREE_ENTRA_REAL: '0',
      FREE_ENTRA_MOCK_ISSUER: stack.oidcIssuer,
      FREE_ENTRA_MOCK_BROWSER_ISSUER: stack.oidcIssuer,
    },
  },
})
