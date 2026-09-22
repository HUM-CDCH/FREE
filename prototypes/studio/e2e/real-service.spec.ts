import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionReadResponseSchema } from '../shared/extraction.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { cataloguePdf, startRealService } from './realService.js'

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
