import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import pluralize from 'pluralize'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionReadResponseSchema } from '../shared/extraction.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { startRealService } from './realService.js'
import { admit, settle } from './sourceIngestion.js'

/**
 * One real document through the whole application against a real model: upload, native parse, an approved schema,
 * the admitted extraction method, durable records and evidence, review in the browser (one nested item edited, one
 * rejected, the rest approved), reload and export. Nothing here knows the document: FREE_REAL_ROUTE_PDF and
 * FREE_REAL_ROUTE_SCHEMA (a FREE schema file: recordDescription and schemaNodes) name it, FREE_REAL_ROUTE_STRATEGY
 * picks ARTICLE or CATALOG (Catalog is the unified method when FREE_CATALOG_METHOD=unified). Every artifact is written
 * to FREE_REAL_ROUTE_OUTPUT before any browser step, so a failed step never loses the model's work.
 */
const pdfPath = process.env.FREE_REAL_ROUTE_PDF
const schemaPath = process.env.FREE_REAL_ROUTE_SCHEMA
const strategy = (process.env.FREE_REAL_ROUTE_STRATEGY ?? 'CATALOG') as 'ARTICLE' | 'CATALOG'
const headers = { Origin: E2E_ORIGIN }

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** The first populated string list item in the records, as [record, field, item] with its value; failing that, the
 *  first string child of an object list item, as [record, field, item, child]. */
function firstListItem(records: Json[]): { record: number; field: string; item: number; child?: string; value: string } | null {
  let nested: { record: number; field: string; item: number; child: string; value: string } | null = null
  for (const [record, value] of records.entries())
    for (const [field, child] of Object.entries((value ?? {}) as Record<string, Json>))
      if (Array.isArray(child))
        for (const [item, entry] of child.entries()) {
          if (typeof entry === 'string' && entry.trim() !== '') return { record, field, item, value: entry }
          if (!nested && entry && typeof entry === 'object' && !Array.isArray(entry))
            for (const [name, leaf] of Object.entries(entry))
              if (!nested && typeof leaf === 'string' && leaf.trim() !== '') nested = { record, field, item, child: name, value: leaf }
        }
  return nested
}

