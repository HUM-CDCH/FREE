import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionReadResponseSchema } from '../shared/extraction.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { cataloguePdf, startRealService, textPdf } from './realService.js'
import { admit, settle, uploaded } from './sourceIngestion.js'

const headers = { Origin: E2E_ORIGIN }
test.describe.configure({ mode: 'serial' })

async function project(page: Page, name: string): Promise<string> {
  await loginResearcher(page)
  const response = await page.request.post('/api/project-contexts', { headers, data: { name } })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).projectContext.projectContextId as string
}

/** The Source Document an upload became (Studio admits it with 202; this waits for the attempt to publish). */
function upload(page: Page, projectId: string, pdf = cataloguePdf(), name = 'source.pdf') {
  return uploaded(page, projectId, pdf, name)
}

async function revision(page: Page, projectId: string): Promise<string> {
  const response = await page.request.post('/api/schema-revisions', { headers, data: {
    // An Article, the one strategy `extract` runs: the catalogue is one object and its sites one array of it.
    projectContextId: projectId, recordDescription: 'The site catalogue as one document.', recordScope: 'document',
    schemaNodes: [{
      id: 'sites', name: 'sites', type: 'array', description: 'Every numbered site, in source order.',
      children: [
        { id: 'site', name: 'site', type: 'verbatim-string', description: 'Site name.' },
        { id: 'finds', name: 'finds', type: 'verbatim-string', description: 'Material found.' },
        { id: 'year', name: 'year', type: 'integer', description: 'Year after dated.' },
      ],
    }],
  } })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).revision.schemaRevisionId as string
}

async function extract(page: Page, projectId: string, sourceDocumentId: string): Promise<string> {
  const reopened = await page.request.get(`/api/project-contexts/${projectId}/source-documents/${sourceDocumentId}/reopen`)
  expect(reopened.ok(), await reopened.text()).toBe(true)
  const sourceRepresentationRevisionId = documentReopenResponseSchema.parse(await reopened.json())
    .sourceRepresentation.sourceRepresentationId
  const id = randomUUID()
  const response = await page.request.post('/api/extractions', { headers, data: {
    id, strategy: 'ARTICLE', schemaRevisionId: await revision(page, projectId), sourceRepresentationRevisionId,
    method: { models: null, settings: { article: null } },
  } })
  expect(response.status(), await response.text()).toBe(201)
  return id
}

async function deleteProject(page: Page, id: string): Promise<void> {
  const response = await page.request.delete(`/api/project-contexts/${id}`, { headers })
  expect(response.status(), await response.text()).toBe(204)
}

async function conversionFor(service: Awaited<ReturnType<typeof startRealService>>, projectId: string) {
  const [conversion] = await service.keiWorkflows('kei-convert:ingest:', projectId)
  expect(conversion?.output).toMatchObject({ ok: true, run_id: expect.any(String) })
  return { id: conversion!.workflowID, runId: (conversion!.output as { run_id: string }).run_id }
}

async function waitForKeiGc(service: Awaited<ReturnType<typeof startRealService>>, workflowId: string) {
  await expect.poll(async () => (await service.keiWorkflows(workflowId))[0]?.status,
    { timeout: 120_000, intervals: [250, 500] }).toBe('SUCCESS')
}

test('a deleted project loses its run and both applications\' settled history in one sweep', async ({ page }, info) => {
  const service = await startRealService(info.outputPath('parsing-service.log'))
  try {
    const projectId = await project(page, 'GC completed project')
    const { sourceDocumentId } = await upload(page, projectId)
    const extractionId = await extract(page, projectId, sourceDocumentId)
    await expect.poll(async () => {
      const response = await page.request.get(`/api/extractions/${extractionId}`)
      const body = extractionReadResponseSchema.parse(await response.json())
      if (body.extraction.executionStatus === 'FAILED') throw new Error(JSON.stringify(body.extraction.failure))
      return body.extraction.executionStatus
    }, { timeout: 300_000, intervals: [500, 1000] }).toBe('COMPLETED')
    const conversion = await conversionFor(service, projectId)
    await deleteProject(page, projectId)
    await service.ageRun(conversion.runId, 25 * 3600_000)
    const summary = await service.collectGarbage()
    expect(summary.failedPhases).toEqual([])
    expect(summary.keiRequest?.conversions).toContain(conversion.id)
    expect(summary.keiRequest?.history).toContain(`kei-extract:${extractionId}`)
    await waitForKeiGc(service, summary.keiRequest!.workflowId)
    expect(await service.runExists(conversion.runId)).toBe(false)
    expect(await service.keiWorkflows(conversion.id)).toEqual([])
    expect(await service.keiWorkflows(`kei-extract:${extractionId}`)).toEqual([])
    expect(await service.studioWorkflows(`ingest:${projectId}:`)).toEqual([])
    expect(await service.studioWorkflows(`extract:${extractionId}`)).toEqual([])
  } finally { await service.close() }
})

