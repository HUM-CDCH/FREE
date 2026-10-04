import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionReadResponseSchema } from '../shared/extraction.contract.js'
import { batchExtractionResponseSchema } from '../shared/batchExtraction.contract.js'
import { E2E_ORIGIN, e2eStudioPath, loginResearcher } from './auth.js'
import { openRecord, recordHeader, reviewRow } from './resultsReview.js'
import { cataloguePdf, numberedCataloguePdf, startRealService, textPdf } from './realService.js'
import { admit, settle, uploaded } from './sourceIngestion.js'

const headers = { Origin: E2E_ORIGIN }
async function createProject(page: Page, name: string): Promise<string> {
  await loginResearcher(page)
  const response = await page.request.post('/api/project-contexts', { headers, data: { name } })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).projectContext.projectContextId as string
}
async function representation(page: Page, project: string, document: string) {
  const response = await page.request.get(`/api/project-contexts/${project}/source-documents/${document}/reopen`)
  expect(response.ok(), await response.text()).toBeTruthy()
  return documentReopenResponseSchema.parse(await response.json()).sourceRepresentation.sourceRepresentationId
}
/** An Article over the site catalogue: the whole document is one object, its numbered sites one array of it. */
const ARTICLE_SITES = {
  recordDescription: 'The site catalogue as one document: every numbered archaeological site it lists.',
  recordScope: 'document',
  schemaNodes: [{
    id: 'sites', name: 'sites', type: 'array', description: 'Every numbered site, in source order.',
    children: [
      { id: 'site', name: 'site', type: 'verbatim-string', description: 'The site name exactly as printed: Hill or Valley.' },
      { id: 'finds', name: 'finds', type: 'verbatim-string', description: 'The material found, exactly as printed.' },
      { id: 'year', name: 'year', type: 'integer', description: 'The four-digit year printed after dated.' },
    ],
  }],
} as const
async function articleSchema(page: Page, project: string) {
  const response = await page.request.post('/api/schema-revisions', { headers, data: {
    projectContextId: project, ...ARTICLE_SITES,
  } })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).revision.schemaRevisionId as string
}
async function extract(page: Page, revision: string, representationId: string) {
  const id = randomUUID()
  const response = await page.request.post('/api/extractions', { headers, data: {
    id, strategy: 'ARTICLE', schemaRevisionId: revision, sourceRepresentationRevisionId: representationId,
    method: { models: null, settings: { article: null } },
  } })
  expect(response.status(), await response.text()).toBe(201)
  return id
}
async function completedExtraction(page: Page, id: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/extractions/${id}`)
    expect(response.ok(), await response.text()).toBeTruthy()
    const body = extractionReadResponseSchema.parse(await response.json())
    if (body.extraction.executionStatus === 'FAILED') throw new Error(JSON.stringify(body.extraction.failure))
    return body.extraction.executionStatus
  }, { timeout: 300_000, intervals: [500, 1000] }).toBe('COMPLETED')
}

test('PDF upload, real parse worker, extraction, evidence and review survive service restart', async ({ page }, testInfo) => {
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  const headers = { Origin: E2E_ORIGIN }
  try {
    await loginResearcher(page)
    const created = await page.request.post('/api/project-contexts', { headers, data: { name: 'Real service catalogue' } })
    expect(created.status(), await created.text()).toBe(201)
    const { projectContext } = await created.json()
    const source = await uploaded(page, projectContext.projectContextId, cataloguePdf(), 'sites.pdf')
    const reopenUrl = `/api/project-contexts/${projectContext.projectContextId}/source-documents/${source.sourceDocumentId}/reopen`
    const reopen = documentReopenResponseSchema.parse(await (await page.request.get(reopenUrl)).json())
    const canonicalResponse = await page.request.get(reopen.sourceRepresentation.resources.parsedDocumentUrl)
    expect(canonicalResponse.ok(), await canonicalResponse.text()).toBeTruthy()
    const canonical = await canonicalResponse.json()
    const runId: string = canonical.document.document_id
    const manifest = await (await fetch(`${service.url}/api/runs/${runId}/result`)).json()
    expect(manifest.status).toBe('success')
    expect(manifest.page_count).toBe(1)
    const anchors = new Set(canonical.evidence_index.anchors.map((anchor: { anchor_id: string }) => anchor.anchor_id))
    expect(anchors.size).toBeGreaterThanOrEqual(2)
    expect(service.modelCalls()).toBe(process.env.FREE_REAL_EXTRACT_URL ? null : 0)

    // The service must load accepted evidence from disk and durable admission from PostgreSQL after restart.
    await service.restart()
    expect(await (await fetch(`${service.url}/api/runs/${runId}/result`)).json()).toEqual(manifest)
    // One revision has one record scope. The Article runs revision 1, which reads the catalogue as one object whose
    // array holds both sites; a scope change then appends revision 2, the Catalog that reads each numbered entry as a
    // record.
    const articleResponse = await page.request.post('/api/schema-revisions', {
      headers, data: { projectContextId: projectContext.projectContextId, ...ARTICLE_SITES },
    })
    expect(articleResponse.status(), await articleResponse.text()).toBe(201)
    const article = (await articleResponse.json()).revision as { schemaRevisionId: string; extractionSchemaId: string }
    const catalogue = async () => {
      const response = await page.request.post('/api/schema-revisions', {
        headers,
        data: {
          projectContextId: projectContext.projectContextId,
          extractionSchemaId: article.extractionSchemaId,
          expectedRevisionNumber: 1,
          recordDescription: 'One numbered archaeological site entry. Extract each numbered entry once.',
          recordScope: 'records',
          schemaNodes: ARTICLE_SITES.schemaNodes[0].children,
        },
      })
      expect(response.status(), await response.text()).toBe(201)
      const { revision } = await response.json()
      expect(revision).toMatchObject({ revisionNumber: 2, recordScope: 'records' })
      return revision.schemaRevisionId as string
    }
    const sites = [
      { site: 'Hill', finds: 'pottery', year: 1801 },
      { site: 'Valley', finds: 'flint', year: 1802 },
    ]
    const runs = [
      { strategy: 'ARTICLE', revision: async () => article.schemaRevisionId, records: [{ sites }] },
      { strategy: 'CATALOG', revision: catalogue, records: sites },
    ] as const
    const completedIds: string[] = []
    for (const { strategy, revision, records } of runs) {
      const id = randomUUID()
      const admitted = await page.request.post('/api/extractions', { headers, data: {
        id, strategy, schemaRevisionId: await revision(),
        sourceRepresentationRevisionId: reopen.sourceRepresentation.sourceRepresentationId,
        method: { models: null, settings: strategy === 'CATALOG' ? { generic: null } : { article: null } },
      } })
      expect(admitted.status(), await admitted.text()).toBe(201)
      await expect.poll(async () => {
        const status = await page.request.get(`/api/extractions/${id}`)
        expect(status.ok(), await status.text()).toBeTruthy()
        const body = extractionReadResponseSchema.parse(await status.json())
        if (body.extraction.executionStatus === 'FAILED') throw new Error(JSON.stringify(body.extraction))
        return body.extraction.executionStatus
      }, { timeout: 240_000, intervals: [500, 1000] }).toBe('COMPLETED')
      const body = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
      expect(body.extraction.failure).toBeNull()
      expect(body.extraction.resultPayload).toEqual({ records })
      expect(body.extraction.complete).toBe(true)
      expect(body.extraction.evidenceLinks).toHaveLength(6)
      for (const link of body.extraction.evidenceLinks!) expect(anchors.has(link.evidenceAnchorId)).toBe(true)
      expect(body.pendingReviewDecisions).toHaveLength(6)
      const review = await page.request.post(`/api/extractions/${id}/review`, { headers, data: {
        reviewDecisions: body.pendingReviewDecisions,
      } })
      expect(review.ok(), await review.text()).toBeTruthy()
      completedIds.push(id)
    }

    // kei-exp names each extraction's directory by its id; Studio does not keep that id.
    const extractionIds = await readdir(join(service.runs, runId, 'extractions'))
    expect(extractionIds).toHaveLength(2)
    const acceptedArtifacts = await Promise.all(extractionIds.map(async (extractionId) => {
      const polled = await (await fetch(`${service.url}/api/runs/${runId}/extractions/${extractionId}`)).json()
      expect(polled.model).toBe(service.model)
      // One scripted server takes both roles, so each role reports the same model.
      expect(polled.models).toEqual({ fields: service.model, reasoning: service.model })
      const disk = JSON.parse(await readFile(join(service.runs, runId, 'extractions', extractionId, 'result.json'), 'utf8'))
      expect(polled).toEqual(disk)
      return { id: extractionId, result: polled }
    }))
    await testInfo.attach('accepted-extractions', { body: JSON.stringify(acceptedArtifacts, null, 2), contentType: 'application/json' })
    // Each artifact reports its own model calls. The Article inventories no identities: one document-level call reads
    // its one root (both sites in its array) and one grounding call checks that root's values. The Catalog discovers
    // the two entries, extracts each, and grounds each record.
    const stages = (strategy: string) => acceptedArtifacts.find(({ result }) => result.strategy === strategy)!
      .result.calls.map((call: { stage: string; record: number | null }) => [call.stage, call.record])
    expect(stages('article')).toEqual([['record', 0], ['grounding', 0]])
    expect(stages('catalog')).toEqual([
      ['discovery', null], ['record', 0], ['record', 1], ['grounding', 0], ['grounding', 1],
    ])
    const calls = service.modelCalls()
    if (calls !== null) expect(calls).toBe(7) // Article 2 (root, grounding) + Catalog 5 (discovery, two records, two groundings).
    await service.restart()
    for (const prior of acceptedArtifacts)
      expect(await (await fetch(`${service.url}/api/runs/${runId}/extractions/${prior.id}`)).json()).toEqual(prior.result)
    expect(service.modelCalls()).toBe(calls)
    for (const id of completedIds) {
      const durable = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
      expect(durable.extraction.reviewedAt).not.toBeNull()
    }
    await page.goto(`/projects/${projectContext.projectContextId}/documents/${source.sourceDocumentId}`)
    await page.getByRole('tab', { name: /Results/ }).click()
    await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
    // A reopened saved review lists its records collapsed (nothing left to check); the first one opens on its header.
    await recordHeader(page, 'Hill').click()
    await expect(reviewRow(page, 'site').first()).toBeVisible()
    await reviewRow(page, 'site').first().click()
    await page.screenshot({ path: testInfo.outputPath('real-evidence-review.png'), fullPage: true })
  } finally {
    await service.close()
  }
})

test('a recipe Catalog extraction segments entries, inherits headings, follows continuations and survives restart', async ({ page }, testInfo) => {
  // The scripted model answers from each prompt's ENTRY text; a real model's wording is checked by the service's live tests.
  test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL), 'Exact candidate answers need the scripted model boundary.')
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  const headers = { Origin: E2E_ORIGIN }
  try {
    await loginResearcher(page)
    const created = await page.request.post('/api/project-contexts', { headers, data: { name: 'Numbered catalogue' } })
    expect(created.status(), await created.text()).toBe(201)
    const { projectContext } = await created.json()
    const source = await uploaded(page, projectContext.projectContextId, numberedCataloguePdf(), 'katalog.pdf')
    const reopenUrl = `/api/project-contexts/${projectContext.projectContextId}/source-documents/${source.sourceDocumentId}/reopen`
    const reopen = documentReopenResponseSchema.parse(await (await page.request.get(reopenUrl)).json())
    const canonical = await (await page.request.get(reopen.sourceRepresentation.resources.parsedDocumentUrl)).json()
    const runId: string = canonical.document.document_id
    const anchors = new Set(canonical.evidence_index.anchors.map((anchor: { anchor_id: string }) => anchor.anchor_id))
    const schemaResponse = await page.request.post('/api/schema-revisions', {
      headers,
      data: {
        projectContextId: projectContext.projectContextId,
        recordDescription: 'One numbered catalogue entry.',
        recordScope: 'records',
        schemaNodes: [
          { id: 'entry_no', name: 'entry_no', type: 'integer', description: 'The catalogue number.' },
          { id: 'kreis', name: 'kreis', type: 'verbatim-string', description: 'The Kreis the entry is listed under.' },
          { id: 'fundart', name: 'fundart', type: 'verbatim-string', description: 'The find type after FA:.' },
          { id: 'site_name', name: 'site_name', type: 'verbatim-string', description: 'The site name after the number.' },
        ],
      },
    })
    expect(schemaResponse.status(), await schemaResponse.text()).toBe(201)
    const { revision } = await schemaResponse.json()
    const id = randomUUID()
    const admitted = await page.request.post('/api/extractions', { headers, data: {
      id, strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1', schemaRevisionId: revision.schemaRevisionId,
      sourceRepresentationRevisionId: reopen.sourceRepresentation.sourceRepresentationId,
      method: { models: null, settings: { recipe: null } },
    } })
    expect(admitted.status(), await admitted.text()).toBe(201)
    await expect.poll(async () => {
      const body = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
      if (body.extraction.executionStatus === 'FAILED') throw new Error(JSON.stringify(body.extraction))
      return body.extraction.executionStatus
    }, { timeout: 240_000, intervals: [500, 1000] }).toBe('COMPLETED')
    const body = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    expect(body.extraction.failure).toBeNull()
    // entry_no comes from the segmentation, kreis from the heading in force, fundart only after its FA: key
    // (for 32, on the next page); the positional site name no rule verifies is proposed, never accepted.
    expect(body.extraction.resultPayload).toEqual({ records: [
      { entry_no: 31, kreis: 'Heide', fundart: 'G', site_name: null },
      { entry_no: 32, kreis: 'Heide', fundart: 'EF', site_name: null },
    ] })
    expect(body.extraction.complete).toBe(true)
    const links = body.extraction.evidenceLinks!
    // Canonical segment ids name the physical page: 32's FA: value is grounded on page 2.
    expect(links.map(link => [link.resultPath.join('.'), link.grounding?.linkedBy,
      link.grounding && 'provenance' in link.grounding ? link.grounding.provenance : undefined,
      link.grounding?.textSpans[0]?.segment.split('_')[0]])).toEqual([
      ['records.0.entry_no', 'structure', 'positional', 'p1'], ['records.0.kreis', 'structure', 'inherited', 'p1'],
      ['records.0.fundart', 'key', 'token', 'p1'], ['records.1.entry_no', 'structure', 'positional', 'p1'],
      ['records.1.kreis', 'structure', 'inherited', 'p1'], ['records.1.fundart', 'key', 'token', 'p2'],
    ])
    for (const link of links) expect(anchors.has(link.evidenceAnchorId)).toBe(true)
    const grounded = body.extraction.diagnostics!.grounded!
    expect(grounded.recipe).toBe('numbered-catalogue-de@1')
    expect(grounded.completeness).toEqual({ processing: true, coverage: true, grounding: true, recall: 'unmeasured' })
    expect(grounded.proposed.map(candidate => [candidate.path, candidate.value])).toEqual([
      [['records', 0, 'site_name'], 'Hill'], [['records', 1, 'site_name'], 'Valley'],
    ])
    expect(service.modelCalls()).toBe(2) // One call per entry; structural fields are never asked of the model.
    // Optional-field templates are not decisions: approve only the six grounded values.
    expect(body.pendingReviewDecisions).toHaveLength(8)
    expect(body.reviewDraft?.decisions).toEqual([])
    const groundedDecisions = body.pendingReviewDecisions!.filter((decision) => decision.evidenceAnchorId !== null)
    expect(groundedDecisions).toHaveLength(6)
    const review = await page.request.post(`/api/extractions/${id}/review`, { headers, data: {
      reviewDecisions: groundedDecisions,
    } })
    expect(review.ok(), await review.text()).toBeTruthy()

    const [extractionId] = await readdir(join(service.runs, runId, 'extractions'))
    const accepted = await (await fetch(`${service.url}/api/runs/${runId}/extractions/${extractionId}`)).json()
    expect(accepted.extraction_version).toBe(2)
    expect(accepted.budget.tokenizer.source).toBe('vllm:/tokenize')
    const segmentations = await readdir(join(service.runs, runId, 'segmentations'))
    expect(segmentations).toHaveLength(1)
    await service.restart()
    expect(await (await fetch(`${service.url}/api/runs/${runId}/extractions/${extractionId}`)).json()).toEqual(accepted)
    expect(await readdir(join(service.runs, runId, 'segmentations'))).toEqual(segmentations)
    expect(service.modelCalls()).toBe(2)
    const durable = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    expect(durable.extraction.reviewedAt).not.toBeNull()
    expect(durable.extraction.reviewDecisions).toHaveLength(6)
    expect(durable.extraction.diagnostics!.grounded!.recipe).toBe('numbered-catalogue-de@1')

    await page.goto(`/projects/${projectContext.projectContextId}/documents/${source.sourceDocumentId}`)
    await page.getByRole('tab', { name: /Results/ }).click()
    // The recipe's own review lives in Run details (results review redesign §8).
    await page.getByRole('button', { name: 'Run details' }).click()
    const recipeReview = page.getByRole('dialog', { name: 'Run details' }).getByRole('region', { name: 'Recipe review' })
    await expect(recipeReview).toContainText('Every source line is accounted for.')
    await expect(recipeReview).toContainText('Recall is not measured.')
    await expect(recipeReview).toContainText('2 proposed values not accepted')
    await page.getByRole('button', { name: 'Close run details' }).click()
    // Evidence navigation lands on the physical page: 32's FA: value on page 2, its inherited Kreis heading on page 1.
    // What tied each value to its field shows under its source line once the value is selected (§3.3).
    // Entry 32 is the second record (both are named by their Kreis heading, Heide).
    await openRecord(page, 1)
    await reviewRow(page, 'fundart').click()
    await expect(page.getByText(/Read after its printed key/)).toBeVisible()
    await expect(page.locator('.page[data-page-number="2"] .parsed-evidence-focus')).not.toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('recipe-catalog-continuation.png'), fullPage: true })
    await reviewRow(page, 'kreis').click()
    await expect(page.getByText(/Inherited from the heading in force/)).toBeVisible()
    await expect(page.locator('.page[data-page-number="1"] .parsed-evidence-focus')).not.toHaveCount(0)
    await expect(page.locator('.page[data-page-number="2"] .parsed-evidence-focus')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('recipe-catalog-review.png'), fullPage: true })
  } finally {
    await service.close()
  }
})

test('a PDF that neither parser opens is refused without a Source Document', async ({ page }, testInfo) => {
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    const project = await createProject(page, 'Unreadable PDF')
    const workflowId = await admit(page, project, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]), 'unreadable.pdf')
    expect(await settle(page, project, workflowId)).toMatchObject({ status: 'failed', failure: { code: 'source_ingestion_failed' } })
    const [conversion] = await service.keiWorkflows('kei-convert:', project)
    expect(conversion?.queueName).toBe('kei-convert-large')
    expect(conversion?.output).toMatchObject({ ok: false, code: 'source_unreadable' })
    const snapshot = await page.request.get(`/api/project-contexts/${project}`)
    expect(snapshot.ok()).toBeTruthy()
    expect((await snapshot.json()).sourceDocuments).toHaveLength(0)
  } finally { await service.close() }
})

test('a PDF that PDFium alone opens converts on the large lane', async ({ page }, testInfo) => {
  // Generated from textPdf([['PDFium probe']]) by changing the page tree's /Count 1 to /Count 0.
  // Probed before committing: PDFium counts one page; pdf.js reports zero, which countPdfPages maps to null.
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    const project = await createProject(page, 'PDFium fallback')
    const pdf = await readFile(join(import.meta.dirname, 'fixtures', 'pdfium-only.pdf'))
    await uploaded(page, project, pdf, 'pdfium-only.pdf')
    const [conversion] = await service.keiWorkflows('kei-convert:', project)
    expect(conversion?.queueName).toBe('kei-convert-large')
    expect(conversion?.status).toBe('SUCCESS')
  } finally { await service.close() }
})

test('reprocess uses the small lane and the default owner model choice', async ({ page }, testInfo) => {
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    const project = await createProject(page, 'Reprocess model choice')
    const { sourceDocumentId } = await uploaded(page, project, cataloguePdf())
    const head = await representation(page, project, sourceDocumentId)
    const key = randomUUID()
    const response = await page.request.post(`/api/project-contexts/${project}/source-documents/${sourceDocumentId}/reprocess`, {
      headers, timeout: 300_000,
      data: { requestKey: key, expectedRepresentationId: head, layout: 'pages' },
    })
    expect(response.status(), await response.text()).toBe(201)
    const [child] = await service.keiWorkflows(`kei-convert:reprocess:${sourceDocumentId}:${key}`, project)
    expect(child?.queueName).toBe('kei-convert-small')
    expect(child?.input?.[0]).toMatchObject({ model: null, layout_model: null })
  } finally { await service.close() }
})

test('interactive and batch extraction reach kei with their priorities and deadlines', async ({ page }, testInfo) => {
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    const project = await createProject(page, 'Extraction priorities')
    const { sourceDocumentId } = await uploaded(page, project, cataloguePdf())
    const revision = await articleSchema(page, project)
    const interactive = await extract(page, revision, await representation(page, project, sourceDocumentId))
    await completedExtraction(page, interactive)
    const scheduled = await page.request.post('/api/batch-extractions', { headers, data: {
      projectContextId: project, schemaRevisionId: revision, strategy: 'ARTICLE',
      sourceDocumentIds: [sourceDocumentId], force: true, method: { models: null, settings: { article: null } },
    } })
    expect(scheduled.status(), await scheduled.text()).toBe(202)
    const batchId = (await scheduled.json()).batchExtraction.batchExtractionId as string
    await expect.poll(async () => (await service.keiWorkflows('kei-extract:', project)).length,
      { timeout: 120_000, intervals: [500, 1000] }).toBe(2)
    const children = await service.keiWorkflows('kei-extract:', project)
    const first = children.find((child) => child.workflowID === `kei-extract:${interactive}`)
    const batch = children.find((child) => child.workflowID !== `kei-extract:${interactive}`)
    expect(first).toMatchObject({ queueName: 'kei-extract', priority: 1, timeoutMS: 10_800_000 })
    expect(batch).toMatchObject({ queueName: 'kei-extract', priority: 10, timeoutMS: 10_800_000 })
    await expect.poll(async () => {
      const response = await page.request.get(`/api/batch-extractions/${batchId}?projectContextId=${project}`)
      expect(response.ok(), await response.text()).toBeTruthy()
      const current = batchExtractionResponseSchema.parse(await response.json()).batchExtraction
      return current.members[0]?.executionStatus
    }, { timeout: 300_000, intervals: [500, 1000] }).toBe('COMPLETED')
  } finally { await service.close() }
})

test('cancelling an extraction cancels its live kei child', async ({ page }, testInfo) => {
  test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL), 'A held model call requires the scripted model server.')
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    const project = await createProject(page, 'Cancel extraction')
    const { sourceDocumentId } = await uploaded(page, project, cataloguePdf())
    const revision = await articleSchema(page, project)
    const modelCallsBefore = service.modelCalls()!
    service.holdNextExtraction()
    const id = await extract(page, revision, await representation(page, project, sourceDocumentId))
    await expect.poll(() => service.extractionHeld(), { timeout: 120_000 }).toBe(true)
    const child = `kei-extract:${id}`
    await expect.poll(async () => (await service.keiWorkflows(child, project))[0]?.status).toBe('PENDING')
    const cancel = await page.request.delete(`/api/extractions/${id}`, { headers })
    expect(cancel.status(), await cancel.text()).toBe(202)
    await expect.poll(async () => (await service.keiWorkflows(child, project))[0]?.status,
      { timeout: 5_000, intervals: [100, 250] }).toBe('CANCELLED')
    const read = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    expect(read.extraction).toMatchObject({ executionStatus: 'FAILED', failure: { code: 'cancelled' }, resultPayload: null })
    service.releaseExtraction()
    await expect.poll(() => service.modelCalls(), { timeout: 10_000, intervals: [100, 250] })
      .toBeGreaterThan(modelCallsBefore)
    // The model has answered and DBOS has recorded the native step's completion.
    // Keep the service up through both barriers before checking late publication.
    await expect.poll(() => service.keiExtractStepFinished(child),
      { timeout: 120_000, intervals: [100, 250] }).toBe(true)
    const latest = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    expect(latest.extraction).toMatchObject({ executionStatus: 'FAILED', failure: { code: 'cancelled' }, resultPayload: null })
    expect((await service.keiWorkflows(child, project))[0]?.status).toBe('CANCELLED')
  } finally { service.releaseExtraction(); await service.close() }
})

test('a small conversion and extraction finish while a large conversion runs', async ({ page }, testInfo) => {
  const service = await startRealService(testInfo.outputPath('parsing-service.log'), { holdConversion: true })
  try {
    const project = await createProject(page, 'Independent conversion lanes')
    const largePdf = textPdf(Array.from({ length: 40 }, (_, index) => [`Large page ${index + 1}.`]))
    const largeUpload = await admit(page, project, largePdf, 'large.pdf')
    await expect.poll(() => service.conversionHeld(), { timeout: 120_000, intervals: [100, 250] }).toBe(true)
    let largeId = ''
    await expect.poll(async () => {
      const row = (await service.keiWorkflows('kei-convert:', project))
        .find((candidate) => candidate.queueName === 'kei-convert-large' && candidate.status === 'PENDING')
      largeId = row?.workflowID ?? ''
      return Boolean(row)
    }, { timeout: 120_000, intervals: [100, 250] }).toBe(true)
    const { sourceDocumentId } = await uploaded(page, project, cataloguePdf(), 'small.pdf')
    const revision = await articleSchema(page, project)
    const id = await extract(page, revision, await representation(page, project, sourceDocumentId))
    await completedExtraction(page, id)
    expect((await service.keiWorkflows(largeId, project))[0]?.status).toBe('PENDING')
    await service.releaseConversion()
    expect(await settle(page, project, largeUpload)).toMatchObject({ status: 'succeeded' })
    const conversions = await service.keiWorkflows('kei-convert:', project)
    const large = conversions.find((row) => row.workflowID === largeId)
    const smallChild = conversions.find((row) => row.workflowID !== largeId)
    const [extraction] = await service.keiWorkflows(`kei-extract:${id}`, project)
    expect(large?.queueName).toBe('kei-convert-large')
    expect(smallChild?.queueName).toBe('kei-convert-small')
    expect(smallChild?.completedAt).toBeLessThan(large!.completedAt!)
    expect(extraction?.completedAt).toBeLessThan(large!.completedAt!)
  } finally { await service.releaseConversion(); await service.close() }
})

test('a kei worker killed inside native conversion recovers the child and publishes once', async ({ page }, testInfo) => {
  const service = await startRealService(testInfo.outputPath('parsing-service.log'), { holdConversion: true })
  try {
    const project = await createProject(page, 'Conversion recovery')
    const pdf = textPdf(Array.from({ length: 40 }, (_, index) => [`Recovery page ${index + 1}.`]))
    const pending = await admit(page, project, pdf, 'recovery.pdf')
    await expect.poll(() => service.conversionHeld(), { timeout: 120_000, intervals: [100, 250] }).toBe(true)
    let workflowId = ''
    await expect.poll(async () => {
      const row = (await service.keiWorkflows('kei-convert:', project)).find((candidate) => candidate.status === 'PENDING')
      workflowId = row?.workflowID ?? ''
      return Boolean(row)
    }, { timeout: 120_000, intervals: [100, 250] }).toBe(true)
    await service.killWorker()
    await service.releaseConversion()
    const settled = await settle(page, project, pending)
    expect(settled).toMatchObject({ status: 'succeeded' })
    const { sourceDocumentId } = settled as { sourceDocumentId: string }
    const children = await service.keiWorkflows('kei-convert:', project)
    expect(children.map((child) => child.workflowID)).toEqual([workflowId])
    expect(children[0]).toMatchObject({ status: 'SUCCESS' })
    expect(children[0]!.recoveryAttempts).toBeGreaterThanOrEqual(2)
    const opened = await page.request.get(`/api/project-contexts/${project}`)
    expect(opened.ok(), await opened.text()).toBeTruthy()
    expect((await opened.json()).sourceDocuments.map((document: { sourceDocumentId: string }) => document.sourceDocumentId))
      .toEqual([sourceDocumentId])
    const reopen = documentReopenResponseSchema.parse(await (await page.request.get(
      `/api/project-contexts/${project}/source-documents/${sourceDocumentId}/reopen`)).json())
    expect(reopen.sourceRepresentation.revisionNumber).toBe(1)
  } finally { await service.releaseConversion(); await service.close() }
})

test('two selected PDFs are admitted while a conversion is held, and a reload keeps both cards', async ({ page }, testInfo) => {
  const service = await startRealService(testInfo.outputPath('parsing-service.log'), { holdConversion: true })
  try {
    const project = await createProject(page, 'Reload keeps Source Ingestions')
    await page.goto(e2eStudioPath(`/projects/${project}`))
    const projectPage = page.getByRole('region', { name: 'Project' })
    const large = textPdf(Array.from({ length: 40 }, (_, index) => [`Held page ${index + 1}.`]))
    await page.getByLabel('Drop PDFs here or browse').setInputFiles([
      { name: 'held.pdf', mimeType: 'application/pdf', buffer: large },
      { name: 'sites.pdf', mimeType: 'application/pdf', buffer: cataloguePdf() },
    ])
    await expect.poll(() => service.conversionHeld(), { timeout: 120_000, intervals: [100, 250] }).toBe(true)
    await expect(projectPage.getByText('held.pdf', { exact: true })).toBeVisible()
    await expect(projectPage.getByText('sites.pdf', { exact: true })).toBeVisible()

    // The browser forgets its queue; Studio still holds both attempts.
    await page.reload()
    await expect(projectPage.getByText('held.pdf', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(projectPage.getByText('sites.pdf', { exact: true })).toBeVisible()

    await service.releaseConversion()
    const rail = page.getByRole('navigation', { name: 'Projects' })
    await expect(rail.getByRole('button', { name: 'held.pdf' })).toBeVisible({ timeout: 300_000 })
    await expect(rail.getByRole('button', { name: 'sites.pdf' })).toBeVisible()
    await expect(projectPage.getByText('held.pdf', { exact: true })).toHaveCount(1)
  } finally { await service.releaseConversion(); await service.close() }
})

const EMPTY_DOCUMENT = { connections: [], routes: { schemaSuggestion: null, interaction: null }, extractionModels: {}, ingestionModels: {} }

test('kei receives the saved Article method byte for value, and the Extraction records it', async ({ page }, testInfo) => {
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    const project = await createProject(page, 'Method transport')
    const article = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
    const saved = await page.request.put('/api/model_config', { headers, data: { config: { ...EMPTY_DOCUMENT, extractionSettings: { article } } } })
    expect(saved.status(), await saved.text()).toBe(200)
    const { sourceDocumentId } = await uploaded(page, project, cataloguePdf())
    const revision = await articleSchema(page, project)
    const id = randomUUID()
    const admitted = await page.request.post('/api/extractions', { headers, data: {
      id, strategy: 'ARTICLE', schemaRevisionId: revision, sourceRepresentationRevisionId: await representation(page, project, sourceDocumentId),
      method: { models: null, settings: { article } },
    } })
    expect(admitted.status(), await admitted.text()).toBe(201)
    expect(extractionReadResponseSchema.shape.extraction.parse(await admitted.json()).requestedSettings).toEqual({ article })
    await expect.poll(async () => (await service.keiWorkflows(`kei-extract:${id}`)).length, { timeout: 120_000 }).toBe(1)
    const [child] = await service.keiWorkflows(`kei-extract:${id}`)
    expect((child!.input as [{ request: { options: unknown } }])[0].request.options).toEqual({ strategy: 'article', article })
    const cancelled = await page.request.delete(`/api/extractions/${id}`, { headers })
    expect([202, 404]).toContain(cancelled.status())
  } finally { await service.close() }
})

test('a recipe budget the served model cannot hold is refused before model calls and keeps its requested budget', async ({ page }, testInfo) => {
  test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL), 'The served context is the scripted model boundary’s 16,384 tokens.')
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    const project = await createProject(page, 'Refused budget')
    const recipe = { input_tokens: 4096, output_tokens: 16000, factors: { glossary: true, headings: true, overlap: true, verification: true } }
    expect((await page.request.put('/api/model_config', { headers, data: { config: { ...EMPTY_DOCUMENT, extractionSettings: { catalog: { recipe } } } } })).status()).toBe(200)
    const { sourceDocumentId } = await uploaded(page, project, numberedCataloguePdf(), 'katalog.pdf')
    const schema = await page.request.post('/api/schema-revisions', { headers, data: {
      projectContextId: project, recordDescription: 'One numbered catalogue entry.', recordScope: 'records',
      schemaNodes: [{ id: 'entry_no', name: 'entry_no', type: 'integer', description: 'The catalogue number.' }],
    } })
    expect(schema.status(), await schema.text()).toBe(201)
    const id = randomUUID()
    const admitted = await page.request.post('/api/extractions', { headers, data: {
      id, strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1', schemaRevisionId: (await schema.json()).revision.schemaRevisionId,
      sourceRepresentationRevisionId: await representation(page, project, sourceDocumentId), method: { models: null, settings: { recipe } },
    } })
    expect(admitted.status(), await admitted.text()).toBe(201)
    await expect.poll(async () =>
      extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json()).extraction.executionStatus,
    { timeout: 300_000, intervals: [500, 1000] }).toBe('COMPLETED')
    const { extraction } = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    expect(extraction.requestedSettings).toEqual({ recipe })
    expect(extraction.complete).toBe(false)
    expect(extraction.evidenceLinks).toEqual([])
    expect(extraction.diagnostics?.grounding?.issueCodes).toContain('budget_exceeds_context')
    expect((extraction.diagnostics?.effectiveMethod?.options.catalog as { output_tokens: number }).output_tokens).toBe(16000)
  } finally { await service.close() }
})
