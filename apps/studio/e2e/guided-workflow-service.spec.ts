// The guided workflow end to end against the real Parsing Service, on CPU: native PDFs parse for real and only the
// model boundary is scripted (realService.ts). After the first upload the researcher only ever takes the chat's next
// step, to a fully reviewed collection, then revises the approved schema and is asked to re-approve it.
//   pnpm --filter studio exec playwright test --config playwright.service.config.ts guided-workflow-service.spec.ts
// Two steps go around the browser on purpose: the schema is written through the API (drafting one needs an assistant
// model this stack does not script), and reviews are saved through the durable API (reviewing values is covered by
// durable-service.spec.ts). The chat still has to lead on from each of them.
import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { startRealService, textPdf } from './realService.js'

const headers = { Origin: E2E_ORIGIN }
/** More than a pilot (PILOT_BATCH_SELECTION_LIMIT is 5), so the batch needs the approval. */
const DOCUMENTS = 6
const siteNodes = [
  { id: 'site', name: 'site', type: 'verbatim-string' },
  { id: 'finds', name: 'finds', type: 'verbatim-string' },
  { id: 'year', name: 'year', type: 'integer' },
]
const article = (description: string) => ({
  recordDescription: description,
  schemaNodes: [{ id: 'sites', name: 'sites', type: 'array', children: siteNodes }],
  recordScope: 'document',
})

/** Distinct sources (a Project Context keeps one Source Document per content) the scripted model reads alike. */
const catalogue = (index: number) => ({
  name: `catalogue-${index}.pdf`,
  mimeType: 'application/pdf',
  buffer: textPdf([[`Site catalogue ${index}`, '1. Hill: pottery dated 1801.', '2. Valley: flint dated 1802.']]),
})

/** The chat's step titled `title`, in the project chat beside the open document. */
const step = (page: Page, title: string) =>
  page.getByRole('complementary', { name: 'Chat, template and results' }).getByRole('region', { name: title, exact: true })

/** Approves every saved value of one completed Extraction and saves the review. */
async function reviewExtraction(page: Page, extractionId: string) {
  const root = `/api/extractions/${extractionId}/durable`
  await expect.poll(async () => (await (await page.request.get(root)).json()).status, { timeout: 180_000 }).toBe('COMPLETED')
  const read = async () => (await page.request.get(`${root}/values?limit=500`)).json()
  const result = await read()
  for (const value of result.values.filter((each: { processing: string }) => each.processing === 'saved')) {
    const saved = await page.request.post(`${root}/values/${encodeURIComponent(value.id)}`, {
      headers,
      data: { snapshotVersion: result.snapshotVersion, expectedRevision: value.correction?.revision ?? 0, action: 'APPROVED', evidence: [] },
    })
    expect(saved.ok(), await saved.text()).toBeTruthy()
  }
  const decided = await read()
  const finalized = await page.request.post(`${root}/finalize`, {
    headers,
    data: { snapshotVersion: decided.snapshotVersion, feedbackVersion: decided.feedbackVersion },
  })
  expect(finalized.ok(), await finalized.text()).toBeTruthy()
}

async function newestBatchMembers(page: Page, project: string): Promise<string[]> {
  const listed = await (await page.request.get(`/api/batch-extractions?projectContextId=${project}`)).json()
  const [newest] = listed.batchExtractions.toSorted((left: { createdAt: string }, right: { createdAt: string }) =>
    right.createdAt.localeCompare(left.createdAt))
  return newest.members.map((member: { extractionId: string }) => member.extractionId)
}

