import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import pluralize from 'pluralize'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionReadResponseSchema } from '../shared/extraction.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { cataloguePdf, startRealService, textPdf } from './realService.js'
import { admit, settle } from './sourceIngestion.js'

/**
 * Evidence-review acceptance: one document through the application as a researcher drives it. The schema arrives
 * without a record scope; the Article/Catalog selector chooses it (saved at once, read back after a reload); the
 * workspace's Run admits the extraction with the account's saved method. Then, every step required: a populated list
 * value with evidence is opened in the source (its anchor highlighted on its page, in view), edited, the edit keeps the
 * extracted value's evidence labelled as the extracted value's, the review is saved, the page reloaded, and CSV and
 * Excel carry the reviewed value.
 *
 * Without FREE_REAL_EXTRACT_URL the scripted model answers the stack's own site catalogue (selectors and controls, no
 * model call). With it: FREE_REAL_ROUTE_PDF + FREE_REAL_ROUTE_SCHEMA (recordDescription and schemaNodes, no scope) and
 * FREE_REAL_ROUTE_STRATEGY, or FREE_REAL_ROUTE_SYNTHETIC=nested, a labelled synthetic inspection report whose rooms
 * hold defects (an array inside each array item): a structural check, not extraction-quality evidence.
 * FREE_REAL_ROUTE_ARTICLE is the Article method saved first (JSON, optional). Every artifact is written to
 * FREE_REAL_ROUTE_OUTPUT before the browser step that needs it.
 */
const real = Boolean(process.env.FREE_REAL_EXTRACT_URL)
const synthetic = process.env.FREE_REAL_ROUTE_SYNTHETIC === 'nested'
const article = process.env.FREE_REAL_ROUTE_ARTICLE ? JSON.parse(process.env.FREE_REAL_ROUTE_ARTICLE) : null
const headers = { Origin: E2E_ORIGIN }

