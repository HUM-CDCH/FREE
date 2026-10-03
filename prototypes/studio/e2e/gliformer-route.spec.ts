import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { extractionReadResponseSchema } from '../shared/extraction.contract.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { startRealService, textPdf } from './realService.js'
import { admit, settle } from './sourceIngestion.js'

// Opt-in real GPU test. The ordinary service suite neither downloads nor starts a model.
test('native GLiFormer survives the authenticated durable Catalog route without changing predictions', async ({ page }, testInfo) => {
  test.skip(!process.env.FREE_REAL_GLIFORMER_URL || !process.env.FREE_REAL_EXTRACT_URL,
    'Needs real GLiFormer and reasoning servers.')
  test.setTimeout(3 * 60 * 60_000)
  expect(process.env.FREE_CATALOG_METHOD).toBe('unified')
  const output = process.env.FREE_GLIFORMER_ROUTE_OUTPUT ?? testInfo.outputPath('gliformer')
  await mkdir(output, { recursive: true })
  const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2))
  const headers = { Origin: E2E_ORIGIN }
  const service = await startRealService(testInfo.outputPath('parsing-service.log'))
  try {
    await loginResearcher(page, randomUUID())
    const listing = await (await page.request.get('/api/extraction-models')).json()
    expect(listing.models).toContainEqual(expect.objectContaining({ key: 'gliformer', serving: true, roles: ['fields'] }))
    expect(listing.defaults.fields).not.toBe('gliformer')
    const config = (await (await page.request.get('/api/model_config')).json()).config
    const models = { fields: 'gliformer', reasoning: 'instruct' }
    const configured = await page.request.put('/api/model_config', { headers, data: {
      config: { ...config, extractionModels: models, extractionSettings: {} },
    } })
    expect(configured.status(), await configured.text()).toBe(200)
    const created = await page.request.post('/api/project-contexts', { headers, data: { name: 'GLiFormer real route' } })
    expect(created.status(), await created.text()).toBe(201)
    const project = (await created.json()).projectContext.projectContextId
    const suppliedPdf = process.env.FREE_GLIFORMER_ROUTE_PDF
    const pdf = suppliedPdf ? await readFile(suppliedPdf) : textPdf([
      ['Numbered grave catalogue', '200. Male with goatskin.'],
      ['204. Adult male without objects. Covered with twigs and matting.', '10031. Adult male with skins.'],
      ['57. Multiple burials. This section summarizes graves 200, 204 and 10031.'],
    ])
    const ingestion = await settle(page, project, await admit(page, project, pdf, 'gliformer-verification.pdf'), 90 * 60_000)
    expect(ingestion, JSON.stringify(ingestion)).toMatchObject({ status: 'succeeded' })
    if (ingestion.status !== 'succeeded') throw new Error('Ingestion failed')
    const reopened = documentReopenResponseSchema.parse(await (await page.request.get(
      `/api/project-contexts/${project}/source-documents/${ingestion.sourceDocumentId}/reopen`)).json())
    const canonical = await (await page.request.get(reopened.sourceRepresentation.resources.parsedDocumentUrl)).json()
    await save('canonical.json', canonical)
    const schema = {
      recordDescription: 'One catalogue entry for one grave, headed by that grave identifier and describing its contents or burials. The number identifies the grave, not a chapter or numbered section. Exclude narrative discussion, summaries, tables, section headings and numbered paragraphs about groups of graves, even when they contain grave numbers. These are non-record text. Leather includes skins, hides and fur.',
      recordScope: 'records',
      schemaNodes: [
        { id: 'grave', name: 'grave_id', type: 'string' },
        { id: 'sex', name: 'sex', type: 'string' },
        { id: 'age', name: 'age', type: 'string' },
        { id: 'materials', name: 'leather_mentions', type: 'array', children: [
          { id: 'description', name: 'description', type: 'verbatim-string', description: 'Leather, skins, hides and fur.' },
        ] },
      ],
    }
    const revision = await page.request.post('/api/schema-revisions', { headers, data: { projectContextId: project, ...schema } })
    expect(revision.status(), await revision.text()).toBe(201)
    const id = randomUUID()
    const admitted = await page.request.post('/api/extractions', { headers, data: {
      id, strategy: 'CATALOG', schemaRevisionId: (await revision.json()).revision.schemaRevisionId,
      sourceRepresentationRevisionId: reopened.sourceRepresentation.sourceRepresentationId,
      method: { models, settings: { unified: { defaults: 1 } } },
    } })
    expect(admitted.status(), await admitted.text()).toBe(201)
    const read = async () => extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    await expect.poll(async () => {
      const state = await read()
      if (state.extraction.executionStatus === 'FAILED') throw new Error(JSON.stringify(state.extraction.failure))
      return state.extraction.executionStatus
    }, { timeout: 90 * 60_000, intervals: [2000, 5000] }).toBe('COMPLETED')
    const settled = await read()
    const artifact = await (await fetch(`${service.url}/api/runs/${canonical.document.document_id}/extractions/${id}`)).json()
    await save('studio-extraction.json', settled)
    await save('service-artifact.json', artifact)
    await save('route.json', { id, project, sourceDocumentId: ingestion.sourceDocumentId, commit: process.env.FREE_VERIFY_SHA })
    const windows = artifact.native_fields.windows
    expect(windows.length).toBeGreaterThan(0)
    expect(artifact.records).toEqual(windows.flatMap((window: { output: { record: unknown[] } }) => window.output.record))
    expect(settled.extraction.resultPayload).toEqual({ records: artifact.records })
    expect(artifact.records.length).toBeGreaterThan(0)
    expect(artifact.evidence).toEqual([])
    expect(artifact.ungrounded.length).toBeGreaterThan(0)
    expect(artifact.processing.verification.enabled).toBe(false)
    expect(windows.every((window: { input_tokens: number }) => window.input_tokens <= 2048)).toBe(true)
    expect(artifact.calls.filter((call: { stage: string }) => call.stage === 'entry').length).toBe(windows.length)
    if (!suppliedPdf) {
      expect(windows).toHaveLength(3)
      expect(windows.map((window: { input_text: string }) => window.input_text).join('\n')).not.toContain('Multiple burials')
    }
    // This known development PDF has catalogue entries through physical page six; page seven is discussion.
    // Assertions check the model's boundaries, never filter or repair them.
    if (createHash('sha256').update(pdf).digest('hex') === '37321a719f736c7ecc5f6d52a1f1dbfbcb5296361c9a191906a513276caead78') {
      const inputs = windows.map((window: { input_text: string }) => window.input_text)
      expect(inputs.some((input: string) => /^10,031\./.test(input))).toBe(true)
      expect(windows.some((window: { ranges: { segment: string }[] }) =>
        window.ranges.some(range => range.segment.startsWith('p7_')))).toBe(false)
      expect(inputs.some((input: string) => /^5[678]\./.test(input))).toBe(false)
    }
    await page.goto(`/projects/${project}/documents/${ingestion.sourceDocumentId}`)
    await page.getByRole('tab', { name: /Results/ }).click()
    await page.getByText('GLiFormer inputs, raw output and native confidence', { exact: true }).click()
    await expect(page.getByLabel('GLiFormer input window')).toBeVisible()
    await expect(page.getByText('Native confidence diagnostics', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(output, 'native-diagnostics.png'), fullPage: true })
    await service.restart()
    expect((await read()).extraction.resultPayload).toEqual(settled.extraction.resultPayload)
    await page.reload()
    await page.getByRole('tab', { name: /Results/ }).click()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('dialog', { name: 'Export options' }).getByRole('button', { name: 'CSV', exact: true }).click()
    const csv = await readFile((await (await download).path())!, 'utf8')
    expect(csv).toContain('grave_id')
    await writeFile(join(output, 'export.csv'), csv)
    await save('passed.json', { at: new Date().toISOString(), entries: artifact.discovery.entries.length,
      windows: windows.length, records: artifact.records.length, restart: true, export: true })
  } finally {
    await service.close()
  }
})
