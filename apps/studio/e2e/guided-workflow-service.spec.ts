// The guided workflow end to end against the real Parsing Service, on CPU: native PDFs parse for real and only the
// model boundary is scripted (realService.ts). The researcher only ever takes the workflow bar's one Next, from the
// first upload to a fully reviewed collection, then revises the approved schema and is asked to re-approve it.
//   pnpm --filter studio exec playwright test --config playwright.service.config.ts guided-workflow-service.spec.ts
// Two steps go around the browser on purpose: the schema is written through the API (drafting one needs an assistant
// model this stack does not script), and reviews are saved through the durable API (reviewing values is covered by
// durable-service.spec.ts). Next still has to lead to each of those places.
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

const next = (page: Page, label: string | RegExp) =>
  page.getByRole('button', { name: typeof label === 'string' ? `Next: ${label}` : label })

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

test('the workflow bar\'s one Next leads from the first upload to a reviewed collection, and never back', async ({ page }, testInfo) => {
  test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL), 'The scripted model reads these catalogues; a real one need not.')
  test.setTimeout(900_000)
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    await loginResearcher(page, randomUUID())
    const created = await page.request.post('/api/project-contexts', { headers, data: { name: 'Guided workflow' } })
    expect(created.status(), await created.text()).toBe(201)
    const project = (await created.json()).projectContext.projectContextId as string
    await page.goto(`/projects/${project}`)

    // Upload: Next opens the file picker.
    expect(await page.getByRole('button', { name: /^Back:/ }).count()).toBe(0)
    const chooser = page.waitForEvent('filechooser')
    await next(page, 'Upload documents').click()
    await (await chooser).setFiles(Array.from({ length: DOCUMENTS }, (_, index) => catalogue(index + 1)))
    await expect.poll(async () => (await (await page.request.get(`/api/project-contexts/${project}`)).json()).sourceDocuments.length,
      { timeout: 600_000, intervals: [1_000] }).toBe(DOCUMENTS)

    // Create schema: Next leads to the Schemas tab; the schema itself is written through the API (see the header).
    await page.reload()
    await next(page, 'Create schema').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/schemas$`))
    const schema = await page.request.post('/api/schema-revisions', {
      headers, data: { projectContextId: project, ...article('All numbered sites in this document.') },
    })
    expect(schema.status(), await schema.text()).toBe(201)
    const { extractionSchemaId } = (await schema.json()).revision as { extractionSchemaId: string }

    // Pilot: Next opens the pilot on the Current Schema Revision, three documents pre-picked.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Go to Upload' })).toBeVisible()
    await next(page, 'Pilot extraction').click()
    await expect(page.getByText('3 selected', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Extraction Schema')).toBeDisabled()
    await page.getByRole('button', { name: 'Run 3 Source Documents' }).click()
    await expect(next(page, 'Review 3 pilot results')).toBeEnabled({ timeout: 300_000 })

    // Review the pilot: Next opens a pilot result; its review is saved through the API.
    await next(page, 'Review 3 pilot results').click()
    await expect(page).toHaveURL(/\/documents\/.*fromBatchExtractionId=/)
    const pilotExtraction = new URL(page.url()).searchParams.get('extractionId')
    expect(pilotExtraction).not.toBeNull()
    await reviewExtraction(page, pilotExtraction!)

    // Approve: only Next approves, after saying what it unlocks.
    await page.goto(`/projects/${project}`)
    await page.getByRole('button', { name: 'Back: Pilot' }).click()
    await expect(page).toHaveURL(new RegExp(`/projects/${project}/extractions`))
    await expect(page.getByRole('button', { name: /Approve for batch extraction/ })).toHaveCount(0)
    await next(page, 'Approve schema').click()
    const approve = page.getByRole('dialog', { name: 'Approve the schema for Batch Extraction?' })
    await approve.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(approve).toBeHidden()

    // Batch extract: Next opens the collection on the approved revision, which may now run past the pilot limit.
    await next(page, /^Next: Extract \d+ documents?$/).click()
    await expect(page.getByText(`${DOCUMENTS} selected`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: `Run ${DOCUMENTS} Source Documents` }).click()
    await expect(next(page, /^Next: Review \d+ results?$/)).toBeEnabled({ timeout: 300_000 })

    // Review: Next opens the first result left; every result is then reviewed and nothing is left to do.
    await next(page, /^Next: Review \d+ results?$/).click()
    await expect(page).toHaveURL(/\/documents\/.*fromBatchExtractionId=/)
    for (const extractionId of await newestBatchMembers(page, project)) await reviewExtraction(page, extractionId)
    await page.goto(`/projects/${project}`)
    await expect(page.getByText('Every document is extracted and reviewed.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Next:/ })).toHaveCount(0)

    // Revising the approved schema never moves the workflow back: Next asks to re-approve, piloting stays optional.
    const revised = await page.request.post('/api/schema-revisions', {
      headers, data: { projectContextId: project, extractionSchemaId, expectedRevisionNumber: 1, ...article('All numbered sites, with their finds.') },
    })
    expect(revised.status(), await revised.text()).toBe(201)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Go to Approve (Schema changed since approval)' })).toBeVisible()
    await expect(page.getByText('Revised schema not piloted', { exact: true })).toBeVisible()
    // Still at Review: the current step, with Back to the batch before it.
    await expect(page.locator('[aria-current="step"]')).toContainText('Review')
    await expect(page.getByRole('button', { name: 'Back: Batch extract' })).toBeVisible()
    await next(page, 'Re-approve schema').click()
    const reapprove = page.getByRole('dialog', { name: 'Re-approve the revised schema?' })
    await reapprove.getByRole('button', { name: 'Re-approve', exact: true }).click()
    await expect(reapprove).toBeHidden()
    await expect(next(page, `Extract ${DOCUMENTS} documents`)).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('guided-workflow-reapproved.png'), fullPage: true })
  } finally { await service.close() }
})