const SITES = {
  recordDescription: 'The site catalogue as one document: every numbered archaeological site it lists.',
  schemaNodes: [{ id: 'sites', name: 'sites', type: 'array', description: 'Every numbered site, in source order.',
    children: [
      { id: 'site', name: 'site', type: 'verbatim-string', description: 'The site name exactly as printed: Hill or Valley.' },
      { id: 'finds', name: 'finds', type: 'verbatim-string', description: 'The material found, exactly as printed.' },
      { id: 'year', name: 'year', type: 'integer', description: 'The four-digit year printed after dated.' },
    ] }],
}
/** SYNTHETIC: an invented inspection report, written for this structural check only. */
const INSPECTION_PDF = (): Buffer => textPdf([
  ['SYNTHETIC TEST DOCUMENT - Inspection 4471', 'Room: Kitchen. Defect: cracked tile (minor).', 'Defect: leaking tap (major).'],
  ['Room: Bathroom. Defect: loose seal (minor).', 'Defect: cracked tile (major).', 'Inspector: A. Berg.'],
])
const INSPECTION = {
  recordDescription: 'One synthetic inspection report: the rooms inspected, each with the defects found in it.',
  schemaNodes: [
    { id: 'number', name: 'inspection_number', type: 'string' },
    { id: 'inspector', name: 'inspector', type: 'string' },
    { id: 'rooms', name: 'rooms', type: 'array', description: 'Every room inspected, in source order.', children: [
      { id: 'room', name: 'room', type: 'string', description: 'The room name as printed.' },
      { id: 'defects', name: 'defects', type: 'array', description: 'Every defect found in this room.', children: [
        { id: 'defect', name: 'defect', type: 'string', description: 'What the defect is, as printed.' },
        { id: 'severity', name: 'severity', type: 'string', description: 'minor or major, as printed.' },
      ] },
    ] },
  ],
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Path = (string | number)[]

function valueAt(root: Json, path: Path): Json | undefined {
  let node: Json | undefined = root
  for (const step of path) node = node === null || typeof node !== 'object' ? undefined : (node as Record<string, Json>)[step]
  return node
}

/** The deepest evidence-linked string inside a list: the value this review edits. */
function target(result: Json, links: readonly { resultPath: Path; evidenceAnchorId: string }[]) {
  const listed = links.filter((link) => link.resultPath.slice(2).some((step) => typeof step === 'number') &&
    typeof valueAt(result, link.resultPath) === 'string' && String(valueAt(result, link.resultPath)).trim() !== '')
  return listed.sort((a, b) => b.resultPath.length - a.resultPath.length)[0]
}

/** Opens the result tree down to `path` (below records/n) and names the leaf as the Results tab labels it. */
async function open(page: Page, path: Path, records: number): Promise<string> {
  const steps = path.slice(2)
  const panel = page.getByLabel('Evidence, schema and results')  // not the project rail, whose file names may match
  if (records > 1) await panel.getByRole('button', { name: new RegExp(`^Item ${Number(path[1]) + 1}\\b`) }).first().click()
  let field = ''
  let leaf = ''
  for (const [index, step] of steps.entries()) {
    const singular = pluralize.singular(field)
    const name = typeof step === 'number' ? `${singular.charAt(0).toUpperCase()}${singular.slice(1)} ${step + 1}` : step
    if (typeof step === 'string') field = step
    if (index === steps.length - 1) leaf = name
    else await panel.getByRole('button', { name: new RegExp(`^${name}\\b`) }).first().click()
  }
  return leaf
}

/** The evidence overlay for `anchor` is drawn on its page and scrolled into view. */
async function highlighted(page: Page, anchor: string, pageNumber: number) {
  const overlay = page.locator(`.page[data-page-number="${pageNumber}"] [data-evidence-anchor-id="${anchor}"]`).first()
  await expect(overlay).toBeAttached()
  await expect(overlay).toBeInViewport()
}

test('a researcher chooses the scope, opens evidence, edits, reloads and exports a document', async ({ page }, testInfo) => {
  test.skip(real && !synthetic && (!process.env.FREE_REAL_ROUTE_PDF || !process.env.FREE_REAL_ROUTE_SCHEMA),
    'A real model needs FREE_REAL_ROUTE_PDF and FREE_REAL_ROUTE_SCHEMA, or FREE_REAL_ROUTE_SYNTHETIC=nested.')
  test.setTimeout(4 * 60 * 60_000)
  const output = process.env.FREE_REAL_ROUTE_OUTPUT ?? testInfo.outputPath('route')
  await mkdir(output, { recursive: true })
  const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2))
  // Its own file name: the stack's other specs find their files in the shared project rail by name.
  const [pdf, name, schema, strategy] = !real ? [cataloguePdf(), 'acceptance-catalogue.pdf', SITES, 'ARTICLE' as const]
    : synthetic ? [INSPECTION_PDF(), 'synthetic-inspection.pdf', INSPECTION, 'ARTICLE' as const]
      : [await readFile(process.env.FREE_REAL_ROUTE_PDF!), basename(process.env.FREE_REAL_ROUTE_PDF!),
         JSON.parse(await readFile(process.env.FREE_REAL_ROUTE_SCHEMA!, 'utf8')),
         (process.env.FREE_REAL_ROUTE_STRATEGY ?? 'CATALOG') as 'ARTICLE' | 'CATALOG']
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
    const created = await page.request.post('/api/project-contexts', { headers, data: { name: `Application route: ${name}` } })
    expect(created.status(), await created.text()).toBe(201)
    const project = (await created.json()).projectContext.projectContextId as string
    const ingestion = await settle(page, project, await admit(page, project, pdf, name), 3 * 60 * 60_000)
    expect(ingestion, JSON.stringify(ingestion)).toMatchObject({ status: 'succeeded' })
    const source = ingestion as Extract<typeof ingestion, { status: 'succeeded' }>
    clock.parsed = new Date().toISOString()
    const reopen = documentReopenResponseSchema.parse(await (await page.request.get(
      `/api/project-contexts/${project}/source-documents/${source.sourceDocumentId}/reopen`)).json())
    const canonical = await (await page.request.get(reopen.sourceRepresentation.resources.parsedDocumentUrl)).json()
    const runId: string = canonical.document.document_id
    const anchorPage = new Map<string, number>(canonical.evidence_index.anchors.map(
      (anchor: { anchor_id: string; producer_observations: { page_number: number }[] }) =>
        [anchor.anchor_id, anchor.producer_observations[0]?.page_number]))

    // The schema arrives undeclared, as a legacy revision would: the selector is the only way to give it a scope.
    expect(schema.recordScope).toBeUndefined()
    const revision = await page.request.post('/api/schema-revisions', { headers, data: { projectContextId: project, ...schema } })
    expect(revision.status(), await revision.text()).toBe(201)
    expect((await revision.json()).revision.recordScope).toBeNull()

    page.setDefaultTimeout(120_000)
    const workspace = `/projects/${project}/documents/${source.sourceDocumentId}`
    await page.goto(workspace)
    const selector = page.getByRole('combobox', { name: 'Extraction strategy' })
    await expect(selector).toHaveValue('')
    await expect(page.getByRole('button', { name: /Run extraction/ })).toBeDisabled()
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/schema-revisions' &&
      response.request().method() === 'POST')
    await selector.selectOption(strategy)
    const scopeSave = await saved
    expect(scopeSave.status(), await scopeSave.text()).toBe(201)
    expect((await scopeSave.json()).revision.recordScope).toBe(strategy === 'ARTICLE' ? 'document' : 'records')
    await expect(page.getByText(/Unsaved changes|Saving…/)).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Extraction strategy' })).toHaveValue(strategy)

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
    await save('service-artifact.json', await (await fetch(`${service.url}/api/runs/${runId}/extractions/${id}`)).json())
    await save('canonical.json', canonical)
    await save('route.json', { id, runId, strategy, name, synthetic, scripted: !real, project, clock })
    expect(settled.extraction.failure).toBeNull()
    const result = (settled.extraction.resultPayload ?? {}) as Json
    const records = (valueAt(result, ['records']) ?? []) as Json[]
    if (strategy === 'ARTICLE') expect(records).toHaveLength(1)
    const links = settled.extraction.evidenceLinks!
    for (const link of links) expect(anchorPage.has(link.evidenceAnchorId)).toBe(true)
    // Required, not conditional: a populated list value with evidence.
    const chosen = target(result, links)
    expect(chosen, `no evidence-linked list value among ${links.length} evidence links`).toBeDefined()
    const original = String(valueAt(result, chosen!.resultPath))
    const edited = `${original} (reviewed)`

    await page.goto(workspace)
    await page.getByRole('tab', { name: /Results/ }).click()
    const item = await open(page, chosen!.resultPath, records.length)
    await page.getByRole('button', { name: `View Evidence for ${item}`, exact: true }).click()
    await highlighted(page, chosen!.evidenceAnchorId, anchorPage.get(chosen!.evidenceAnchorId)!)
    await page.screenshot({ path: join(output, 'evidence.png') })
    await page.getByRole('group', { name: `Review ${item}` }).getByRole('button', { name: `Edit ${item}` }).click()
    const box = page.getByRole('textbox', { name: `Reviewed value for ${item}`, exact: true })
    await box.fill(edited)
    await box.press('Enter')
    await expect(page.getByText(edited, { exact: true })).toBeVisible()
    // The evidence now supports the extracted value the edit replaced, and is labelled so.
    await page.getByRole('button', { name: `View Evidence for extracted value of ${item}`, exact: true }).click()
    await highlighted(page, chosen!.evidenceAnchorId, anchorPage.get(chosen!.evidenceAnchorId)!)
    await page.getByRole('button', { name: /Approve remaining/ }).click()
    await expect(page.getByText('Review saved', { exact: true })).toBeVisible({ timeout: 30_000 })
    clock.reviewed = new Date().toISOString()

    await page.reload()
    await page.getByRole('tab', { name: /Results/ }).click()
    await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Extraction strategy' })).toHaveValue(strategy)
    await open(page, chosen!.resultPath, records.length)
    await expect(page.getByText(edited, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: `View Evidence for extracted value of ${item}`, exact: true }).click()
    await highlighted(page, chosen!.evidenceAnchorId, anchorPage.get(chosen!.evidenceAnchorId)!)
    await page.screenshot({ path: join(output, 'reloaded.png') })
    const reviewed = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
    expect(reviewed.extraction.reviewedAt).not.toBeNull()
    await save('studio-reviewed.json', reviewed)

    for (const [format, label] of [['CSV', 'CSV'], ['XLSX', 'Excel']] as const) {
      await page.getByRole('button', { name: 'Export' }).click()
      const download = page.waitForEvent('download')
      await page.getByRole('dialog', { name: 'Export options' }).getByRole('button', { name: label, exact: true }).click()
      const file = await readFile((await (await download).path())!)
      await writeFile(join(output, `export.${format.toLowerCase()}`), file)
      const text = format === 'CSV' ? file.toString('utf8')
        : Object.entries(unzipSync(new Uint8Array(file))).filter(([path]) => path.endsWith('.xml'))
          .map(([, bytes]) => strFromU8(bytes)).join('\n')
      expect(text, `${format} carries the reviewed value`).toContain(edited)
    }
    clock.exported = new Date().toISOString()
    await save('route.json', { id, runId, strategy, name, synthetic, scripted: !real, project, clock,
      target: { path: chosen!.resultPath, anchor: chosen!.evidenceAnchorId, original, edited } })
  } finally {
    await service.close()
  }
})
