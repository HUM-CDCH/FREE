import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'
import {
  configurePlaywrightStack,
  playwrightWebServerCommand,
} from './e2e/playwrightStack.js'

const stack = configurePlaywrightStack({
  applicationPort: 30_781,
  composeProject: 'free-studio-e2e-unified-catalog',
  databaseName: 'free_test_studio_unified_catalog',
  oidcPort: 30_782,
  postgresPort: 31_437,
})
const origin = `http://localhost:${stack.applicationPort}`
// The unified Catalog's rollout gate, on as a deployment sets it: in Studio's environment, and in the runner's, which
// the workers inherit, so the spec's own gate check runs it.
process.env.FREE_CATALOG_METHOD = 'unified'
// No spec here reaches kei; the address only has to differ from the other suites' (see playwright.config.ts).
const keiExpUrl = 'http://127.0.0.1:29755'
// Studio stages uploads for kei in its source inbox (FREE_SOURCE_INBOX): one directory per run. Workers load this
// config too; they inherit the variable, so only the runner makes the directory.
process.env.FREE_PLAYWRIGHT_SOURCE_INBOX ??= mkdtempSync(join(tmpdir(), 'free-e2e-source-inbox-'))

export default defineConfig({
  // CI never runs a suite narrowed by a committed test.only.
  forbidOnly: Boolean(process.env.CI),
  testDir: './e2e',
  testMatch: 'unified-catalog.spec.ts',
  workers: 1,
  globalTeardown: './e2e/globalTeardown.ts',
  use: { baseURL: origin },
  webServer: {
    command: playwrightWebServerCommand,
    url: origin,
    env: {
      DATABASE_URL: stack.databaseUrl,
      KEI_EXP_URL: keiExpUrl,
      FREE_SOURCE_INBOX: process.env.FREE_PLAYWRIGHT_SOURCE_INBOX,
      FREE_PLAYWRIGHT_LIFECYCLE_ID: stack.lifecycleId,
      FREE_CATALOG_METHOD: 'unified',
      STUDIO_ORIGIN: origin,
      STUDIO_BASE_PATH: '/',
      FREE_ENTRA_REAL: '0',
      FREE_ENTRA_MOCK_ISSUER: stack.oidcIssuer,
      FREE_ENTRA_MOCK_BROWSER_ISSUER: stack.oidcIssuer,
    },
  },
})
