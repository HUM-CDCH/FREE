import { randomUUID } from 'node:crypto'
import { DBOSClient } from '@dbos-inc/dbos-sdk'
import { expect, test, type Page } from '@playwright/test'
import { spawnKeiStandIn, type KeiStandInProcess } from 'extraction/kei-stand-in-client'
import { STUDIO_APPLICATION, STUDIO_SCHEMA } from '../server/dbos.js'
import { blankPdf } from '../test/support/pdf.js'
import { E2E_ORIGIN, e2eStudioPath, loginResearcher } from './auth.js'
import { admit, settle } from './sourceIngestion.js'
import { killStudio } from './studioRestart.js'

// One restartable Studio (playwright.recovery.config.ts): the specs kill it under an open page, one at a time.
test.describe.configure({ mode: 'serial' })

const headers = { Origin: E2E_ORIGIN }
const databaseReady = () =>
  Boolean(process.env.EXTRACTION_TEST_DATABASE_URL) && process.env.DATABASE_URL === process.env.EXTRACTION_TEST_DATABASE_URL

// kei on DBOS, played by the stand-in on the port Studio's KEI_EXP_URL names, in kei's schema of this stack's database.
let standIn: KeiStandInProcess | undefined
test.beforeAll(async () => {
  if (!databaseReady()) return
  standIn = await spawnKeiStandIn({
    databaseUrl: process.env.DATABASE_URL!,
    schema: 'kei_dbos',
    port: Number(new URL(process.env.FREE_PLAYWRIGHT_KEI_EXP_URL!).port),
  })
})
test.afterEach(async () => {
  if (!standIn) return
  await standIn.policy({ convert: 'auto' })
  for (const work of await standIn.held()) await standIn.answer(work.workflowId, { convert: 'auto' })
})
test.afterAll(async () => {
  await standIn?.stop()
})
test.beforeEach(() => {
  test.skip(!databaseReady(), 'DATABASE_URL must equal the disposable EXTRACTION_TEST_DATABASE_URL')
})

async function createProject(page: Page, name: string): Promise<string> {
  await loginResearcher(page)
  const response = await page.request.post('/api/project-contexts', { headers, data: { name } })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).projectContext.projectContextId as string
}
const heldConversions = async () => (await standIn!.held()).filter((work) => work.workflow === 'convert')

test('an admitted upload survives a Studio kill, stays on the page, and publishes once', async ({ page }) => {
  test.setTimeout(240_000)
  const project = await createProject(page, `Restart ingestion ${randomUUID()}`)
  await standIn!.policy({ convert: 'hold' })
  const workflowId = await admit(page, project, Buffer.from(blankPdf(3, randomUUID())), 'restart.pdf')
  await expect.poll(async () => (await heldConversions()).length, { timeout: 60_000 }).toBe(1)
  await page.goto(e2eStudioPath(`/projects/${project}`))
  await expect(page.getByRole('region', { name: 'Project' }).getByText('restart.pdf', { exact: true })).toBeVisible()

  await killStudio()
  await page.reload()
  await expect(page.getByRole('region', { name: 'Project' }).getByText('restart.pdf', { exact: true })).toBeVisible({ timeout: 30_000 })
  for (const work of await heldConversions()) await standIn!.answer(work.workflowId, { convert: 'auto' })

  expect(await settle(page, project, workflowId, 120_000)).toMatchObject({ status: 'succeeded' })
  const opened = await page.request.get(`/api/project-contexts/${project}`)
  expect(opened.ok(), await opened.text()).toBeTruthy()
  expect((await opened.json()).sourceDocuments.map((document: { name: string }) => document.name)).toEqual(['restart.pdf'])
})

test('a failure stopped before a Studio restart can be dismissed after it', async ({ page }) => {
  test.setTimeout(240_000)
  const project = await createProject(page, `Restart dismissal ${randomUUID()}`)
  await standIn!.policy({ convert: 'hold' })
  const workflowId = await admit(page, project, Buffer.from(blankPdf(3, randomUUID())), 'stopped.pdf')
  await expect.poll(async () => (await heldConversions()).length, { timeout: 60_000 }).toBe(1)
  // Nothing in the product cancels an upload of a surviving project; a test-side client stands in for an operator.
  const studio = await DBOSClient.create({
    systemDatabaseUrl: process.env.DATABASE_URL!, systemDatabaseSchemaName: STUDIO_SCHEMA, applicationName: STUDIO_APPLICATION,
  })
  try {
    await studio.cancelWorkflow(workflowId)
  } finally {
    await studio.destroy()
  }
  expect(await settle(page, project, workflowId)).toMatchObject({ status: 'failed' })
  const dismiss = () => page.request.delete(
    `/api/project-contexts/${project}/source-ingestions/${encodeURIComponent(workflowId)}`, { headers })

  const refused = await dismiss()
  expect(refused.status(), await refused.text()).toBe(409)
  expect((await refused.json()).error.code).toBe('ingestion_stopping')

  await killStudio()
  const dismissed = await dismiss()
  expect(dismissed.status(), await dismissed.text()).toBe(204)
  const listed = await page.request.get(`/api/project-contexts/${project}/source-ingestions?workflowId=${encodeURIComponent(workflowId)}`)
  expect(await listed.json()).toEqual({ ingestions: [], absent: [workflowId] })
})