test('the chat leads from the first upload to a reviewed collection, and never back', async ({ page }, testInfo) => {
  test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL), 'The scripted model reads these catalogues; a real one need not.')
  test.setTimeout(900_000)
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    await loginResearcher(page, randomUUID())
    const created = await page.request.post('/api/project-contexts', { headers, data: { name: 'Guided workflow' } })
    expect(created.status(), await created.text()).toBe(201)
    const project = (await created.json()).projectContext.projectContextId as string
    await page.goto(`/projects/${project}`)

    // Upload: the project page leads no step of its own; with no document it asks for one.
    const status = page.getByRole('region', { name: 'Project status' })
    await expect(status).toContainText('Upload documents to begin.')
    await expect(page.getByRole('button', { name: /^Next:/ })).toHaveCount(0)
    await page.getByLabel('Drop PDFs here or browse').setInputFiles(Array.from({ length: DOCUMENTS }, (_, index) => catalogue(index + 1)))
    await expect.poll(async () => (await (await page.request.get(`/api/project-contexts/${project}`)).json()).sourceDocuments.length,
      { timeout: 600_000, intervals: [1_000] }).toBe(DOCUMENTS)

    // Create schema: written through the API (see the header).
    const schema = await page.request.post('/api/schema-revisions', {
      headers, data: { projectContextId: project, ...article('All numbered sites in this document.') },
    })
    expect(schema.status(), await schema.text()).toBe(201)
    const { extractionSchemaId } = (await schema.json()).revision as { extractionSchemaId: string }

    // Pilot: Continue opens a document, whose chat pilots the schema on three documents ticked from that one on.
    await page.reload()
    await status.getByRole('button', { name: 'Continue in chat' }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/documents/`))
    const pilot = step(page, 'Pilot the template')
    await expect(pilot.getByRole('checkbox', { checked: true })).toHaveCount(3)
    await pilot.getByRole('button', { name: 'Run pilot on 3 documents' }).click()
    await expect(page).toHaveURL(/\/documents\/.*fromBatchExtractionId=/)

    // Review the pilot through the API; the chat then asks for the approval, which only it offers.
    const pilotMembers = await newestBatchMembers(page, project)
    for (const extractionId of pilotMembers) await reviewExtraction(page, extractionId)
    // The chat's read of the project: each pilot document shows its member, reviewed at a finalized cut.
    const latest = await page.request.get(`/api/batch-extractions?projectContextId=${project}&latest=1`)
    expect(latest.status(), await latest.text()).toBe(200)
    const { latestExtractions, reviewedExtractions, newestExtractionIds } = await latest.json()
    expect(newestExtractionIds).toEqual(expect.arrayContaining(pilotMembers))
    expect(reviewedExtractions.map(({ extractionId }: { extractionId: string }) => extractionId)).toEqual(expect.arrayContaining(pilotMembers))
    expect(latestExtractions.filter(({ extractionId }: { extractionId: string }) => pilotMembers.includes(extractionId))).toEqual(
      pilotMembers.map(() => expect.objectContaining({ completed: true, review: { snapshotVersion: expect.any(Number), feedbackVersion: expect.any(Number) } })))
    await page.reload()
    const approval = step(page, 'Approve template')
    await expect(approval).toBeVisible({ timeout: 60_000 })
    await approval.getByRole('button', { name: 'Approve template' }).click()
    const approve = page.getByRole('dialog', { name: 'Approve the template for Batch Extraction?' })
    await approve.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(approve).toBeHidden()

    // Batch extract: the chat ticks the documents the pilot left, which may now run past the pilot limit.
    const batch = step(page, 'Batch extraction')
    await expect(batch.getByRole('checkbox', { checked: true })).toHaveCount(DOCUMENTS - 3)
    await batch.getByRole('button', { name: `Extract ${DOCUMENTS - 3} documents` }).click()

    // Review: once the batch has run, the chat leads to its results; every result is then reviewed.
    await expect(step(page, 'Review results')).toBeVisible({ timeout: 300_000 })
    for (const extractionId of await newestBatchMembers(page, project)) await reviewExtraction(page, extractionId)
    await page.goto(`/projects/${project}`)
    await expect(status).toContainText('Every document is extracted and reviewed.')

    // Revising the approved schema never moves the workflow back: the chat asks to re-approve, piloting stays optional.
    const revised = await page.request.post('/api/schema-revisions', {
      headers, data: { projectContextId: project, extractionSchemaId, expectedRevisionNumber: 1, ...article('All numbered sites, with their finds.') },
    })
    expect(revised.status(), await revised.text()).toBe(201)
    await page.reload()
    await expect(status).toContainText('Next in the chat: Re-approve template')
    await status.getByRole('button', { name: 'Continue in chat' }).click()
    const reapproval = step(page, 'Re-approve template')
    await reapproval.getByRole('button', { name: 'Re-approve template' }).click()
    const reapprove = page.getByRole('dialog', { name: 'Re-approve the revised template?' })
    await reapprove.getByRole('button', { name: 'Re-approve', exact: true }).click()
    await expect(reapprove).toBeHidden()
    await expect(step(page, 'Batch extraction')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('guided-workflow-reapproved.png'), fullPage: true })
  } finally { await service.close() }
})
