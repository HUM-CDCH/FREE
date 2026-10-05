import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { E2E_ORIGIN, e2eStudioPath, loginResearcher } from './auth.js'
import { cataloguePdf, startRealService, textPdf } from './realService.js'
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
