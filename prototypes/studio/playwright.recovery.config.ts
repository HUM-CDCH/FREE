import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import { configurePlaywrightStack, playwrightWebServerCommand } from './e2e/playwrightStack.js'

/**
 * The recovery tier: one worker, a restartable Studio (its specs SIGKILL Vite under an open page and the wrapper
 * spawns it again), Studio's data and log under artifacts/recovery-tests so the planted-key sweep can read them.
 */
const stack = configurePlaywrightStack({
  applicationPort: 41_771,
  composeProject: 'free-studio-recovery-e2e',
  databaseName: 'free_test_studio_recovery',
  oidcPort: 41_772,
  postgresPort: 45_436,
})
const origin = `http://localhost:${stack.applicationPort}`
const recoveryTests = resolve(import.meta.dirname, '../../artifacts/recovery-tests')
const state = resolve(recoveryTests, 'state')
mkdirSync(state, { recursive: true })
// A kei stand-in port of its own (the default suite's is 29750), below the ephemeral and Compose lease ranges.
process.env.FREE_PLAYWRIGHT_KEI_EXP_URL = 'http://127.0.0.1:29751'
process.env.FREE_PLAYWRIGHT_SOURCE_INBOX = resolve(state, 'source-inbox')
// Workers read these too: their package store writes where Studio reads, and the sweep scans Studio's data directory
// and its log.
process.env.XDG_DATA_HOME = state
process.env.FREE_PLAYWRIGHT_RECOVERY_STATE = state
process.env.FREE_PLAYWRIGHT_STUDIO_LOG = resolve(recoveryTests, 'studio.log')

export default defineConfig({
  testDir: './e2e',
  testMatch: ['interactive-restart.spec.ts', 'source-ingestion-restart.spec.ts'],
  outputDir: resolve(recoveryTests, 'results'),
  workers: 1,
  timeout: 300_000,
  globalTeardown: './e2e/globalTeardown.ts',
  use: { baseURL: origin },
  webServer: {
    command: playwrightWebServerCommand,
    url: origin,
    timeout: 300_000,
    env: {
      DATABASE_URL: stack.databaseUrl,
      KEI_EXP_URL: process.env.FREE_PLAYWRIGHT_KEI_EXP_URL,
      FREE_SOURCE_INBOX: process.env.FREE_PLAYWRIGHT_SOURCE_INBOX,
      FREE_PLAYWRIGHT_LIFECYCLE_ID: stack.lifecycleId,
      FREE_PLAYWRIGHT_RESTARTABLE: '1',
      FREE_PLAYWRIGHT_STUDIO_LOG: process.env.FREE_PLAYWRIGHT_STUDIO_LOG,
      // Pinned for the run, as production pins it in .env: a dev server without one signs a fresh secret per process,
      // and the restarted Studio would sign every open page out.
      FREE_SESSION_SECRET: randomBytes(32).toString('base64'),
      STUDIO_ORIGIN: origin,
      STUDIO_BASE_PATH: '/',
      XDG_DATA_HOME: state,
      FREE_ENTRA_REAL: '0',
      FREE_ENTRA_MOCK_ISSUER: stack.oidcIssuer,
      FREE_ENTRA_MOCK_BROWSER_ISSUER: stack.oidcIssuer,
    },
  },
})