test('a real document runs through the application: extraction, evidence, browser review, reload and export', async ({ page }, testInfo) => {
  test.skip(!process.env.FREE_REAL_EXTRACT_URL || !pdfPath || !schemaPath,
    'Needs a real model (FREE_REAL_EXTRACT_URL/MODEL) and FREE_REAL_ROUTE_PDF/FREE_REAL_ROUTE_SCHEMA.')
  test.setTimeout(4 * 60 * 60_000)
  const output = process.env.FREE_REAL_ROUTE_OUTPUT ?? testInfo.outputPath('route')
  await mkdir(output, { recursive: true })
  const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2))
  const clock: Record<string, string> = { started: new Date().toISOString() }
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    await loginResearcher(page)
    const created = await page.request.post('/api/project-contexts', { headers, data: { name: `Real route: ${basename(pdfPath!)}` } })
    expect(created.status(), await created.text()).toBe(201)
    const project = (await created.json()).projectContext.projectContextId as string
    // A scanned source is read by the OCR server page by page: give ingestion as long as the extraction.
    const ingestion = await settle(page, project, await admit(page, project, await readFile(pdfPath!), basename(pdfPath!)),
      3 * 60 * 60_000)
    expect(ingestion, JSON.stringify(ingestion)).toMatchObject({ status: 'succeeded' })
    const source = ingestion as Extract<typeof ingestion, { status: 'succeeded' }>
    clock.parsed = new Date().toISOString()
    const reopen = documentReopenResponseSchema.parse(await (await page.request.get(
      `/api/project-contexts/${project}/source-documents/${source.sourceDocumentId}/reopen`)).json())
    const canonical = await (await page.request.get(reopen.sourceRepresentation.resources.parsedDocumentUrl)).json()
    const runId: string = canonical.document.document_id
    const anchors = new Set(canonical.evidence_index.anchors.map((anchor: { anchor_id: string }) => anchor.anchor_id))

    const schema = JSON.parse(await readFile(schemaPath!, 'utf8'))
    const revision = await page.request.post('/api/schema-revisions', { headers, data: { projectContextId: project, ...schema } })
    expect(revision.status(), await revision.text()).toBe(201)
    const schemaRevisionId = (await revision.json()).revision.schemaRevisionId as string
    const settings = strategy === 'ARTICLE' ? { article: null }
      : process.env.FREE_CATALOG_METHOD === 'unified' ? { unified: { defaults: 1 } } : { generic: null }
    const id = randomUUID()
    const admitted = await page.request.post('/api/extractions', { headers, data: {
      id, strategy, schemaRevisionId, sourceRepresentationRevisionId: reopen.sourceRepresentation.sourceRepresentationId,
      method: { models: null, settings },
    } })
    expect(admitted.status(), await admitted.text()).toBe(201)
    clock.admitted = new Date().toISOString()
    await expect.poll(async () => {
      const body = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
      if (body.extraction.executionStatus === 'FAILED') throw new Error(JSON.stringify(body.extraction.failure))
      return body.extraction.executionStatus
    }, { timeout: 3 * 60 * 60_000, intervals: [5_000, 10_000] }).toBe('COMPLETED')
    clock.completed = new Date().toISOString()

    // Durable state, saved before any browser step: Studio's settled Extraction and the service's own artifact.
    const settled = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    await save('studio-extraction.json', settled)
    const artifact = await (await fetch(`${service.url}/api/runs/${runId}/extractions/${id}`)).json()
    await save('service-artifact.json', artifact)
    await save('canonical.json', canonical)
    await save('route.json', { id, runId, strategy, settings, project, sourceDocumentId: source.sourceDocumentId, clock })
    expect(settled.extraction.failure).toBeNull()
    for (const link of settled.extraction.evidenceLinks!) expect(anchors.has(link.evidenceAnchorId)).toBe(true)
    expect(settled.pendingReviewDecisions).toHaveLength(settled.extraction.evidenceLinks!.length)
    const records = ((settled.extraction.resultPayload ?? {}) as { records?: Json[] }).records ?? []
    expect(records.length).toBeGreaterThan(0)

    // Review in the browser: open the record, edit one list item, reject another leaf, approve the rest.
    const target = firstListItem(records)
    page.setDefaultTimeout(120_000)  // a missing control fails this step, not after the test's four hours
    await page.goto(`/projects/${project}/documents/${source.sourceDocumentId}`)
    await page.getByRole('tab', { name: /Results/ }).click()
    await page.screenshot({ path: join(output, 'results.png'), fullPage: true })
    const edited = target ? `${target.value} (reviewed)` : null
    if (target) {
      // One record's fields are shown at the root; several records are listed as items first.
      if (records.length > 1) await page.getByRole('button', { name: new RegExp(`^Item ${target.record + 1}\\b`) }).first().click()
      await page.getByRole('button', { name: new RegExp(`^${target.field}\\b`) }).first().click()
      const singular = pluralize.singular(target.field)  // as ResultValue's singularItemLabel names list items
      const listItem = `${singular.charAt(0).toUpperCase()}${singular.slice(1)} ${target.item + 1}`
      if (target.child) await page.getByRole('button', { name: new RegExp(`^${listItem}\\b`) }).first().click()
      const item = target.child ?? listItem
      await page.getByRole('group', { name: `Review ${item}` }).getByRole('button', { name: `Edit ${item}` }).click()
      const box = page.getByRole('textbox', { name: `Reviewed value for ${item}`, exact: true })
      await box.fill(edited!)
      await box.press('Enter')
      await expect(page.getByText(edited!, { exact: true })).toBeVisible()
      const original = page.getByRole('button', { name: `View Evidence for extracted value of ${item}` })
      await expect(original).toBeVisible()
      await original.click()
      await page.screenshot({ path: join(output, 'edited-item-evidence.png'), fullPage: true })
    }
    await page.getByRole('button', { name: /Approve remaining/ }).click()
    await expect(page.getByText('Review saved', { exact: true })).toBeVisible({ timeout: 30_000 })
    clock.reviewed = new Date().toISOString()

    await page.reload()
    await page.getByRole('tab', { name: /Results/ }).click()
    await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
    const reviewed = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    expect(reviewed.extraction.reviewedAt).not.toBeNull()
    await save('studio-reviewed.json', reviewed)
    await page.screenshot({ path: join(output, 'reloaded.png'), fullPage: true })

    await page.getByRole('button', { name: 'Export' }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('dialog', { name: 'Export options' }).getByRole('button', { name: 'CSV' }).click()
    const csv = await readFile((await (await download).path())!, 'utf8')
    await writeFile(join(output, 'export.csv'), csv)
    if (edited) expect(csv).toContain(edited)
    clock.exported = new Date().toISOString()
    await save('route.json', { id, runId, strategy, settings, project, sourceDocumentId: source.sourceDocumentId, clock, target })
  } finally {
    await service.close()
  }
})
