import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import pluralize from 'pluralize'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionReadResponseSchema } from '../shared/extraction.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { startRealService } from './realService.js'
import { admit, settle } from './sourceIngestion.js'

/**
 * One real document through the application as a researcher drives it, against a real model: the schema arrives
 * without a record scope, the Article/Catalog selector chooses it (saved at once, read back after a reload), the
 * workspace's Run admits the extraction with the account's saved method, then evidence and contested fields are
 * inspected, one list item is edited and the rest approved, the page is reloaded, and CSV and XLSX are exported.
 * FREE_REAL_ROUTE_PDF, FREE_REAL_ROUTE_SCHEMA (recordDescription and schemaNodes, no scope) and
 * FREE_REAL_ROUTE_STRATEGY (ARTICLE or CATALOG) name the case; FREE_REAL_ROUTE_ARTICLE is the Article method saved
 * first (JSON, optional). Every artifact is written to FREE_REAL_ROUTE_OUTPUT before the browser step that needs it.
 */
const pdfPath = process.env.FREE_REAL_ROUTE_PDF
const schemaPath = process.env.FREE_REAL_ROUTE_SCHEMA
const strategy = (process.env.FREE_REAL_ROUTE_STRATEGY ?? 'CATALOG') as 'ARTICLE' | 'CATALOG'
const article = process.env.FREE_REAL_ROUTE_ARTICLE ? JSON.parse(process.env.FREE_REAL_ROUTE_ARTICLE) : null
const headers = { Origin: E2E_ORIGIN }

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

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

