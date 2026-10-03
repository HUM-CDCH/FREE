import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import pluralize from 'pluralize'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionReadResponseSchema } from '../shared/extraction.contract.js'
import { fieldLabel } from '../src/claimStates.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { cataloguePdf, startRealService, textPdf } from './realService.js'
import { admit, settle } from './sourceIngestion.js'

/**
 * Evidence-review acceptance: one document through the application as a researcher drives it. The schema arrives
 * without a record scope; the Article/Catalog selector chooses it (saved at once, read back after a reload); the
 * workspace's Run admits the extraction with the account's saved method. Then, every step required: the Completion
 * region states the evidence checks; a claim whose check never finished is shown as not completed (from the list and
 * in the tree), with no evidence to view; a populated list value the verifier supported is opened in the source (its
 * anchor highlighted on its page, in view), edited, the edit keeps the extracted value's evidence labelled as the
 * extracted value's and shows that extracted value, the review is saved, the page reloaded, CSV carries the reviewed
 * value only and Excel adds the Extraction and Evidence sheets (identities, the edit's history, verifier outcomes).
 *
 * Without FREE_REAL_EXTRACT_URL the scripted model answers the stack's own site catalogue (selectors and controls, no
 * model call) and leaves the verifier's answer for one year (1802) out, so that claim is not completed. With it:
 * FREE_REAL_ROUTE_PDF + FREE_REAL_ROUTE_SCHEMA (recordDescription and schemaNodes, no scope) and
 * FREE_REAL_ROUTE_STRATEGY, or FREE_REAL_ROUTE_SYNTHETIC=nested, a labelled synthetic inspection report whose rooms
 * hold defects (an array inside each array item): a structural check, not extraction-quality evidence. A real document
 * decides whether an unfinished claim exists: a real route without one skips only the unfinished-claim steps, annotated
 * `not-exercised`; the scripted route must have one.
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

/** The value row (`PrimitiveRow`) whose name is `leaf`. */
function valueRow(page: Page, leaf: string) {
  return page.locator('div.group').filter({ has: page.getByText(leaf, { exact: true }) })
}

/** How the Results tab names the last step of `path`: a field by its name, an array item as `Site 2`. */
function stepLabel(path: Path): string {
  const last = path.at(-1)
  if (typeof last === 'string') return last
  const singular = pluralize.singular(String(path.at(-2) ?? 'item'))
  return `${singular.charAt(0).toUpperCase()}${singular.slice(1)} ${Number(last) + 1}`
}

/** The breadcrumb's current item once the tree shows `path`'s value: its parent (`Root` for a record's own field). */
function parentLabel(path: Path, records: number): string {
  const nav = path.slice(records > 1 ? 1 : 2, -1)
  return nav.length === 0 ? 'Root' : stepLabel(nav)
}

const unescapeXml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
const texts = (xml: string) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => unescapeXml(match[1]!)).join('')

