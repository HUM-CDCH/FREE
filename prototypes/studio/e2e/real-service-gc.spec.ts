import { expect, test, type Page } from '@playwright/test'
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
    expect(await service.keiWorkflows(due.id)).toEqual([])
    expect(await service.studioWorkflows(`ingest:${dueProject}:`)).toEqual([])
    expect(await service.orphanPayloadRows('kei_dbos')).toBe(0)
    expect((await service.keiWorkflows(largeId))[0]?.status).toBe('PENDING')
    await service.releaseConversion()
    expect(await settle(page, largeProject, largeUpload)).toMatchObject({ status: 'succeeded' })
    expect((await service.keiWorkflows(largeId))[0]?.output).toMatchObject({ ok: true, page_count: 40 })
  } finally { await service.releaseConversion(); await service.close() }
})