test('a researcher chooses the scope, runs, reviews, reloads and exports a real document', async ({ page }, testInfo) => {
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
    if (article) {
      const current = (await (await page.request.get('/api/model_config')).json()).config
      const put = await page.request.put('/api/model_config', { headers,
        data: { config: { ...current, extractionSettings: { ...current.extractionSettings, article } } } })
      expect(put.status(), await put.text()).toBe(200)
    }
    const created = await page.request.post('/api/project-contexts', { headers, data: { name: `Real application: ${basename(pdfPath!)}` } })
    expect(created.status(), await created.text()).toBe(201)
    const project = (await created.json()).projectContext.projectContextId as string
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

    // The schema arrives undeclared, as a legacy revision would: the selector is the only way to give it a scope.
    const schema = JSON.parse(await readFile(schemaPath!, 'utf8'))
    expect(schema.recordScope).toBeUndefined()
    const revision = await page.request.post('/api/schema-revisions', { headers, data: { projectContextId: project, ...schema } })
    expect(revision.status(), await revision.text()).toBe(201)
    expect((await revision.json()).revision.recordScope).toBeNull()

    page.setDefaultTimeout(120_000)
    const workspace = `/projects/${project}/documents/${source.sourceDocumentId}`
    await page.goto(workspace)
    const selector = page.getByRole('combobox', { name: 'Extraction strategy' })
    await expect(selector).toHaveValue('')
    const run = page.getByRole('button', { name: /Run extraction/ })
    await expect(run).toBeDisabled()
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/schema-revisions' &&
      response.request().method() === 'POST')
    await selector.selectOption(strategy)
    const scopeSave = await saved
    expect(scopeSave.status(), await scopeSave.text()).toBe(201)
    const scope = strategy === 'ARTICLE' ? 'document' : 'records'
    expect((await scopeSave.json()).revision.recordScope).toBe(scope)
    await expect(page.getByText(/Unsaved changes|Saving…/)).toHaveCount(0)
    clock.scopeSaved = new Date().toISOString()
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Extraction strategy' })).toHaveValue(strategy)
    await page.screenshot({ path: join(output, 'scope-saved.png'), fullPage: true })

    const admitted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/extractions' &&
      response.request().method() === 'POST')
    await page.getByRole('button', { name: /Run extraction/ }).click()
    const admission = await admitted
    expect(admission.status(), await admission.text()).toBe(201)
    const id = (await admission.json()).extractionId as string
    await save('admission.json', { request: admission.request().postDataJSON(), response: await admission.json() })
    clock.admitted = new Date().toISOString()
    await expect.poll(async () => {
      const body = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
      if (body.extraction.executionStatus === 'FAILED') throw new Error(JSON.stringify(body.extraction.failure))
      return body.extraction.executionStatus
    }, { timeout: 3 * 60 * 60_000, intervals: [5_000, 10_000] }).toBe('COMPLETED')
    clock.completed = new Date().toISOString()

    const settled = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    await save('studio-extraction.json', settled)
    const artifact = await (await fetch(`${service.url}/api/runs/${runId}/extractions/${id}`)).json()
    await save('service-artifact.json', artifact)
    await save('canonical.json', canonical)
    await save('route.json', { id, runId, strategy, article, project, sourceDocumentId: source.sourceDocumentId, clock })
    expect(settled.extraction.failure).toBeNull()
    for (const link of settled.extraction.evidenceLinks!) expect(anchors.has(link.evidenceAnchorId)).toBe(true)
    const records = ((settled.extraction.resultPayload ?? {}) as { records?: Json[] }).records ?? []
    if (strategy === 'ARTICLE') expect(records).toHaveLength(1)
    const contested = (settled.extraction.diagnostics as { contested?: unknown[] } | null)?.contested ?? []

    await page.goto(workspace)
    await page.getByRole('tab', { name: /Results/ }).click()
    await expect(page.getByText('Review', { exact: false }).first()).toBeVisible()
    if (contested.length === 0) await expect(page.getByText('Contested', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: join(output, 'results.png'), fullPage: true })
    // Review needs evidence: a result without any evidence link has nothing to approve or edit, and says so.
    const reviewable = settled.extraction.evidenceLinks!.length > 0
    const target = reviewable ? firstListItem(records) : null
    const edited = target ? `${target.value} (reviewed)` : null
    if (target) {
      if (records.length > 1) await page.getByRole('button', { name: new RegExp(`^Item ${target.record + 1}\\b`) }).first().click()
      await page.getByRole('button', { name: new RegExp(`^${target.field}\\b`) }).first().click()
      const singular = pluralize.singular(target.field)
      const listItem = `${singular.charAt(0).toUpperCase()}${singular.slice(1)} ${target.item + 1}`
      if (target.child) await page.getByRole('button', { name: new RegExp(`^${listItem}\\b`) }).first().click()
      const item = target.child ?? listItem
      await page.getByRole('group', { name: `Review ${item}` }).getByRole('button', { name: `Edit ${item}` }).click()
      const box = page.getByRole('textbox', { name: `Reviewed value for ${item}`, exact: true })
      await box.fill(edited!)
      await box.press('Enter')
      await expect(page.getByText(edited!, { exact: true })).toBeVisible()
      // The extracted value an edit replaced keeps its evidence: open it in the source view.
      const evidence = page.getByRole('button', { name: `View Evidence for extracted value of ${item}` })
      await expect(evidence).toBeVisible()
      await evidence.click()
      await page.screenshot({ path: join(output, 'evidence.png'), fullPage: true })
    }
    if (reviewable) {
      await page.getByRole('button', { name: /Approve remaining/ }).click()
      await expect(page.getByText('Review saved', { exact: true })).toBeVisible({ timeout: 30_000 })
      clock.reviewed = new Date().toISOString()
    }

    await page.reload()
    await page.getByRole('tab', { name: /Results/ }).click()
    if (reviewable) await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Extraction strategy' })).toHaveValue(strategy)
    const reviewed = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    if (reviewable) expect(reviewed.extraction.reviewedAt).not.toBeNull()
    await save('studio-reviewed.json', reviewed)
    await page.screenshot({ path: join(output, 'reloaded.png'), fullPage: true })

    for (const [format, label] of [['CSV', 'CSV'], ['XLSX', 'Excel']] as const) {
      await page.getByRole('button', { name: 'Export' }).click()
      const dialog = page.getByRole('dialog', { name: 'Export options' })
      if (format === 'CSV') await page.screenshot({ path: join(output, 'export-dialog.png'), fullPage: true })
      const download = page.waitForEvent('download')
      await dialog.getByRole('button', { name: label, exact: true }).click()
      const file = (await (await download).path())!
      await writeFile(join(output, `export.${format.toLowerCase()}`), await readFile(file))
      if (format === 'CSV' && edited) expect(await readFile(file, 'utf8')).toContain(edited)
    }
    clock.exported = new Date().toISOString()
    await save('route.json', { id, runId, strategy, article, project, sourceDocumentId: source.sourceDocumentId, clock, target,
      contested: contested.length, reviewable })
  } finally {
    await service.close()
  }
})
