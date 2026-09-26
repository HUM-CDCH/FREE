import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'
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
const e2ePort = stack.applicationPort
const e2eOrigin = `http://localhost:${e2ePort}`
// The lifecycle spec's fake kei-exp listens here, and Studio's KEI_EXP_URL points at it. It binds mid-run, while
// the browsers hold many outbound sockets, so it sits below Linux's ephemeral range (32768-60999) and the
// Compose lease range (30000-39999): a client socket holding the port as its source would fail it with EADDRINUSE.
const keiExpUrl = 'http://127.0.0.1:29750'
process.env.FREE_PLAYWRIGHT_KEI_EXP_URL = keiExpUrl
// Studio stages uploads for kei in its source inbox (FREE_SOURCE_INBOX): one directory per run. Workers load this
// config too; they inherit the variable, so only the runner makes the directory.
process.env.FREE_PLAYWRIGHT_SOURCE_INBOX ??= mkdtempSync(join(tmpdir(), 'free-e2e-source-inbox-'))

export default defineConfig({
  testDir: './e2e',
  // The restart spec runs on the recovery config's restartable Studio (playwright.recovery.config.ts).
  testIgnore: ['real-service.spec.ts', 'interactive-restart.spec.ts'],
  fullyParallel: true,
  globalTeardown: './e2e/globalTeardown.ts',
  use: { baseURL: e2eOrigin },
  webServer: {
    command: playwrightWebServerCommand,
    url: e2eOrigin,
    env: {
      DATABASE_URL: stack.databaseUrl,
      KEI_EXP_URL: keiExpUrl,
      FREE_SOURCE_INBOX: process.env.FREE_PLAYWRIGHT_SOURCE_INBOX,
      FREE_PLAYWRIGHT_LIFECYCLE_ID: stack.lifecycleId,
      STUDIO_ORIGIN: e2eOrigin,
      STUDIO_BASE_PATH: '/',
      FREE_ENTRA_REAL: '0',
      FREE_ENTRA_MOCK_ISSUER: stack.oidcIssuer,
      FREE_ENTRA_MOCK_BROWSER_ISSUER: stack.oidcIssuer,
    },
  },
})