test('a cancelled native extraction protects its old run until the kei worker restarts', async ({ page }, info) => {
  test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL), 'The scripted model server holds a native call for this test.')
  const service = await startRealService(info.outputPath('parsing-service.log'))
  try {
    const projectId = await project(page, 'GC held extraction')
    const { sourceDocumentId } = await upload(page, projectId)
    const conversion = await conversionFor(service, projectId)
    service.holdNextExtraction()
    const extractionId = await extract(page, projectId, sourceDocumentId)
    const childId = `kei-extract:${extractionId}`
    await expect.poll(() => service.extractionHeld(), { timeout: 120_000 }).toBe(true)
    await expect.poll(async () => (await service.keiWorkflows(childId))[0]?.status).toBe('PENDING')
    await service.cancelKeiWorkflow(childId)
    await expect.poll(async () => (await service.keiWorkflows(childId))[0]?.status).toBe('CANCELLED')
    await expect.poll(async () => (await service.studioWorkflows(`extract:${extractionId}`))[0]?.status,
      { timeout: 30_000, intervals: [100, 250] }).toBe('SUCCESS')
    await deleteProject(page, projectId)
    await service.ageRun(conversion.runId, 25 * 3600_000)
    for (let sweep = 0; sweep < 2; sweep++) {
      const summary = await service.collectGarbage()
      expect(summary.failedPhases).toEqual([])
      if (summary.keiRequest) await waitForKeiGc(service, summary.keiRequest.workflowId)
      expect(await service.runExists(conversion.runId)).toBe(true)
      expect(await service.keiWorkflows(childId)).toHaveLength(1)
    }
    service.releaseExtraction()
    await expect.poll(() => service.keiExtractStepFinished(childId), { timeout: 120_000 }).toBe(true)
    const sameBoot = await service.collectGarbage()
    if (sameBoot.keiRequest) await waitForKeiGc(service, sameBoot.keiRequest.workflowId)
    expect(await service.runExists(conversion.runId)).toBe(true)
    await service.killWorker()
    const afterBoot = await service.collectGarbage()
    expect(afterBoot.failedPhases).toEqual([])
    expect(afterBoot.keiRequest?.conversions).toContain(conversion.id)
    await waitForKeiGc(service, afterBoot.keiRequest!.workflowId)
    expect(await service.runExists(conversion.runId)).toBe(false)
    expect(await service.keiWorkflows(childId)).toEqual([])
    expect(await service.orphanPayloadRows('kei_dbos')).toBe(0)
  } finally { service.releaseExtraction(); await service.close() }
})

test('a sweep on the GC lane removes a due run while a large conversion is held', async ({ page }, info) => {
  const service = await startRealService(info.outputPath('parsing-service.log'), { holdConversion: true })
  try {
    await service.releaseConversion()
    const dueProject = await project(page, 'GC due run')
    await upload(page, dueProject)
    const due = await conversionFor(service, dueProject)
    await deleteProject(page, dueProject)
    await service.ageRun(due.runId, 25 * 3600_000)
    await service.holdNextConversion()

    const largeProject = await project(page, 'GC large conversion')
    const largePdf = textPdf(Array.from({ length: 40 }, (_, index) => [`Large page ${index + 1}.`]))
    const largeUpload = await admit(page, largeProject, largePdf, 'large.pdf')
    await expect.poll(() => service.conversionHeld(), { timeout: 120_000, intervals: [100, 250] }).toBe(true)
    let largeId = ''
    await expect.poll(async () => {
      const row = (await service.keiWorkflows('kei-convert:', largeProject))
        .find((candidate) => candidate.queueName === 'kei-convert-large' && candidate.status === 'PENDING')
      largeId = row?.workflowID ?? ''
      return Boolean(row)
    }, { timeout: 120_000 }).toBe(true)
    const summary = await service.collectGarbage()
    expect(summary.failedPhases).toEqual([])
    expect(summary.keiRequest?.conversions).toContain(due.id)
    expect(summary.keiRequest?.conversions ?? []).not.toContain(largeId)
    await waitForKeiGc(service, summary.keiRequest!.workflowId)
    expect(await service.runExists(due.runId)).toBe(false)
    expect((await service.keiWorkflows(largeId))[0]?.status).toBe('PENDING')
    await service.releaseConversion()
    expect(await settle(page, largeProject, largeUpload)).toMatchObject({ status: 'succeeded' })
    expect((await service.keiWorkflows(largeId))[0]?.output).toMatchObject({ ok: true, page_count: 40 })
  } finally { await service.releaseConversion(); await service.close() }
})

test('a held extraction keeps its conversion run and kei history through a sweep', async ({ page }, info) => {
  test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL), 'The scripted model server holds a native call for this test.')
  const service = await startRealService(info.outputPath('parsing-service.log'))
  try {
    const projectId = await project(page, 'GC live extraction')
    const { sourceDocumentId } = await upload(page, projectId)
    const conversion = await conversionFor(service, projectId)
    service.holdNextExtraction()
    const extractionId = await extract(page, projectId, sourceDocumentId)
    const childId = `kei-extract:${extractionId}`
    await expect.poll(() => service.extractionHeld(), { timeout: 120_000 }).toBe(true)
    const summary = await service.collectGarbage()
    expect(summary.failedPhases).toEqual([])
    expect(summary.keiRequest?.conversions ?? []).not.toContain(conversion.id)
    expect(summary.keiRequest?.history ?? []).not.toContain(childId)
    expect(await service.runExists(conversion.runId)).toBe(true)
    expect((await service.keiWorkflows(childId))[0]?.status).toBe('PENDING')
    service.releaseExtraction()
    await expect.poll(async () => (await service.keiWorkflows(childId))[0]?.status,
      { timeout: 240_000, intervals: [500, 1000] }).toBe('SUCCESS')
    await expect.poll(async () => (await service.studioWorkflows(`extract:${extractionId}`))[0]?.status,
      { timeout: 120_000, intervals: [250, 500] }).toBe('SUCCESS')
  } finally { service.releaseExtraction(); await service.close() }
})