/** One worksheet of an XLSX as rows keyed by the header names of its first row; every cell read as text. */
function sheetRows(files: Record<string, Uint8Array>, name: string): Record<string, string>[] {
  const xml = (path: string) => {
    const bytes = files[path]
    if (!bytes) throw new Error(`The workbook has no ${path}`)
    return strFromU8(bytes)
  }
  const sheet = [...xml('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => tag)
    .find((tag) => attribute(tag, 'name') === name)
  if (!sheet) throw new Error(`The workbook has no ${name} sheet`)
  const relation = [...xml('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => tag)
    .find((tag) => attribute(tag, 'Id') === attribute(sheet, 'r:id'))
  const target = attribute(relation ?? '', 'Target')
  if (!target) throw new Error(`The ${name} sheet has no worksheet`)
  const shared = files['xl/sharedStrings.xml']
    ? [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => texts(match[1]!)) : []
  const rows = [...xml(target.startsWith('/') ? target.slice(1) : `xl/${target}`).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)]
    .map(([, cells]) => Object.fromEntries([...cells!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, tag, body]) => {
      const value = /<v>([\s\S]*?)<\/v>/.exec(body ?? '')?.[1]
      const type = attribute(tag!, 't')
      return [attribute(tag!, 'r')!.replace(/\d+$/, ''), type === 's' ? shared[Number(value)]!
        : type === 'inlineStr' ? texts(body ?? '') : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE') : unescapeXml(value ?? '')]
    })))
  const [header, ...body] = rows
  if (!header) throw new Error(`The ${name} sheet is empty`)
  return body.map((row) => Object.fromEntries(Object.entries(header).map(([column, title]) => [title, row[column] ?? ''])))
}

/** The Evidence sheet's row for `path`: its Field (and, with several records, its 1-based Record). */
function evidenceRow(rows: Record<string, string>[], path: Path, records: number) {
  const field = fieldLabel(['records', 0, ...path.slice(2)], 1)
  const found = rows.filter((row) => row.Field === field && (records <= 1 || row.Record === String(Number(path[1]) + 1)))
  expect(found, `one Evidence row for ${JSON.stringify(path)}`).toHaveLength(1)
  return found[0]!
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
  const service = await startRealService(testInfo.outputPath('parsing-service.log'),
    real ? {} : { unansweredClaimValue: '1802' })
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
    // The schema header's Record scope names Article `document` and Catalog `records`.
    const recordScope = strategy === 'ARTICLE' ? 'document' : 'records'
    const selector = page.getByRole('combobox', { name: 'Record scope' })
    await expect(selector).toHaveValue('')
    await expect(page.getByRole('button', { name: /Run extraction/ })).toBeDisabled()
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/schema-revisions' &&
      response.request().method() === 'POST')
    await selector.selectOption(recordScope)
    const scopeSave = await saved
    expect(scopeSave.status(), await scopeSave.text()).toBe(201)
    expect((await scopeSave.json()).revision.recordScope).toBe(recordScope)
    await expect(page.getByText(/Unsaved changes|Saving…/)).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)

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
    const accounting = settled.extraction.diagnostics?.grounding?.claims
    expect(accounting, 'the extraction carries its claim accounting').toBeTruthy()
    const claims = accounting!
    if (!real) expect(claims.unfinished.length, 'the route must inspect an unfinished claim; this run produced none').toBeGreaterThan(0)
    const unfinished = claims.unfinished[0]
    await save('route.json', { id, runId, strategy, name, synthetic, scripted: !real, project, clock, claims,
      unfinished: unfinished?.resultPath ?? null })

    await page.goto(workspace)
    await page.getByRole('tab', { name: /Results/ }).click()
    const completion = page.getByRole('region', { name: 'Completion' })
    // A Catalog run may add rule-made links; an Article result never does.
    await expect(completion.locator('[data-dimension="evidence"]')).toHaveText(new RegExp(
      `^Evidence checks: ${claims.supported} verifier-supported · ${strategy === 'ARTICLE' ? '' : '(?:\\d+ linked by rule · )?'}` +
      `${claims.unsupported} unsupported · ${claims.notCompleted} not completed · ${claims.excluded} excluded by policy ` +
      `\\(${claims.claims} claims\\)$`))
    const notCompletedNote = page.getByRole('note', { name: real ? /^Not completed: The check did not finish/
      : 'Not completed: The check did not finish: the verifier did not answer for this value.', exact: true })
    if (unfinished) {
      // From the list of checks that never completed: Show opens the value, marked not completed.
      const label = fieldLabel(unfinished.resultPath, records.length)
      await completion.getByText(`Checks not completed (${claims.notCompleted})`).click()
      await completion.getByRole('button', { name: `Show ${label}` }).first().click()
      await expect(page.getByRole('navigation', { name: 'Result navigation' }).locator('[aria-current="page"]'))
        .toHaveText(parentLabel(unfinished.resultPath, records.length))
      const shown = valueRow(page, stepLabel(unfinished.resultPath)).filter({ has: notCompletedNote })
      await expect(shown).toHaveCount(1)
      await expect(shown).toBeVisible()
      // And through the tree: the value's own row is marked not completed and has no evidence to view.
      await page.goto(workspace)
      await page.getByRole('tab', { name: /Results/ }).click()
      const leaf = await open(page, unfinished.resultPath, records.length)
      const row = valueRow(page, leaf).filter({ has: notCompletedNote })
      await expect(row).toHaveCount(1)
      await expect(row).toBeVisible()
      await expect(row.getByRole('button', { name: `View Evidence for ${leaf}`, exact: true })).toHaveCount(0)
      await page.screenshot({ path: join(output, 'not-completed.png') })
      await page.goto(workspace)
      await page.getByRole('tab', { name: /Results/ }).click()
    } else {
      // Only a real route reaches this (the scripted route failed above): its document left no claim unfinished, so
      // the unfinished-claim steps (here, the Evidence sheet's not-completed row, the saved-review clause) are skipped.
      testInfo.annotations.push({ type: 'not-exercised',
        description: 'no unfinished claim in this route; the unfinished-claim step was not exercised' })
    }

    const item = await open(page, chosen!.resultPath, records.length)
    // The nested value the review edits was supported by the verifier, and says so.
    const chosenRow = valueRow(page, item)
    await expect(chosenRow).toHaveCount(1)
    await expect(chosenRow.getByText(/^Verifier-supported/)).toBeVisible()
    await page.getByRole('button', { name: `View Evidence for ${item}`, exact: true }).click()
    await highlighted(page, chosen!.evidenceAnchorId, anchorPage.get(chosen!.evidenceAnchorId)!)
    await page.screenshot({ path: join(output, 'evidence.png') })
    await page.getByRole('group', { name: `Review ${item}` }).getByRole('button', { name: `Edit ${item}` }).click()
    const box = page.getByRole('textbox', { name: `Reviewed value for ${item}`, exact: true })
    await box.fill(edited)
    await box.press('Enter')
    await expect(page.getByText(edited, { exact: true })).toBeVisible()
    await expect(chosenRow.getByText(`Extracted value: ${original}`, { exact: true })).toBeVisible()
    // The evidence now supports the extracted value the edit replaced, and is labelled so.
    await page.getByRole('button', { name: `View Evidence for extracted value of ${item}`, exact: true }).click()
    await highlighted(page, chosen!.evidenceAnchorId, anchorPage.get(chosen!.evidenceAnchorId)!)
    await page.getByRole('button', { name: /Approve remaining/ }).click()
    await expect(page.getByText('Review saved', { exact: true })).toBeVisible({ timeout: 30_000 })
    clock.reviewed = new Date().toISOString()

    await page.reload()
    await page.getByRole('tab', { name: /Results/ }).click()
    await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
    if (unfinished) await expect(page.getByText(new RegExp(
      `values? without evidence (?:was|were) not reviewed; ${claims.notCompleted} checks? never completed`))).toBeVisible()
    // The Record scope is in the Schema tab's header; the review continues in Results.
    await page.getByRole('tab', { name: /^Schema/ }).click()
    await expect(page.getByRole('combobox', { name: 'Record scope' })).toHaveValue(strategy === 'ARTICLE' ? 'document' : 'records')
    await page.getByRole('tab', { name: /Results/ }).click()
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
      const dialog = page.getByRole('dialog', { name: 'Export options' })
      await expect(dialog.getByRole('note').filter({ hasText: /^CSV holds the values only/ })).toBeVisible()
      const download = page.waitForEvent('download')
      await dialog.getByRole('button', { name: label, exact: true }).click()
      const file = await readFile((await (await download).path())!)
      await writeFile(join(output, `export.${format.toLowerCase()}`), file)
      if (format === 'CSV') {
        const text = file.toString('utf8')
        expect(text, 'CSV carries the reviewed value').toContain(edited)
        expect(text, 'CSV holds the values only').not.toContain('Evidence anchor')
        continue
      }
      // The workbook adds the Extraction and Evidence sheets: identities, the edit's history and verifier outcomes.
      const files = unzipSync(new Uint8Array(file))
      // The Results sheet joins a list into one cell ("a, b"), as the CSV does: the edited item is inside a cell. The
      // Evidence sheet, one row per claim, holds it alone (below).
      expect(sheetRows(files, 'Results').flatMap(Object.values).filter((cell) => cell.includes(edited)),
        'Excel carries the reviewed value').not.toHaveLength(0)
      const identity = new Map(sheetRows(files, 'Extraction').map((row) => [row.Item, row.Value]))
      expect(identity.get('Extraction ID')).toBe(id)
      expect(identity.get('Source Representation Revision ID')).toBe(settled.extraction.sourceRepresentationRevisionId)
      expect(identity.get('Schema Revision ID')).toBe(settled.extraction.schemaRevisionId)
      expect(identity.get('Not completed')).toBe(String(claims.notCompleted))
      const evidence = sheetRows(files, 'Evidence')
      expect(evidenceRow(evidence, chosen!.resultPath, records.length), 'the edited value keeps its history and evidence')
        .toMatchObject({ Decision: 'EDITED', 'Extracted value': original, 'Reviewed value': edited,
          'Evidence anchor': chosen!.evidenceAnchorId, 'Verifier outcome': 'Verifier-supported' })
      if (unfinished) {  // without one, annotated `not-exercised` above
        const row = evidenceRow(evidence, unfinished.resultPath, records.length)
        expect(row['Verifier outcome'], 'the unfinished claim').toBe('Not completed')
        for (const reason of unfinished.reasons) expect(row.Reasons).toContain(reason)
      }
    }
    clock.exported = new Date().toISOString()
    await save('route.json', { id, runId, strategy, name, synthetic, scripted: !real, project, clock, claims,
      unfinished: unfinished?.resultPath ?? null,
      target: { path: chosen!.resultPath, anchor: chosen!.evidenceAnchorId, original, edited } })
  } finally {
    await service.close()
  }
})
