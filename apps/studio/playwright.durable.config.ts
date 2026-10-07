import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'
import { configurePlaywrightStack,playwrightWebServerCommand } from './e2e/playwrightStack.js'

const stack=configurePlaywrightStack({applicationPort:41789,composeProject:'free-durable-extraction-e2e',databaseName:'free_test_durable_browser',oidcPort:41788,postgresPort:45439})
const origin=`http://localhost:${stack.applicationPort}`
const browser=process.env.FREE_DURABLE_E2E_BROWSER??'chromium'
if(!['chromium','chrome'].includes(browser))throw new Error('Choose chromium or chrome for durable browser verification.')
// Preserve this stack's paths across runner/worker imports, while ignoring any
// inherited runtime XDG home or another test stack's inbox.
process.env.FREE_DURABLE_E2E_STATE??=mkdtempSync(join(tmpdir(),'free-durable-e2e-state-'))
process.env.FREE_DURABLE_E2E_INBOX??=mkdtempSync(join(tmpdir(),'free-durable-e2e-inbox-'))
for(const [value,prefix] of [[process.env.FREE_DURABLE_E2E_STATE,'free-durable-e2e-state-'],[process.env.FREE_DURABLE_E2E_INBOX,'free-durable-e2e-inbox-']] as const) {
  if(!value?.startsWith(join(tmpdir(),prefix)))throw new Error('Durable browser state must belong to its private disposable stack.')
}
process.env.XDG_DATA_HOME=process.env.FREE_DURABLE_E2E_STATE
process.env.FREE_PLAYWRIGHT_SOURCE_INBOX=process.env.FREE_DURABLE_E2E_INBOX
export default defineConfig({testDir:'./e2e',testMatch:'durable-extraction.spec.ts',workers:1,timeout:120_000,
  globalTeardown:'./e2e/globalTeardown.ts',use:{baseURL:origin,channel:browser==='chrome'?'chrome':undefined,trace:'retain-on-failure',actionTimeout:15_000},
  webServer:{command:playwrightWebServerCommand,url:origin,timeout:180_000,env:{DATABASE_URL:stack.databaseUrl,
    KEI_EXP_URL:'http://127.0.0.1:29789',FREE_SOURCE_INBOX:process.env.FREE_PLAYWRIGHT_SOURCE_INBOX,
    XDG_DATA_HOME:process.env.XDG_DATA_HOME,
    FREE_PLAYWRIGHT_LIFECYCLE_ID:stack.lifecycleId,STUDIO_ORIGIN:origin,STUDIO_BASE_PATH:'/',FREE_ENTRA_REAL:'0',
    FREE_ENTRA_MOCK_ISSUER:stack.oidcIssuer,FREE_ENTRA_MOCK_BROWSER_ISSUER:stack.oidcIssuer}}})
