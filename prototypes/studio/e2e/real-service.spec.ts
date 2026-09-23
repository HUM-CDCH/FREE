import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionReadResponseSchema } from '../shared/extraction.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { cataloguePdf, numberedCataloguePdf, startRealService } from './realService.js'

test('PDF upload, real parse worker, extraction, evidence and review survive service restart', async ({ page }, testInfo) => {
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  const headers = { Origin: E2E_ORIGIN }
  try {
    await loginResearcher(page)
    const created = await page.request.post('/api/project-contexts', { headers, data: { name: 'Real service catalogue' } })
    expect(created.status(), await created.text()).toBe(201)
    const { projectContext } = await created.json()
    const upload = await page.request.post(`/api/project-contexts/${projectContext.projectContextId}/source-documents`, {
      headers,
      timeout: 180_000,
      multipart: { ingestionKey: randomUUID(), file: { name: 'sites.pdf', mimeType: 'application/pdf', buffer: cataloguePdf() } },
    })
    expect(upload.status(), await upload.text()).toBe(201)
    const source = await upload.json()
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
    const schemaResponse = await page.request.post('/api/schema-revisions', {
      headers,
      data: {
        projectContextId: projectContext.projectContextId,
        recordDescription: 'One numbered archaeological site entry. Extract each numbered entry once.',
        schemaNodes: [
          { id: 'site', name: 'site', type: 'verbatim-string', description: 'The site name exactly as printed: Hill or Valley.' },
          { id: 'finds', name: 'finds', type: 'verbatim-string', description: 'The material found, exactly as printed.' },
          { id: 'year', name: 'year', type: 'integer', description: 'The four-digit year printed after dated.' },
        ],
      },
    })
    expect(schemaResponse.status(), await schemaResponse.text()).toBe(201)
    const { revision } = await schemaResponse.json()
    const completedIds: string[] = []
    for (const strategy of ['ARTICLE', 'CATALOG'] as const) {
      const id = randomUUID()
      const admitted = await page.request.post('/api/extractions', { headers, data: {
        id, strategy, schemaRevisionId: revision.schemaRevisionId,
        sourceRepresentationRevisionId: reopen.sourceRepresentation.sourceRepresentationId,
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
      expect(body.extraction.resultPayload).toEqual({ records: [
        { site: 'Hill', finds: 'pottery', year: 1801 },
        { site: 'Valley', finds: 'flint', year: 1802 },
      ] })
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

    const remote = await (await fetch(`${service.url}/api/runs/${runId}/extractions`)).json()
    expect(remote).toHaveLength(2)
    const acceptedArtifacts = await Promise.all(remote.map(async (job: { id: string }) => {
      const polled = await (await fetch(`${service.url}/api/runs/${runId}/extractions/${job.id}`)).json()
      expect(polled.status).toBe('done')
      expect(polled.result.model).toBe(service.model)
      // One scripted server takes both roles, so each role reports the same model.
      expect(polled.result.models).toEqual({ fields: service.model, reasoning: service.model })
      const disk = JSON.parse(await readFile(join(service.runs, runId, 'extractions', job.id, 'result.json'), 'utf8'))
      expect(polled.result).toEqual(disk)
      return polled
    }))
    await testInfo.attach('accepted-extractions', { body: JSON.stringify(acceptedArtifacts, null, 2), contentType: 'application/json' })
    const calls = service.modelCalls()
    if (calls !== null) expect(calls).toBe(4) // Article, discovery, then two catalog records.
    await service.restart()
    for (const prior of acceptedArtifacts)
      expect(await (await fetch(`${service.url}/api/runs/${runId}/extractions/${prior.id}`)).json()).toEqual(prior)
    expect(service.modelCalls()).toBe(calls)
    for (const id of completedIds) {
      const durable = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
      expect(durable.extraction.reviewedAt).not.toBeNull()
    }
    await page.goto(`/projects/${projectContext.projectContextId}/documents/${source.sourceDocumentId}`)
    await page.getByRole('tab', { name: /Results/ }).click()
    await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Item 1 › Hill' }).click()
    await expect(page.getByRole('button', { name: 'View Evidence for site' }).first()).toBeVisible()
    await page.getByRole('button', { name: 'View Evidence for site' }).first().click()
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
    const upload = await page.request.post(`/api/project-contexts/${projectContext.projectContextId}/source-documents`, {
      headers,
      timeout: 180_000,
      multipart: { ingestionKey: randomUUID(), file: { name: 'katalog.pdf', mimeType: 'application/pdf', buffer: numberedCataloguePdf() } },
    })
    expect(upload.status(), await upload.text()).toBe(201)
    const source = await upload.json()
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
    expect(links.map(link => [link.resultPath.join('.'), link.grounding?.linkedBy, link.grounding?.provenance,
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
    expect(body.pendingReviewDecisions).toHaveLength(6)
    const review = await page.request.post(`/api/extractions/${id}/review`, { headers, data: {
      reviewDecisions: body.pendingReviewDecisions,
    } })
    expect(review.ok(), await review.text()).toBeTruthy()

    const [job] = await (await fetch(`${service.url}/api/runs/${runId}/extractions`)).json()
    const accepted = await (await fetch(`${service.url}/api/runs/${runId}/extractions/${job.id}`)).json()
    expect(accepted.result.extraction_version).toBe(2)
    expect(accepted.result.budget.tokenizer.source).toBe('vllm:/tokenize')
    const segmentations = await readdir(join(service.runs, runId, 'segmentations'))
    expect(segmentations).toHaveLength(1)
    await service.restart()
    expect(await (await fetch(`${service.url}/api/runs/${runId}/extractions/${job.id}`)).json()).toEqual(accepted)
    expect(await readdir(join(service.runs, runId, 'segmentations'))).toEqual(segmentations)
    expect(service.modelCalls()).toBe(2)
    const durable = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    expect(durable.extraction.reviewedAt).not.toBeNull()
    expect(durable.extraction.diagnostics!.grounded!.recipe).toBe('numbered-catalogue-de@1')

    await page.goto(`/projects/${projectContext.projectContextId}/documents/${source.sourceDocumentId}`)
    await page.getByRole('tab', { name: /Results/ }).click()
    const recipeReview = page.getByRole('region', { name: 'Recipe review' })
    await expect(recipeReview).toContainText('Every source line is accounted for.')
    await expect(recipeReview).toContainText('Recall is not measured.')
    await expect(recipeReview).toContainText('2 proposed values not accepted')
    // Evidence navigation lands on the physical page: 32's FA: value on page 2, its inherited Kreis heading on page 1.
    await page.getByRole('button', { name: 'Item 2 › Heide' }).click()
    await expect(page.getByText('Inherited from the heading in force', { exact: true })).toBeVisible()
    await expect(page.getByText('Read after its printed key', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'View Evidence for fundart' }).click()
    await expect(page.locator('.page[data-page-number="2"] .parsed-evidence-focus')).not.toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('recipe-catalog-continuation.png'), fullPage: true })
    await page.getByRole('button', { name: 'View Evidence for kreis' }).click()
    await expect(page.locator('.page[data-page-number="1"] .parsed-evidence-focus')).not.toHaveCount(0)
    await expect(page.locator('.page[data-page-number="2"] .parsed-evidence-focus')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('recipe-catalog-review.png'), fullPage: true })
  } finally {
    await service.close()
  }
})
