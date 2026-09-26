import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'
import {
  configurePlaywrightStack,
  playwrightWebServerCommand,
} from './e2e/playwrightStack.js'

const stack = configurePlaywrightStack({
  applicationPort: 41_751,
  composeProject: 'free-studio-e2e-base-path',
  databaseName: 'free_test_studio_base_path',
  oidcPort: 41_752,
  postgresPort: 45_433,
})
const port = stack.applicationPort
const origin = `http://localhost:${port}`
const basePath = '/free'
process.env.FREE_PLAYWRIGHT_BASE_PATH = basePath
// The lifecycle spec's fake kei-exp listens here, and Studio's KEI_EXP_URL points at it. The default suite's
// fixture keeps 29750, so the two suites' ports are distinct; both sit outside the ephemeral range (see
// playwright.config.ts). The suites still share the output directory test-results/, so they must run sequentially.
const keiExpUrl = 'http://127.0.0.1:29753'
process.env.FREE_PLAYWRIGHT_KEI_EXP_URL = keiExpUrl
// Studio stages uploads for kei in its source inbox (FREE_SOURCE_INBOX): one directory per run. Workers load this
// config too; they inherit the variable, so only the runner makes the directory.
process.env.FREE_PLAYWRIGHT_SOURCE_INBOX ??= mkdtempSync(join(tmpdir(), 'free-e2e-source-inbox-'))

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
      KEI_EXP_URL: keiExpUrl,
      FREE_SOURCE_INBOX: process.env.FREE_PLAYWRIGHT_SOURCE_INBOX,
      FREE_PLAYWRIGHT_LIFECYCLE_ID: stack.lifecycleId,
      STUDIO_ORIGIN: origin,
      STUDIO_BASE_PATH: basePath,
      FREE_ENTRA_REAL: '0',
      FREE_ENTRA_MOCK_ISSUER: stack.oidcIssuer,
      FREE_ENTRA_MOCK_BROWSER_ISSUER: stack.oidcIssuer,
    },
  },
})
