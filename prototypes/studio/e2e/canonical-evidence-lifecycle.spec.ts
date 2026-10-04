import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { db } from '../../../packages/db/src/prisma/db.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionAttemptSchema, type ExtractionAttempt } from '../shared/extraction.contract.js'
import { keiExpArtifact, keiExpEvidence } from 'extraction/kei-exp-fixture'
import type { ProgressDocument } from 'extraction'
import type { KeiExtractInput } from 'extraction/kei-handoff'
import { launchKeiStandIn, type KeiStandIn, type StandInDecision } from 'extraction/kei-stand-in'
import { DEVELOPMENT_ENTRA_TENANT_ID } from '../server/entraIdentityProvider.js'
import {
  E2E_ORIGIN,
  e2eStudioPath,
  loginResearcher,
} from './auth.js'
import { canonicalPackage } from './interactiveStack.js'
import { approveRest } from './resultsReview.js'
import {
  activateWithKeyboard,
  emulateBrowserZoom200,
  expectOperableInViewport,
  REQUIRED_VIEWPORTS,
} from './accessibility.js'

test.describe.configure({ mode: 'serial' })

const extractionDatabaseReady = () =>
  Boolean(process.env.EXTRACTION_TEST_DATABASE_URL) &&
  process.env.DATABASE_URL === process.env.EXTRACTION_TEST_DATABASE_URL

/** How the kei stand-in answers the next extraction it runs; each test starts from the defaults. */
const kei = {
  codebook: false,
  omitGrounding: false,
  blockNextValues: false,
  blockNextResult: false,
  failNextValues: false,
  incompleteNextResult: false,
  groundedLimit: null as number | null,
  progress: null as ProgressDocument | null,
  lastStartPage: null as number | null,
  /** The next result's records in place of the lifecycle record (the Catalog run reviewed while it reads). */
  records: null as Record<string, unknown>[] | null,
}
const resultGate: { release: (() => void) | null } = { release: null }
const valuesGate: { release: (() => void) | null } = { release: null }

/** kei's `extract` as this spec scripts it: kei-exp's artifact for the request, grounded unless a switch says
 *  otherwise, answered at once unless a gate holds it. */
async function extractFor(request: KeiExtractInput): Promise<StandInDecision<{ artifact: unknown }>> {
  const startPage = request.request.options.start_page
  kei.lastStartPage = typeof startPage === 'number' ? startPage : null
  if (kei.failNextValues) {
    kei.failNextValues = false
    return { failure: { code: 'extraction_failed', reason: 'Deterministic extraction failure.', retryable: false } }
  }
  const { schema, options } = request.request
  const nodes = (schema as { schemaNodes: Array<{ name: string; type: string }> }).schemaNodes
  const records = kei.records ?? (kei.codebook ? [Object.fromEntries(nodes.map((node) => [node.name,
    node.type === 'integer' ? 1801 : 'Résumé, source\nline']))] : [{
    title: 'Résumé, source\nline',
    [nodes.some((node) => node.name === 'year_of_record') ? 'year_of_record' : 'year']: 1801,
    tags: ['æ', 'quoted "tag"'],
    findings: [{ kind: 'A', detail: 'First,\nline' }, { kind: 'B', detail: 'Second' }],
  }])
  kei.records = null
  const paths = (value: unknown, path: (string | number)[] = []): (string | number)[][] =>
    Array.isArray(value) ? value.flatMap((item, i) => paths(item, [...path, i])) :
    value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => paths(item, [...path, key])) : [path]
  const ungrounded = kei.omitGrounding || kei.incompleteNextResult
  kei.incompleteNextResult = false
  const resultPaths = paths({ records })
  const groundedPaths = ungrounded ? [] : resultPaths.slice(0, kei.groundedLimit ?? resultPaths.length)
  const ungroundedPaths = resultPaths.slice(groundedPaths.length)
  kei.groundedLimit = null
  const artifact = keiExpArtifact({
    run_id: request.run_id, generation: request.generation, fingerprint: randomUUID(),
    strategy: options.strategy === 'catalog' ? 'catalog' : 'article', model: 'fixture/nuextract',
    models: { fields: 'fixture/nuextract', reasoning: 'fixture/nuextract' },
    schema: schema as { recordDescription: string; schemaNodes: unknown[] },
    // kei-exp records the options it ran under, `models` null when the run kept the deployment defaults.
    options: { model: null, models: null, ...options } as never,
    started: new Date().toISOString(), seconds: 0.1, complete: ungroundedPaths.length === 0, records,
    evidence: groundedPaths.map(path => keiExpEvidence({ path, verbatim: false, hits: 0, linked_by: 'model' })),
    ungrounded: ungroundedPaths,
  })
  if (kei.blockNextValues || kei.blockNextResult) {
    const gate = kei.blockNextValues ? valuesGate : resultGate
    kei.blockNextValues = false
    kei.blockNextResult = false
    await new Promise<void>((released) => {
      gate.release = () => {
        gate.release = null
        released()
      }
    })
  }
  return { output: { artifact } }
}

/** A page-2 answer before a page-1 record in source order; the stand-in holds
 * settlement so the browser must observe progress through Studio's real poll. */
function progressFor(strategy: 'ARTICLE' | 'CATALOG'): ProgressDocument {
  if (strategy === 'ARTICLE')
    return {
      version: 1, strategy: 'article', started_at_page: 2, discovered: 1, finished: 0,
      entries: [{ index: 0, label: null, page: null, stage: 'candidates',
        candidates: [{ path: ['title'], value: 'First context', quote: null, window: 0 }],
        record: { title: 'First context' }, evidence: [], contested: [], failed: 0 }],
      document: { contexts: [{ primary: ['p2_s0'], overlap: [] }], answered: 1, of: 2,
        failed_contexts: 0, links: [], grounding_batches: 0 },
    }
  return {
    version: 1, strategy: 'catalog', started_at_page: 2, discovered: 3, finished: 1,
    entries: [
      { index: 0, label: 'Waiting', page: 1, stage: 'queued', candidates: null,
        record: null, evidence: null, contested: null, failed: null },
      { index: 1, label: 'First', page: 2, stage: 'finished', candidates: null,
        record: { title: 'First record' },
        evidence: [keiExpEvidence({ path: ['records', 1, 'title'] })], contested: [], failed: null },
      { index: 2, label: 'Second', page: 2, stage: 'candidates',
        candidates: [{ path: ['title'], value: 'Second record', quote: null, window: 0 }],
        record: { title: 'Second record' }, evidence: null, contested: null, failed: 0 },
    ],
    document: null,
  }
}

let standIn: KeiStandIn | undefined

/** The Results rail (results review redesign §2–§3): its header's status line, review bar and breakdown line, and its
 *  rows, each a button named "{state} {name} {value} {chip}". */
const resultsPanel = (page: Page) => page.getByRole('tabpanel', { name: /Results/ })

const railPane = (page: Page) => page.getByRole('complementary', { name: 'Evidence, schema and results' })

/** Drags the rail's handle until the rail is `width` wide (its 264–560px clamp holds the minimum). */
async function setRailWidth(page: Page, width: number) {
  const current = (await railPane(page).boundingBox())!.width
  if (current === width) return
  const handle = (await page.locator('[title="Drag to resize"]:not([role="separator"])').boundingBox())!
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + (current - width), y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await railPane(page).boundingBox())!.width).toBe(width)
}

/** The rail's narrow layouts (results review redesign §9), measured in a real browser: at 344px the chips are one
 *  row and the list scrolls only vertically; at 264px the chips become a labelled select and the count block's
 *  actions each take a full-width line. */
async function expectRailLayouts(page: Page) {
  const panel = resultsPanel(page)
  const noSideScroll = () => panel.evaluate((element) => [...element.querySelectorAll<HTMLElement>('*')]
    .filter((each) => each.scrollWidth > each.clientWidth + 1 && getComputedStyle(each).overflowX === 'auto' && !each.matches('[role="group"]')).length)
  await setRailWidth(page, 344)
  const chips = panel.getByRole('group', { name: 'Show values' })
  await expect(chips).toBeVisible()
  await expect(panel.getByRole('combobox', { name: 'Show' })).toBeHidden()
  const tops = await chips.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top))
  expect(new Set(tops).size).toBe(1)
  expect(await noSideScroll()).toBe(0)
  await setRailWidth(page, 264)
  await expect(chips).toBeHidden()
  await expect(panel.getByRole('combobox', { name: 'Show' })).toBeVisible()
  const header = (await panel.getByRole('button', { name: /One by one/ }).boundingBox())!
  const approve = (await panel.getByRole('button', { name: 'Approve rest…' }).boundingBox())!
  expect(Math.abs(header.width - approve.width)).toBeLessThanOrEqual(1)
  expect(approve.y).toBeGreaterThan(header.y + header.height - 1)
  expect(header.width).toBeGreaterThan(200)
  expect(await noSideScroll()).toBe(0)
  await setRailWidth(page, 344)
}

/** With RAIL_SHOTS=1, the rail at 1280×720 at its 344px default and its 264px minimum, for the visual check against
 *  the prototype (results review redesign); otherwise nothing. */
async function railShots(page: Page, testInfo: TestInfo, stage: string) {
  if (!process.env.RAIL_SHOTS) return
  const viewport = page.viewportSize()
  await page.setViewportSize({ width: 1280, height: 720 })
  for (const width of [344, 264]) {
    await setRailWidth(page, width)
    await page.screenshot({ path: testInfo.outputPath(`rail-${stage}-${width}.png`) })
  }
  await setRailWidth(page, 344)
  if (viewport) await page.setViewportSize(viewport)
}
const statusLine = (page: Page) => resultsPanel(page).locator('p:has(> b)').first()
const reviewBar = (page: Page) => resultsPanel(page).getByRole('img', { name: / to check, of \d+$/ })
const breakdown = (page: Page) => resultsPanel(page).locator('p').filter({ hasText: /^\d+ approved · \d+ edited · \d+ rejected · / })
const valueRow = (page: Page, name: RegExp) => resultsPanel(page).getByRole('button', { name })
const decisionFor = (page: Page, name: string, action: 'Approve' | 'Edit' | 'Reject' | 'Approve and save review' | 'Reject and save review') =>
  resultsPanel(page).getByRole('group', { name: `Decision for ${name}`, exact: true }).getByRole('button', { name: action, exact: true })
const approveRestButton = (page: Page) => resultsPanel(page).getByRole('button', { name: 'Approve rest…', exact: true })
const moreActions = (page: Page) => resultsPanel(page).getByRole('button', { name: 'More result actions', exact: true })
const runDetails = (page: Page) => page.getByRole('dialog', { name: 'Run details', exact: true })
/** The Review Draft's acknowledged write: what "draft saved" stands for (the breakdown's idle default reads the same). */
const draftWritten = (page: Page) => page.waitForResponse((response) => response.request().method() === 'POST' &&
  new URL(response.url()).pathname.endsWith('/review/draft') && response.ok())

async function moreAction(page: Page, label: string) {
  await moreActions(page).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

// kei on DBOS, played by the stand-in (plan Ruling 12): an application named `kei` on the Playwright database's
// `kei_dbos`, which Studio's kei client enqueues to, serving kei's read routes on the port Studio's KEI_EXP_URL names.
// It runs in this worker, which runs no other DBOS application: the spec is serial and the only one that starts one.
test.beforeAll(async () => {
  if (!extractionDatabaseReady()) return
  const keiUrl = new URL(process.env.FREE_PLAYWRIGHT_KEI_EXP_URL!)
  standIn = await launchKeiStandIn({
    databaseUrl: process.env.DATABASE_URL!,
    schema: 'kei_dbos',
    port: Number(keiUrl.port),
    executorId: `kei-e2e-${keiUrl.port}`,
    script: { extract: (request) => extractFor(request), progress: () => kei.progress },
  })
})

test.afterAll(async () => {
  resultGate.release?.()
  valuesGate.release?.()
  await standIn?.close()
})

async function waitForExtraction(
  request: APIRequestContext,
  extractionId: string,
  predicate: (attempt: ExtractionAttempt) => boolean = (attempt) =>
    attempt.executionStatus === 'COMPLETED' || attempt.executionStatus === 'FAILED',
): Promise<ExtractionAttempt> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const response = await request.get(
      e2eStudioPath(`/api/extractions/${extractionId}`),
    )
    if (response.ok()) {
      const attempt = extractionAttemptSchema.parse(
        (await response.json()).extraction,
      )
      if (predicate(attempt)) return attempt
    }
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for Extraction ${extractionId}.`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
}

const lifecycleSchemaNodes = [
  { id: 'title', name: 'title', type: 'string' },
  { id: 'year', name: 'year', type: 'integer' },
  { id: 'tags', name: 'tags', type: 'array', itemType: 'string' },
  {
    id: 'findings', name: 'findings', type: 'array', children: [
      { id: 'kind', name: 'kind', type: 'string' },
      { id: 'detail', name: 'detail', type: 'verbatim-string' },
    ],
  },
] as const

for (const strategy of ['ARTICLE', 'CATALOG'] as const)
test(`real ${strategy} lifecycle persists review, exports its reviewed result, and reopens newer unreviewed pins independently @deterministic`, async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(240_000)
  test.skip(
    !extractionDatabaseReady(),
    'DATABASE_URL must equal the disposable EXTRACTION_TEST_DATABASE_URL',
  )

  Object.assign(kei, {
    omitGrounding: false, blockNextValues: false, blockNextResult: false, failNextValues: false, incompleteNextResult: false, groundedLimit: null,
    progress: null, lastStartPage: null, records: null,
  })
  // Each Playwright config gives the stand-in its own port and points Studio's KEI_EXP_URL at it.
  const keiUrl = new URL(process.env.FREE_PLAYWRIGHT_KEI_EXP_URL!)
  const connectionId = randomUUID()

  const projectContextId = randomUUID()
  const researcherAccountId = randomUUID()
  const researcherObjectId = randomUUID()
  const sourceDocumentId = randomUUID()
  const otherSourceDocumentId = randomUUID()
  const extractionSchemaId = randomUUID()
  const firstRepresentationId = randomUUID()
  const otherRepresentationId = randomUUID()
  const secondRepresentationId = randomUUID()
  const firstSchemaRevisionId = randomUUID()
  const secondSchemaRevisionId = randomUUID()
  const packageStore = createCanonicalPackageStore()
  const firstPackage = await canonicalPackage('reviewed.pdf')
  const firstDescriptor = await packageStore.save(firstPackage.bytes)

  await db.orm.public.ResearcherAccount.create({
    id: researcherAccountId,
    tenantId: DEVELOPMENT_ENTRA_TENANT_ID,
    objectId: researcherObjectId,
    displayName: 'Canonical Evidence Researcher',
  })
  await db.orm.public.ModelConfiguration.create({
    researcherAccountId,
    document: {
      connections: [
        {
          id: connectionId,
          name: 'Article lifecycle fixture',
          provider: 'ollama',
          baseUrl: `http://127.0.0.1:${keiUrl.port}`,
          hasKey: false,
        },
      ],
      routes: {
        schemaSuggestion: {
          connectionId,
          modelId: 'fixture/nuextract',
        },
        interaction: null,
      },
      // The researcher's Extraction Model Choice every run is requested on.
      extractionModels: { fields: 'instruct' },
      ingestionModels: {},
      extractionSettings: {},
    },
  })
  // What this account's start view submits with each run: the saved field model and service-default settings.
  const savedMethod = { models: { fields: 'instruct' }, settings: strategy === 'CATALOG' ? { generic: null } : { article: null } }
  // The schema's saved Article/Catalog scope is what the toolbar shows and every run here uses.
  const recordScope = strategy === 'CATALOG' ? 'records' : 'document'
  await db.orm.public.ProjectContext.create({
    id: projectContextId,
    researcherAccountId,
    name: 'Article lifecycle E2E',
  })
  await db.orm.public.SourceDocument.create({
    id: sourceDocumentId,
    projectContextId,
    contentSha256: firstPackage.sourceHash,
    mediaType: 'application/pdf',
    originalName: 'article-lifecycle.pdf',
  })
  await db.orm.public.SourceRepresentationRevision.create({
    id: firstRepresentationId,
    sourceDocumentId,
    revisionNumber: 1,
    artifactReference: firstDescriptor.artifactReference,
    artifactSha256: firstDescriptor.artifactSha256,
    contractVersion: 'parsed_document.v2',
    // Written by ingestion from kei's convert output: the run and generation runExtraction hands to kei.
    preprocessId: `kei-exp:e2e-${firstRepresentationId}:g1`,
    parserName: 'fixture',
    parserVersion: '1',
  })
  await db.orm.public.ExtractionSchema.create({
    id: extractionSchemaId,
    projectContextId,
    name: 'Article lifecycle schema',
  })
  await db.orm.public.SchemaRevision.create({
    id: firstSchemaRevisionId,
    extractionSchemaId,
    revisionNumber: 1,
    origin: 'RESEARCHER_EDIT',
    schemaTree: {
      recordDescription: 'One lifecycle fixture record.',
      schemaNodes: lifecycleSchemaNodes,
    },
    recordScope,
  })

  const internalUrl = `/projects/${projectContextId}/documents/${sourceDocumentId}`
  const url = e2eStudioPath(internalUrl)
  await loginResearcher(page, researcherObjectId)
  await page.goto(url)
  await expect(page).toHaveURL(url)
  await expect(page.getByText('/ 6', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  let interactivePosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/extractions'))
      interactivePosts += 1
  })
  // The configured Extraction Model Choice goes with the run and stays with its Extraction; the header offers none.
  await expect(page.getByRole('combobox', { name: 'Field model' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)
  const journeyViewport = page.viewportSize()!
  await page.getByLabel('Current page').fill('2')
  await page.getByLabel('Current page').press('Enter')
  kei.blockNextResult = true
  kei.progress = progressFor(strategy)
  // The Catalog result settles with the records the run read, so a decision drafted on one is kept (§5.3).
  if (strategy === 'CATALOG') kei.records = [{ title: 'Waiting record' }, { title: 'First record' }, { title: 'Second record' }]
  await page.getByRole('button', { name: '▶ Run extraction' }).dblclick()
  const stopExtraction = page.getByRole('button', { name: /■ Stop extraction/ })
  await expect(stopExtraction).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => kei.lastStartPage).toBe(2)
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(statusLine(page)).toHaveText(strategy === 'CATALOG'
    ? /^Reading records\s*· 1 of 3 · from page 2$/ : /^Reading the document\s*· 1 of 2 contexts$/)
  await expect(page.getByRole('tab', { name: /Results/ })).toContainText(strategy === 'CATALOG' ? '1 of 3' : '0 of 1')
  // The review cannot be saved while the run reads (§5.1).
  await expect(approveRestButton(page)).toBeDisabled()
  await expect(approveRestButton(page)).toHaveAttribute('title', 'Available when the run finishes')
  if (strategy === 'CATALOG') {
    await expect(resultsPanel(page).locator('section[aria-label]')).toHaveText([/First/, /Second/, /Waiting/])
    await expect(resultsPanel(page).getByRole('region', { name: 'First, 1 to check', exact: true })).toBeVisible()
    const first = resultsPanel(page).getByRole('region', { name: /^First, / })
    await expect(first).toContainText('Record 2 · p.2')
    await expect(first.getByRole('button', { name: /^To check title First record/ })).toBeVisible()
    const second = resultsPanel(page).getByRole('region', { name: /^Second, Checking/ })
    await expect(second.getByTitle('Candidate · being checked against the source')).toHaveText('Second record')
    await expect(second.getByRole('button', { name: /^To check / })).toHaveCount(0)
    await expect(resultsPanel(page).getByRole('region', { name: 'Waiting, Queued', exact: true })).toBeVisible()
    // Review during the run (§5): a value of the finished record is decided now, a draft until the run finishes.
    await first.getByRole('button', { name: /^To check title First record/ }).click()
    await resultsPanel(page).getByRole('button', { name: /One by one/ }).click()
    const drafted = draftWritten(page)
    await page.keyboard.press('a')
    await drafted
    await expect(resultsPanel(page).getByRole('heading', { level: 2 })).toHaveText('First is checked')
    await resultsPanel(page).getByRole('button', { name: 'Back to list', exact: true }).click()
    await expect(first.getByRole('button', { name: /^Approved title First record/ })).toBeFocused()
    await expect(first.getByRole('button', { name: /^Approved title First record/ })).toBeVisible()
    await expect(breakdown(page)).toHaveText('1 approved · 0 edited · 0 rejected · draft until the run finishes')
    await expect(first).toHaveAccessibleName('First, all checked')
    await railShots(page, testInfo, 'review-while-reading')
  } else {
    await expect(resultsPanel(page).getByTitle('Candidate · being checked against the source')).toHaveText('First context')
    await expect(resultsPanel(page).getByRole('button', { name: /^To check / })).toHaveCount(0)
  }
  await expect.poll(() => resultGate.release !== null).toBe(true)
  // Settlement moves nothing (§5.3): the decided row keeps its place on the screen.
  const beforeSettlement = strategy === 'CATALOG' ? await valueRow(page, /^Approved title First record/).boundingBox() : null
  kei.progress = null
  resultGate.release!()
  // With the rail open on Results its settlement toast is the one notice; App's "Review now" toast stays away (§2.5).
  // §5.3: the toast counts after the settled review is read; the Catalog run kept the decision drafted while it read.
  await expect(resultsPanel(page).getByRole('status').filter({ hasText: /^Run finished · / })).toHaveText(strategy === 'CATALOG'
    ? /^Run finished · your 1 decision kept · 2 to check\./ : /^Run finished · \d+ to check\./, { timeout: 20_000 })
  await expect(statusLine(page)).toHaveText(/^Completed/)
  await expect(page.getByRole('button', { name: 'Review now', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Extraction finished', exact: true })).toHaveCount(0)
  expect(interactivePosts).toBe(1)
  if (strategy === 'CATALOG') {
    // Settlement moved nothing: the decided value still reads Approved, where it was; Approve rest… saves the rest.
    await expect(valueRow(page, /^Approved title First record/)).toBeVisible()
    const afterSettlement = await valueRow(page, /^Approved title First record/).boundingBox()
    expect(Math.abs(afterSettlement!.y - beforeSettlement!.y)).toBeLessThanOrEqual(1)
    await railShots(page, testInfo, 'settled')
    await expectRailLayouts(page)
    await expect(reviewBar(page)).toHaveAccessibleName('1 approved, 0 edited, 0 rejected, 2 to check, of 3')
    // One by one (§4): A approves the current value and moves on, J skips, Z undoes the approval; Escape leaves.
    await resultsPanel(page).getByRole('button', { name: /One by one/ }).click()
    const current = resultsPanel(page).getByRole('heading', { level: 2 })
    await expect(current).toBeFocused()
    await railShots(page, testInfo, 'one-by-one')
    await current.focus()
    await page.keyboard.press('a')
    await expect(reviewBar(page)).toHaveAccessibleName('2 approved, 0 edited, 0 rejected, 1 to check, of 3')
    await expect(current).toBeFocused()
    await page.keyboard.press('j')
    await page.keyboard.press('z')
    await expect(reviewBar(page)).toHaveAccessibleName('1 approved, 0 edited, 0 rejected, 2 to check, of 3')
    await page.keyboard.press('k')
    await expect(current).toBeFocused()
    // Edit/Enter persists the draft, then R on the last value saves the review (§4.4, §6).
    await page.keyboard.press('e')
    const focusedEditor = resultsPanel(page).getByRole('textbox', { name: 'Reviewed value', exact: true })
    await focusedEditor.fill('Second record (reviewed)')
    await focusedEditor.press('Enter')
    await expect(reviewBar(page)).toHaveAccessibleName('1 approved, 1 edited, 0 rejected, 1 to check, of 3')
    await railShots(page, testInfo, 'last-decision')
    await expect(current).toBeFocused()
    await page.keyboard.press('r')
    await expect(current).toHaveText('Review saved', { timeout: 20_000 })
    await expect(reviewBar(page)).toHaveAccessibleName('1 approved, 1 edited, 1 rejected, 0 to check, of 3')
    await page.keyboard.press('Escape')
    await expect(resultsPanel(page).getByRole('group', { name: 'Show values' })).toBeVisible()
    await expect(valueRow(page, /^Rejected title /)).toBeFocused()
    await expect(statusLine(page)).toHaveText(/^Review saved\s*· \d+ decisions · read-only$/, { timeout: 20_000 })
    await railShots(page, testInfo, 'saved')
    await page.reload()
    await page.getByRole('tab', { name: /Results/ }).click()
    await expect(statusLine(page)).toHaveText(/^Review saved\s*· \d+ decisions · read-only$/, { timeout: 20_000 })
    await resultsPanel(page).getByRole('button', { name: /^First record/ }).click()
    await valueRow(page, /^Approved title First record/).click()
    await expect(resultsPanel(page).getByText('Approved · saved', { exact: true })).toBeVisible()
    await expect(resultsPanel(page).getByRole('group', { name: /^Decision for / })).toHaveCount(0)
    await expect(approveRestButton(page)).toHaveCount(0)
  }
  const chosen = await db.orm.public.Extraction.where({ sourceDocumentId })
    .select('requestedModels', 'diagnostics').first()
  expect(chosen?.requestedModels).toEqual({ fields: 'instruct' })
  expect((chosen?.diagnostics as { models?: unknown } | undefined)?.models)
    .toEqual({ fields: 'fixture/nuextract', reasoning: 'fixture/nuextract' })
  if (strategy === 'CATALOG') {
    // The run reviewed above is saved; the journey below reviews a newer, unreviewed Extraction of the same pins.
    const journeyId = randomUUID()
    expect((await page.request.post(e2eStudioPath('/api/extractions'), {
      headers: { Origin: E2E_ORIGIN },
      data: { id: journeyId, sourceRepresentationRevisionId: firstRepresentationId, schemaRevisionId: firstSchemaRevisionId,
        strategy, method: savedMethod },
    })).status()).toBe(201)
    await waitForExtraction(page.request, journeyId, (attempt) => attempt.executionStatus === 'COMPLETED')
  }

  const otherPackage = await canonicalPackage(
    'different-document.pdf',
    undefined,
    '1790-06-17-1.pdf',
  )
  const otherDescriptor = await packageStore.save(otherPackage.bytes)
  await db.orm.public.SourceDocument.create({
    id: otherSourceDocumentId,
    projectContextId,
    contentSha256: otherPackage.sourceHash,
    mediaType: 'application/pdf',
    originalName: 'different-document.pdf',
  })
  await db.orm.public.SourceRepresentationRevision.create({
    id: otherRepresentationId,
    sourceDocumentId: otherSourceDocumentId,
    revisionNumber: 1,
    artifactReference: otherDescriptor.artifactReference,
    artifactSha256: otherDescriptor.artifactSha256,
    contractVersion: 'parsed_document.v2',
    preprocessId: `kei-exp:e2e-${otherRepresentationId}:g1`,
    parserName: 'fixture',
    parserVersion: '1',
  })

  await page.goto(
    e2eStudioPath(
      `/projects/${projectContextId}/documents/${otherSourceDocumentId}`,
    ),
  )
  await expect(page.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)
  // This run completes in the narrow layout (under 860px), where the open rail overlays the page's right side.
  await page.setViewportSize({ width: 820, height: 900 })
  await activateWithKeyboard(
    page,
    page.getByRole('button', { name: '▶ Run extraction' }),
  )
  const reviewNow = page.getByRole('button', { name: 'Review now', exact: true })
  await expect(reviewNow).toBeVisible({ timeout: 20_000 })
  await expect(
    page.getByText('Unexpected model key: surprise', { exact: true }),
  ).toHaveCount(0)
  // Completion announces itself in one toast (decision 04) but never switches the rail tab; its Review now does.
  await expect(page.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByRole('dialog', { name: 'Extraction finished', exact: true })).toHaveCount(0)
  // It floats over the page under the PDF toolbar, never over the toolbar's controls.
  const pdfToolbar = (await page.getByRole('region', { name: 'PDF document' }).locator('> div').first().boundingBox())!
  const completionToast = (await page.getByRole('status').filter({ hasText: 'Extraction complete' }).boundingBox())!
  expect(completionToast.y, 'the completion toast below the PDF toolbar').toBeGreaterThanOrEqual(pdfToolbar.y + pdfToolbar.height)
  // The toast and its Review now stay above the rail's overlay: the pointer at Review now reaches it, and an unforced
  // click (refused by Playwright were anything else to receive it) opens Results.
  const reviewNowBox = (await reviewNow.boundingBox())!
  const railBox = (await page.getByRole('complementary', { name: 'Evidence, schema and results' }).boundingBox())!
  expect(railBox.x, '820px: the open rail overlays Review now\'s place').toBeLessThan(reviewNowBox.x + reviewNowBox.width)
  expect(await reviewNow.evaluate((element, [x, y]) => element.contains(document.elementFromPoint(x!, y!)),
    [reviewNowBox.x + reviewNowBox.width / 2, reviewNowBox.y + reviewNowBox.height / 2]), '820px: Review now is the hit target').toBe(true)
  await page.screenshot({ path: testInfo.outputPath('completion-toast-820px.png') })
  await reviewNow.click({ timeout: 3_000 })
  await expect(page.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true')
  await expect(reviewNow).toHaveCount(0)
  await page.setViewportSize(journeyViewport)
  await expect(valueRow(page, /^To check title /)).toBeVisible()

  await page.goto(url)
  await activateWithKeyboard(page, page.getByRole('tab', { name: /Results/ }))
  const titleRow = valueRow(page, /^To check title /)
  await expect(titleRow).toBeVisible()
  await expect(reviewBar(page)).toHaveAccessibleName(/^0 approved, 0 edited, 0 rejected, (\d+) to check, of \1$/)
  const requiredCount = Number((await reviewBar(page).getAttribute('aria-label'))!.match(/of (\d+)$/)![1])
  const counted = (edited: number) =>
    `0 approved, ${edited} edited, 0 rejected, ${requiredCount - edited} to check, of ${requiredCount}`
  await expect(approveRestButton(page)).toBeEnabled()
  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport)
    await expectOperableInViewport(page, titleRow)
    await expectOperableInViewport(page, moreActions(page))
    await expectOperableInViewport(page, reviewBar(page))
    await expectOperableInViewport(page, approveRestButton(page))
    if (viewport.width === 390) await page.screenshot({ path: testInfo.outputPath('review-progress-mobile.png'), fullPage: true })
    // Before the review is saved, Export is in ⋯ (§8).
    await activateWithKeyboard(page, moreActions(page))
    await activateWithKeyboard(page, page.getByRole('menuitem', { name: 'Export…', exact: true }))
    const responsiveExportDialog = page.getByRole('dialog', {
      name: 'Export options',
    })
    await expectOperableInViewport(
      page,
      responsiveExportDialog.getByRole('button', { name: 'CSV' }),
    )
    await page.keyboard.press('Escape')
    await expect(responsiveExportDialog).toBeHidden()
    await expect(moreActions(page)).toBeFocused()
  }
  // The count and Approve rest… stay operable, with no horizontal scroll, at every width, including 360 px.
  for (const viewport of [{ width: 360, height: 800 }, ...REQUIRED_VIEWPORTS]) {
    await page.setViewportSize(viewport)
    await expectOperableInViewport(page, reviewBar(page))
    await expectOperableInViewport(page, approveRestButton(page))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${viewport.width}px`).toBe(true)
  }
  await emulateBrowserZoom200(page)
  await expectOperableInViewport(page, titleRow)
  await expectOperableInViewport(page, moreActions(page))
  await page.setViewportSize({ width: 1280, height: 800 })
  // Selecting a value opens its decision (§3.3).
  await activateWithKeyboard(page, titleRow)
  // Native focus must not override the list position restored when leaving One by one (§4.1).
  await page.setViewportSize({ width: 1280, height: 480 })
  const savedListScroll = await titleRow.evaluate((element) => {
    const scroller = element.closest('.overflow-y-auto')!
    scroller.scrollTop = scroller.scrollHeight
    return scroller.scrollTop
  })
  expect(savedListScroll).toBeGreaterThan(0)
  await resultsPanel(page).getByRole('button', { name: /One by one/ }).click()
  await expect(resultsPanel(page).getByRole('heading', { level: 2 })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(titleRow).toBeFocused()
  expect(await titleRow.evaluate((element) => element.closest('.overflow-y-auto')!.scrollTop)).toBe(savedListScroll)
  await page.setViewportSize(journeyViewport)
  await activateWithKeyboard(page, decisionFor(page, 'title', 'Edit'))
  const reviewedValue = resultsPanel(page).getByRole('textbox', { name: 'Reviewed value', exact: true })
  await reviewedValue.fill('Reviewed, café')
  let drafted = draftWritten(page)
  await reviewedValue.press('Enter')
  await drafted
  await expect(valueRow(page, /^Edited title Reviewed, café/)).toBeVisible()
  // Partial decisions survive a real document change and full page reload.
  await expect(breakdown(page)).toHaveText('0 approved · 1 edited · 0 rejected · draft saved')
  await expect(reviewBar(page)).toHaveAccessibleName(counted(1))
  await expect(approveRestButton(page)).toBeEnabled()
  const draftTab = await page.context().newPage()
  await draftTab.goto(url)
  await draftTab.getByRole('tab', { name: /Results/ }).click()
  await expect(valueRow(draftTab, /^Edited title Reviewed, café/)).toBeVisible()
  await expect(reviewBar(draftTab)).toHaveAccessibleName(counted(1))
  await draftTab.close()
  await page.goto(e2eStudioPath(`/projects/${projectContextId}/documents/${otherSourceDocumentId}`))
  await page.goto(url)
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(valueRow(page, /^Edited title Reviewed, café/)).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(valueRow(page, /^Edited title Reviewed, café/)).toBeVisible()
  await expect(reviewBar(page)).toHaveAccessibleName(counted(1))
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('free.review-draft.')))).toEqual([])
  await moreAction(page, 'Values as code')
  const rawResult = await resultsPanel(page).locator('pre').filter({ hasText: 'Reviewed, café' }).textContent()
  expect(rawResult!.indexOf('"title"')).toBeLessThan(rawResult!.indexOf('"year"'))
  expect(rawResult!.indexOf('"year"')).toBeLessThan(rawResult!.indexOf('"tags"'))
  await resultsPanel(page).getByRole('button', { name: 'Back to review', exact: true }).click()
  await expect(valueRow(page, /^Edited title Reviewed, café/)).toBeVisible()
  await valueRow(page, /^To check tags › 1 /).click()
  await decisionFor(page, 'tags › 1', 'Edit').click()
  await reviewedValue.fill('æ (reviewed)')
  drafted = draftWritten(page)
  await reviewedValue.press('Enter')
  await drafted
  await expect(valueRow(page, /^Edited tags › 1 æ \(reviewed\)/)).toBeVisible()
  // The Evidence stays the extracted value's, and is labelled so.
  await expect(resultsPanel(page).getByText(/^Evidence for the extracted value · /)).toBeVisible()
  await expect(breakdown(page)).toHaveText('0 approved · 2 edited · 0 rejected · draft saved')
  // Values are left to check, so nothing offers to save yet: the decision that empties the queue saves (§6).
  await expect(resultsPanel(page).getByRole('button', { name: 'Save review', exact: true })).toHaveCount(0)
  await approveRest(page)
  await expect(resultsPanel(page).getByText('Review saved', { exact: true })).toBeVisible()
  await expect(statusLine(page)).toHaveText(new RegExp(`^Review saved\\s*· ${requiredCount} decisions · read-only$`))
  await page.screenshot({
    path: testInfo.outputPath('canonical-reviewed-results.png'),
    fullPage: true,
  })

  // A short workspace exposes deep rows; only the list may scroll, keeping both headers in view.
  await page.setViewportSize({ width: 1280, height: 480 })
  await page.reload()
  await page.getByRole('tab', { name: /Results/ }).click()
  const deepRow = valueRow(page, /^Approved findings › 2 › detail Second/)
  await expect.poll(() => deepRow.evaluate((row) => getComputedStyle(row).transform)).toBe('none')
  await deepRow.click()
  await expect(page.getByRole('tab', { name: /Results/ })).toBeInViewport()
  await expect(page.getByRole('group', { name: 'Document view' })).toBeInViewport()
  expect(await resultsPanel(page).evaluate((panel) => panel.scrollHeight <= panel.clientHeight + 1)).toBe(true)
  await page.setViewportSize({ width: 1280, height: 800 })

  // A real browser download is produced once even when the format action is
  // double-clicked. Inspect both archive structure and the exact CSV bytes.
  const downloads: import('@playwright/test').Download[] = []
  page.on('download', (download) => downloads.push(download))
  await activateWithKeyboard(page, page.getByRole('button', { name: 'Export' }))
  let exportDialog = page.getByRole('dialog', { name: 'Export options' })
  await exportDialog.getByLabel('Rows represent').selectOption('findings')
  const workbookEvent = page.waitForEvent('download')
  await exportDialog.getByRole('button', { name: 'Excel' }).dblclick()
  const workbookDownload = await workbookEvent
  await expect.poll(() => downloads.length).toBe(1)
  expect(workbookDownload.suggestedFilename()).toBe('article-lifecycle-extraction-result.xlsx')
  const { strFromU8, unzipSync } = await import('fflate')
  const workbookArchive = unzipSync(new Uint8Array(await readFile((await workbookDownload.path())!)))
  const workbook = Object.fromEntries(
    Object.entries(workbookArchive).map(([path, bytes]) => [path, strFromU8(bytes)]),
  )
  expect(workbook['xl/workbook.xml']).toMatch(/<sheet[^>]*name="Results"/)
  const sharedStrings = workbook['xl/sharedStrings.xml']!
  const orderedHeaders = ['title', 'year', 'tags', 'findings.kind', 'findings.detail']
  for (let index = 1; index < orderedHeaders.length; index++)
    expect(sharedStrings.indexOf(orderedHeaders[index - 1]!)).toBeLessThan(
      sharedStrings.indexOf(orderedHeaders[index]!),
    )
  for (const value of ['Reviewed, café', 'æ (reviewed)', 'quoted "tag"', 'First,\nline', 'Second'])
    expect(sharedStrings).toContain(value)
  const sheet = workbook['xl/worksheets/sheet1.xml']!
  expect(sheet.match(/<row/g)).toHaveLength(3)
  expect(sheet).toContain('<autoFilter ref="A1:E3"/>')
  expect(sheet.match(/<v>1801<\/v>/g)).toHaveLength(2)

  await activateWithKeyboard(page, page.getByRole('button', { name: 'Export' }))
  exportDialog = page.getByRole('dialog', { name: 'Export options' })
  await expect(exportDialog.getByLabel('Rows represent')).toHaveValue('findings')
  const csvEvent = page.waitForEvent('download')
  await activateWithKeyboard(
    page,
    exportDialog.getByRole('button', { name: 'CSV' }),
  )
  const csvDownload = await csvEvent
  expect(csvDownload.suggestedFilename()).toBe('article-lifecycle-extraction-result.csv')
  expect(await readFile((await csvDownload.path())!, 'utf8')).toBe(
    'title,year,tags,findings.kind,findings.detail\r\n' +
    '"Reviewed, café",1801,"æ (reviewed), quoted ""tag""",A,"First,\nline"\r\n' +
    '"Reviewed, café",1801,"æ (reviewed), quoted ""tag""",B,Second',
  )

  const reviewed = await db.orm.public.Extraction.where({ sourceDocumentId })
    .select('id', 'reviewedAt', 'strategy')
    .orderBy((attempt) => attempt.createdAt.desc())
    .first()
  expect(reviewed?.reviewedAt).not.toBeNull()
  expect(reviewed?.strategy).toBe(strategy)
  const persistedReview = await db.orm.public.ExtractionReview.where({ extractionId: reviewed!.id })
    .select('id')
    .orderBy((review) => review.revisionNumber.desc())
    .first()
  expect(persistedReview).not.toBeNull()
  const persistedDecisions = await db.orm.public.ReviewDecision.where({
    extractionReviewId: persistedReview!.id,
  })
    .select('resultPath', 'action', 'reviewedValue', 'createdAt')
    .all()
  expect(persistedDecisions.length).toBeGreaterThan(1)
  expect(persistedDecisions.find(
    (decision) => JSON.stringify(decision.resultPath) === JSON.stringify(['records', 0, 'title']),
  )).toMatchObject({
    action: 'EDITED',
    reviewedValue: { value: 'Reviewed, café' },
    createdAt: expect.any(Date),
  })
  expect(persistedDecisions.find(
    (decision) => JSON.stringify(decision.resultPath) === JSON.stringify(['records', 0, 'tags', 0]),
  )).toMatchObject({
    action: 'EDITED',
    reviewedValue: { value: 'æ (reviewed)' },
    createdAt: expect.any(Date),
  })

  // A mixed result never counts ungrounded values as required review work.
  kei.groundedLimit = 2
  const mixedId = randomUUID()
  const mixedRequest = await page.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: { id: mixedId, sourceRepresentationRevisionId: firstRepresentationId, schemaRevisionId: firstSchemaRevisionId,
      strategy, method: savedMethod },
  })
  expect(mixedRequest.status()).toBe(201)
  const mixed = await waitForExtraction(page.request, mixedId, (attempt) => attempt.executionStatus === 'COMPLETED')
  expect(mixed.evidenceLinks).toHaveLength(2)
  await page.goto(url)
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(reviewBar(page)).toHaveAccessibleName('0 approved, 0 edited, 0 rejected, 2 to check, of 2')
  // The values without evidence are counted apart, as not reviewable (§2.3).
  await expect(resultsPanel(page).getByRole('button', { name: /^Not reviewable\s*6$/ })).toBeVisible()
  await valueRow(page, /^To check title /).click()
  drafted = draftWritten(page)
  await decisionFor(page, 'title', 'Reject').click()
  await drafted
  await expect(breakdown(page)).toHaveText('0 approved · 0 edited · 1 rejected · draft saved')
  await expect(reviewBar(page)).toHaveAccessibleName('0 approved, 0 edited, 1 rejected, 1 to check, of 2')
  await expect(approveRestButton(page)).toBeEnabled()
  await page.reload()
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(reviewBar(page)).toHaveAccessibleName('0 approved, 0 edited, 1 rejected, 1 to check, of 2')
  // Leave this partial review unfinalized: latest reviewed still means the earlier complete review.

  const secondPackage = await canonicalPackage('newer-unreviewed.pdf')
  const secondDescriptor = await packageStore.save(secondPackage.bytes)
  await db.orm.public.SourceRepresentationRevision.create({
    id: secondRepresentationId,
    sourceDocumentId,
    revisionNumber: 2,
    artifactReference: secondDescriptor.artifactReference,
    artifactSha256: secondDescriptor.artifactSha256,
    contractVersion: 'parsed_document.v2',
    preprocessId: `kei-exp:e2e-${secondRepresentationId}:g1`,
    parserName: 'fixture',
    parserVersion: '1',
  })
  await db.orm.public.SchemaRevision.create({
    id: secondSchemaRevisionId,
    extractionSchemaId,
    revisionNumber: 2,
    origin: 'RESEARCHER_EDIT',
    schemaTree: {
      recordDescription: 'One lifecycle fixture record.',
      schemaNodes: lifecycleSchemaNodes,
    },
    recordScope,
  })

  const newerExtractionId = randomUUID()
  kei.omitGrounding = true
  kei.blockNextResult = true
  const created = await page.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      id: newerExtractionId,
      sourceRepresentationRevisionId: secondRepresentationId,
      schemaRevisionId: secondSchemaRevisionId,
      strategy,
      method: savedMethod,
    },
  })
  expect(created.status()).toBe(201)
  await waitForExtraction(
    page.request,
    newerExtractionId,
    (attempt) => attempt.executionStatus === 'RUNNING',
  )

  const fresh = await browser.newContext()
  const freshPage = await fresh.newPage()
  await loginResearcher(freshPage, researcherObjectId)
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(resultsPanel(freshPage).getByText('Finding the records in the source…', { exact: true })).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Export' })).toHaveCount(0)
  await expect(freshPage.getByRole('button', { name: /^Run (Article|Catalog) extraction/ })).toHaveCount(0)
  await expect(freshPage.getByRole('button', { name: 'Save review', exact: true })).toHaveCount(0)

  await freshPage.goto(e2eStudioPath('/projects'))
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(resultsPanel(freshPage).getByText('Finding the records in the source…', { exact: true })).toBeVisible()
  if (!resultGate.release) throw new Error('The remote result was not blocked.')
  resultGate.release()
  await expect(resultsPanel(freshPage).getByText('Finding the records in the source…', { exact: true })).toBeHidden({ timeout: 30_000 })
  // No grounded values: nothing to check, so the review is offered for saving as it is (§6).
  await expect(statusLine(freshPage)).toHaveText(/^Completed/)
  await expect(reviewBar(freshPage)).toHaveAccessibleName('0 approved, 0 edited, 0 rejected, 0 to check, of 0')
  await expect(resultsPanel(freshPage).getByRole('button', { name: 'Save review', exact: true })).toBeEnabled()
  await moreAction(freshPage, 'Values as code')
  await expect(resultsPanel(freshPage).locator('pre').filter({ hasText: 'Résumé, source' })).toBeVisible()
  await resultsPanel(freshPage).getByRole('button', { name: 'Back to review', exact: true }).click()
  const reopened = documentReopenResponseSchema.parse(
    await (
      await freshPage.request.get(
        e2eStudioPath(
          `/api/project-contexts/${projectContextId}/source-documents/${sourceDocumentId}/reopen`,
        ),
      )
    ).json(),
  )
  expect(reopened.latestAttempt).toMatchObject({
    extractionId: newerExtractionId,
    sourceRepresentationRevisionId: secondRepresentationId,
    schemaRevisionId: secondSchemaRevisionId,
    reviewedAt: null,
  })
  expect(reopened.latestReviewed).toMatchObject({
    extractionId: reviewed?.id,
    sourceRepresentationRevisionId: firstRepresentationId,
    schemaRevisionId: firstSchemaRevisionId,
  })
  // The reviewed Extraction ran on an earlier Source Representation Revision, so the document offers to open it on
  // its own source rather than as a snapshot of the current one.
  await expect(freshPage.getByLabel('Extraction snapshot')).toHaveCount(0)
  const pinnedPdf = freshPage.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/source-representations/${firstRepresentationId}/pdf`))
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await freshPage.getByRole('button', { name: 'Open latest reviewed', exact: true }).click()
  await expect(freshPage).toHaveURL(`${url}?extractionId=${reviewed!.id}`)
  expect((await pinnedPdf).ok()).toBe(true)
  await expect(freshPage.locator('iframe[title="Pinned Source Document"]')).toHaveCount(0)
  await expect(freshPage.locator('.pdfViewer .page')).toHaveCount(6)
  // The used schema is in Run details (§8); the header says the review is of an earlier revision (§2.1).
  await resultsPanel(freshPage).getByRole('button', { name: 'Run details', exact: true }).click()
  await expect(runDetails(freshPage).getByText('Revision 1 · current is 2', { exact: true })).toBeVisible()
  await runDetails(freshPage).getByRole('button', { name: 'View schema used', exact: true }).click()
  await expect(runDetails(freshPage).locator('pre').filter({ hasText: 'One lifecycle fixture record.' })).toBeVisible()
  await runDetails(freshPage).getByRole('button', { name: 'Close run details', exact: true }).click()
  await expect(resultsPanel(freshPage).getByText('Rev 1 · current is 2', { exact: true })).toBeVisible()
  await expect(resultsPanel(freshPage).getByText(/^This review applies to Schema revision 1\./)).toBeVisible()
  await expect(freshPage.getByRole('button', { name: /^Run (Article |Catalog )?extraction/ })).toHaveCount(0)
  await expect(statusLine(freshPage)).toHaveText(/^Review saved/)
  await valueRow(freshPage, /^Edited title Reviewed, café/).click()
  await expect(resultsPanel(freshPage).getByText('Edited · saved', { exact: true })).toBeVisible()
  await expect(resultsPanel(freshPage).getByRole('group', { name: /^Decision for / })).toHaveCount(0)
  await freshPage.screenshot({
    path: testInfo.outputPath('canonical-fresh-context-review.png'),
    fullPage: true,
  })
  // Back returns to the current Source Representation Revision and its newer, unreviewed attempt.
  await freshPage.goBack()
  await expect(freshPage).toHaveURL(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(freshPage.getByRole('button', { name: 'Open latest reviewed', exact: true })).toBeVisible()
  await expect(freshPage.locator('iframe[title="Pinned Source Document"]')).toHaveCount(0)
  kei.omitGrounding = false
  kei.blockNextResult = true
  // The Record scope is in the Schema tab's header; the journey continues in Results.
  await freshPage.getByRole('tab', { name: /^Schema/ }).click()
  await expect(freshPage.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await freshPage.getByRole('button', { name: '▶ Run extraction' }).click()
  // Running shows only once Studio acknowledged the admission, so leaving now cannot lose the Extraction. kei holding
  // the result keeps it running until the cancel below.
  await expect(statusLine(freshPage)).toHaveText(/^Starting\s*· finding records…$/, { timeout: 10_000 })
  await expect.poll(() => resultGate.release !== null).toBe(true)
  await freshPage.goto(e2eStudioPath('/projects'))
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(resultsPanel(freshPage).getByText('Finding the records in the source…', { exact: true })).toBeVisible({ timeout: 20_000 })
  await freshPage.getByRole('button', { name: '■ Stop extraction', exact: true }).click()
  await expect(resultsPanel(freshPage).getByText('Stopped · nothing to review', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(freshPage.getByRole('button', { name: 'Export' })).toHaveCount(0)
  resultGate.release?.()

  kei.failNextValues = true
  // The Record scope is in the Schema tab's header; the journey continues in Results.
  await freshPage.getByRole('tab', { name: /^Schema/ }).click()
  await expect(freshPage.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await freshPage.getByRole('button', { name: '▶ Run extraction' }).click()
  await expect(resultsPanel(freshPage).getByText(/^Failed · (?!nothing to review)/)).toBeVisible({ timeout: 20_000 })
  await expect(statusLine(freshPage)).toHaveText(/^Failed\s*· nothing to review$/)

  kei.incompleteNextResult = true
  // The Record scope is in the Schema tab's header; the journey continues in Results.
  await freshPage.getByRole('tab', { name: /^Schema/ }).click()
  await expect(freshPage.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  // The tab strip's Run is the only run (decision 03); its title names the schema's saved strategy (decision 05).
  await expect(freshPage.getByRole('button', { name: /^Run (Article |Catalog )?extraction/ })).toHaveCount(0)
  await expect(freshPage.getByRole('button', { name: '▶ Run extraction', exact: true })).toHaveAttribute('title',
    strategy === 'CATALOG' ? 'Find the catalogue entries and extract one record per entry' : 'Extract one record from the whole document')
  await freshPage.getByRole('button', { name: '▶ Run extraction', exact: true }).click()
  await expect(statusLine(freshPage)).toHaveText(/^Completed, not all of it/, { timeout: 20_000 })
  await expect(resultsPanel(freshPage).getByRole('button', { name: 'Save review', exact: true })).toBeEnabled()
  // The retry's completion: with the rail open on Results, App's Review now toast stays away and no dialog shows (§2.5).
  await expect(resultsPanel(freshPage).getByRole('status').filter({ hasText: /^Run finished · / })).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Review now', exact: true })).toHaveCount(0)
  await expect(freshPage.getByRole('dialog', { name: 'Extraction finished', exact: true })).toHaveCount(0)
  await moreActions(freshPage).click()
  await expect(freshPage.getByRole('menuitem', { name: 'Export…', exact: true })).toBeEnabled()
  await freshPage.getByRole('menuitem', { name: 'Values as code', exact: true }).click()
  await expect(resultsPanel(freshPage).locator('pre').filter({ hasText: 'Résumé, source' })).toBeVisible()
  await resultsPanel(freshPage).getByRole('button', { name: 'Back to review', exact: true }).click()

  const blockerId = randomUUID()
  kei.blockNextValues = true
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      id: blockerId,
      sourceRepresentationRevisionId: otherRepresentationId,
      schemaRevisionId: secondSchemaRevisionId,
      strategy,
      method: savedMethod,
    },
  })).status()).toBe(201)
  await expect.poll(() => valuesGate.release !== null).toBe(true)
  // The re-run is admitted QUEUED (its workflow was enqueued with its row); kei then holds it, so the cancel below
  // stops work still in flight rather than racing its completion.
  kei.blockNextResult = true
  // The Record scope is in the Schema tab's header; the journey continues in Results.
  await freshPage.getByRole('tab', { name: /^Schema/ }).click()
  await expect(freshPage.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await freshPage.getByRole('button', { name: '▶ Run extraction' }).click()
  await expect(statusLine(freshPage)).toHaveText(/^Queued\s*· waiting for the extraction worker$/)
  await freshPage.getByTitle('Cancel the active Extraction').click()
  await expect(resultsPanel(freshPage).getByText('Stopped · nothing to review', { exact: true })).toBeVisible({ timeout: 20_000 })
  valuesGate.release?.()
  resultGate.release?.()
  await waitForExtraction(freshPage.request, blockerId)

  const replayPins = {
    id: reviewed!.id,
    sourceRepresentationRevisionId: firstRepresentationId,
    schemaRevisionId: firstSchemaRevisionId,
    strategy,
    method: savedMethod,
  }
  // The saved field model is part of the first run's identity; a model choice outside the method is refused.
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: replayPins,
  })).status()).toBe(200)
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: { ...replayPins, models: { fields: 'instruct' } },
  })).status()).toBe(422)
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: { ...replayPins, sourceRepresentationRevisionId: otherRepresentationId },
  })).status()).toBe(409)
  expect((await freshPage.request.delete(e2eStudioPath(`/api/extractions/${reviewed!.id}`), {
    headers: { Origin: E2E_ORIGIN },
  })).status()).toBe(404)

  const foreign = await browser.newContext()
  const foreignPage = await foreign.newPage()
  await loginResearcher(foreignPage, randomUUID())
  expect((await foreignPage.request.get(e2eStudioPath(`/api/extractions/${reviewed!.id}`))).status()).toBe(404)
  await foreign.close()

  const activeId = randomUUID()
  kei.blockNextValues = true
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      id: activeId,
      sourceRepresentationRevisionId: secondRepresentationId,
      schemaRevisionId: secondSchemaRevisionId,
      strategy,
      method: savedMethod,
    },
  })).status()).toBe(201)
  await expect.poll(() => valuesGate.release !== null).toBe(true)
  const activeDeletes = await Promise.all([
    freshPage.request.delete(e2eStudioPath(`/api/extractions/${activeId}`), { headers: { Origin: E2E_ORIGIN } }),
    freshPage.request.delete(e2eStudioPath(`/api/extractions/${activeId}`), { headers: { Origin: E2E_ORIGIN } }),
  ])
  const cancellationStatuses = activeDeletes.map((response) => response.status())
  expect(cancellationStatuses).toContain(202)
  // The worker may finish cancellation before the concurrent request arrives.
  for (const status of cancellationStatuses) expect([202, 404]).toContain(status)
  valuesGate.release?.()
  expect((await waitForExtraction(freshPage.request, activeId)).failure?.code).toBe('cancelled')
  expect((await freshPage.request.delete(e2eStudioPath(`/api/extractions/${activeId}`), {
    headers: { Origin: E2E_ORIGIN },
  })).status()).toBe(404)

  // Previous-schema regression: start with Schema Revision 3, save Revision 4
  // from the editor while kei-exp is still running, leave and come
  // back, then complete and validate the Revision 3 result.
  const thirdSchemaRevisionId = randomUUID()
  await db.orm.public.SchemaRevision.create({
    id: thirdSchemaRevisionId,
    extractionSchemaId,
    revisionNumber: 3,
    origin: 'RESEARCHER_EDIT',
    schemaTree: {
      recordDescription: 'One lifecycle fixture record.',
      schemaNodes: lifecycleSchemaNodes,
    },
    recordScope,
  })
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  kei.blockNextResult = true
  // The Record scope is in the Schema tab's header; the journey continues in Results.
  await freshPage.getByRole('tab', { name: /^Schema/ }).click()
  await expect(freshPage.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await freshPage.getByRole('button', { name: '▶ Run extraction' }).click()
  await expect(statusLine(freshPage)).toHaveText(/^Starting\s*· finding records…$/, { timeout: 20_000 })
  const previousSchema = resultsPanel(freshPage).getByText('Rev 3 · current is 4', { exact: true })
  await expect(resultsPanel(freshPage).getByText(/^Rev \d+ · current is/)).toHaveCount(0)
  await resultsPanel(freshPage).getByRole('button', { name: 'Run details', exact: true }).click()
  await expect(runDetails(freshPage).getByText('Revision 3 · the current revision', { exact: true })).toBeVisible()
  await runDetails(freshPage).getByRole('button', { name: 'View schema used', exact: true }).click()
  await expect(runDetails(freshPage).locator('pre').filter({ hasText: 'One lifecycle fixture record.' })).toBeVisible()
  await runDetails(freshPage).getByRole('button', { name: 'Close run details', exact: true }).click()

  await freshPage.getByRole('tab', { name: /^Schema/ }).click()
  // A row's actions show, and take the pointer, on hover (§6).
  await freshPage.getByRole('listitem', { name: 'year' }).hover()
  await freshPage.getByRole('button', { name: 'Edit year', exact: true }).click()
  await freshPage.getByPlaceholder('field_name').fill('year_of_record')
  await freshPage.getByRole('button', { name: 'Save', exact: true }).click()
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(previousSchema).toBeVisible({ timeout: 10_000 })
  await expect(statusLine(freshPage)).toHaveText(/^Starting\s*· finding records…$/, { timeout: 20_000 })
  await expect(freshPage.getByRole('button', { name: '■ Stop extraction', exact: true })).toBeEnabled()
  await expect(freshPage.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true')

  await freshPage.goto(e2eStudioPath(`/projects/${projectContextId}/documents/${otherSourceDocumentId}`))
  await expect(freshPage.getByRole('button', { name: '▶ Run extraction' })).toBeVisible()
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(statusLine(freshPage)).toHaveText(/^Starting\s*· finding records…$/, { timeout: 20_000 })
  await expect(previousSchema).toBeVisible()
  await resultsPanel(freshPage).getByRole('button', { name: 'Run details', exact: true }).click()
  await expect(runDetails(freshPage).getByText('Revision 3 · current is 4', { exact: true })).toBeVisible()
  await runDetails(freshPage).getByRole('button', { name: 'Close run details', exact: true }).click()
  if (!resultGate.release) throw new Error('The remote result was not blocked.')
  resultGate.release()
  await expect(statusLine(freshPage)).toHaveText(/^Completed/, { timeout: 30_000 })
  await expect(resultsPanel(freshPage).getByText(/^This review applies to Schema revision 3\./)).toBeVisible()
  // Revision 4 was an edit, so it kept the schema's scope: the next run, the tab strip's (the only one, decision 03), is
  // the same strategy (its title, decision 05).
  await expect(freshPage.getByRole('button', { name: /^Run (Article |Catalog )?extraction/ })).toHaveCount(0)
  await expect(freshPage.getByRole('button', { name: '▶ Run extraction', exact: true })).toBeEnabled()
  await expect(freshPage.getByRole('button', { name: '▶ Run extraction', exact: true })).toHaveAttribute('title',
    strategy === 'CATALOG' ? 'Find the catalogue entries and extract one record per entry' : 'Extract one record from the whole document')
  await expect(freshPage.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true')
  await approveRest(freshPage)
  await expect(resultsPanel(freshPage).getByText('Review saved', { exact: true })).toBeVisible()
  await expect(previousSchema).toBeVisible()
  const previousSchemaReview = await db.orm.public.Extraction.where({ sourceDocumentId })
    .select('id', 'schemaRevisionId', 'reviewedAt')
    .orderBy((attempt) => attempt.createdAt.desc())
    .first()
  expect(previousSchemaReview).toMatchObject({
    schemaRevisionId: thirdSchemaRevisionId,
    reviewedAt: expect.any(Date),
  })
  // Revision 4 was saved from the editor above and is now the Current Schema
  // Revision that a Batch Extraction must use.
  const currentSchemaRevision = await db.orm.public.SchemaRevision.where({ extractionSchemaId })
    .select('id', 'revisionNumber')
    .orderBy((revision) => revision.revisionNumber.desc())
    .first()
  expect(currentSchemaRevision?.revisionNumber).toBe(4)

  const batchResponse = await freshPage.request.post(e2eStudioPath('/api/batch-extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      projectContextId,
      schemaRevisionId: currentSchemaRevision!.id,
      strategy,
      sourceDocumentIds: [otherSourceDocumentId],
      force: true,
      method: savedMethod,
    },
  })
  expect(batchResponse.status()).toBe(202)
  const batchExtractionId = (await batchResponse.json()).batchExtraction.batchExtractionId as string
  // A batch's pending member Extraction, with every pin the interactive re-POST below sends.
  const batchMember = await db.orm.public.Extraction.where({ batchExtractionId })
    .select('id', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy')
    .first()
  expect(batchMember).not.toBeNull()
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      id: batchMember!.id,
      sourceRepresentationRevisionId: batchMember!.sourceRepresentationRevisionId,
      schemaRevisionId: batchMember!.schemaRevisionId,
      strategy: batchMember!.strategy,
      method: savedMethod,
    },
  })).status()).toBe(409)
  // A batch member is read on its own once published.
  const published = await waitForExtraction(freshPage.request, batchMember!.id)
  expect(published.executionStatus).toBe('COMPLETED')
  expect(published.outcome).toBe('SUCCEEDED')
  await fresh.close()
})

test('import → whole source → review → collection review @deterministic', async ({ page }) => {
  test.setTimeout(180_000)
  test.skip(!extractionDatabaseReady(), 'DATABASE_URL must equal the disposable EXTRACTION_TEST_DATABASE_URL')
  Object.assign(kei, {
    omitGrounding: false, blockNextValues: false, blockNextResult: false, failNextValues: false, incompleteNextResult: false,
    codebook: true,
  })
  const [researcherAccountId, researcherObjectId, projectContextId, sourceDocumentId, representationId, extractionSchemaId] =
    Array.from({ length: 6 }, () => randomUUID())
  const source = await canonicalPackage('reviewed.pdf')
  const descriptor = await createCanonicalPackageStore().save(source.bytes)
  await db.orm.public.ResearcherAccount.create({
    id: researcherAccountId, tenantId: DEVELOPMENT_ENTRA_TENANT_ID, objectId: researcherObjectId, displayName: 'Sample Researcher',
  })
  await db.orm.public.ModelConfiguration.create({ researcherAccountId, document: {
    connections: [], routes: { schemaSuggestion: null, interaction: null },
    extractionModels: {}, ingestionModels: {}, extractionSettings: {},
  } })
  await db.orm.public.ProjectContext.create({ id: projectContextId, researcherAccountId, name: 'Sample E2E' })
  await db.orm.public.SourceDocument.create({
    id: sourceDocumentId, projectContextId, contentSha256: source.sourceHash, mediaType: 'application/pdf', originalName: 'sample.pdf',
  })
  await db.orm.public.SourceRepresentationRevision.create({
    id: representationId, sourceDocumentId, revisionNumber: 1, artifactReference: descriptor.artifactReference,
    artifactSha256: descriptor.artifactSha256, contractVersion: 'parsed_document.v2',
    preprocessId: `kei-exp:e2e-${representationId}:g1`, parserName: 'fixture', parserVersion: '1',
  })
  await db.orm.public.ExtractionSchema.create({ id: extractionSchemaId, projectContextId, name: 'Sample schema' })
  await db.orm.public.SchemaRevision.create({
    id: randomUUID(), extractionSchemaId, revisionNumber: 1, origin: 'RESEARCHER_EDIT', recordScope: 'document',
    schemaTree: { recordDescription: 'One lifecycle fixture record.', schemaNodes: lifecycleSchemaNodes },
  })

  await loginResearcher(page, researcherObjectId)
  await page.goto(e2eStudioPath(`/projects/${projectContextId}/documents/${sourceDocumentId}`))
  await expect(page.getByText('/ 6', { exact: true })).toBeVisible({ timeout: 20_000 })
  const book = new ExcelJS.Workbook()
  book.addWorksheet('Codebook').addRows([['title', 'year'], ['Report', '0012']])
  await page.getByRole('button', { name: 'Schema actions' }).click()
  await page.getByRole('menuitem', { name: 'Import from Excel codebook…' }).click()
  await page.getByLabel('Excel codebook file').setInputFiles({ name: 'codebook.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await book.xlsx.writeBuffer()) })
  await page.getByLabel('Import worksheet').selectOption('Codebook')
  const previewResponse = page.waitForResponse((response) => response.url().includes('schema_import_preview') && response.url().includes('worksheet='))
  await page.getByRole('button', { name: 'Preview worksheet' }).click()
  const preview = await (await previewResponse).json() as { columns: Array<{ id: string }> }
  expect(await db.orm.public.SchemaRevision.where({ extractionSchemaId }).select('id').all()).toHaveLength(1)
  await page.getByLabel('Imported record description').fill('One imported record.')
  await page.getByLabel('Column 2 type').selectOption('integer')
  await page.getByRole('button', { name: 'Confirm as a new revision of the selected schema' }).click()
  await expect.poll(async () => (await db.orm.public.SchemaRevision.where({ extractionSchemaId }).select('id').all()).length).toBe(2)
  const imported = (await db.orm.public.SchemaRevision.where({ extractionSchemaId, revisionNumber: 2 }).select('schemaTree').first())!
  expect((imported.schemaTree as { schemaNodes: Array<{ id: string }> }).schemaNodes.map((node) => node.id)).toEqual(preview.columns.map((column) => column.id))
  await page.getByRole('button', { name: '▶ Run extraction', exact: true }).click()
  await page.getByRole('button', { name: 'Review now', exact: true }).click()
  // The Results badge counts what is left to check and empties once the review is saved (§4).
  await expect(page.getByRole('tab', { name: /^Results \d+ to check$/ })).toBeVisible({ timeout: 20_000 })
  // The whole-document run waits on its required decisions; Approve rest… makes them and saves the review.
  await expect(approveRestButton(page)).toBeEnabled({ timeout: 20_000 })
  await approveRest(page)
  await expect(page.getByText('Review saved', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('tab', { name: 'Results', exact: true })).toBeVisible()
  // One click deletes a field; Undo puts it back (§6).
  await page.getByRole('tab', { name: /^Schema/ }).click()
  const titleRow = page.getByRole('listitem', { name: 'title' })
  await titleRow.hover()
  await titleRow.getByRole('button', { name: 'Delete title' }).click()
  await expect(page.getByRole('listitem', { name: 'title' })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Field removed' })).toBeVisible()
  // The delete saves after the debounce; an Undo inside it would leave the saved tree unchanged and save nothing.
  await expect.poll(async () => (await db.orm.public.SchemaRevision.where({ extractionSchemaId }).select('id').all()).length).toBe(3)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('listitem', { name: 'title' })).toBeVisible()
  await expect.poll(async () => (await db.orm.public.SchemaRevision.where({ extractionSchemaId }).select('id').all()).length).toBe(4)
  // The restore saved the imported tree itself, not just a fourth revision: revision 4 is revision 2, field for field
  // (the imported tree is flat, so there is no group metadata to compare here; the unit tests cover a group's).
  const restored = (await db.orm.public.SchemaRevision.where({ extractionSchemaId, revisionNumber: 4 }).select('schemaTree').first())!
  const restoredNodes = (restored.schemaTree as { schemaNodes: Array<{ name: string }> }).schemaNodes
  expect(restoredNodes.map((node) => node.name)).toContain('title')
  expect(restored.schemaTree).toEqual(imported.schemaTree)
  await page.goto(e2eStudioPath(`/projects/${projectContextId}/extractions`))
  await page.getByRole('button', { name: 'New Batch Extraction' }).click()
  await page.getByRole('button', { name: 'Run 1 Source Document', exact: true }).click()
  const completion = page.getByRole('dialog', { name: 'Batch Extraction finished' })
  await expect(completion).toBeVisible({ timeout: 20_000 })
  await completion.getByRole('button', { name: 'Review now', exact: true }).click()
  // Finalize waits while anything is pending. Every fixture value is grounded, so the grid saves the member review
  // itself once the last pending cell is approved, and the button leaves with the editable member.
  const finalizeMember = page.getByRole('button', { name: 'Finalize member review', exact: true })
  await expect(finalizeMember).toBeDisabled({ timeout: 20_000 })
  const pendingColumn = page.getByRole('button', { name: /^Approve [1-9]\d* pending in (?!this row$)/, disabled: false })
  await expect(pendingColumn.first()).toBeVisible()
  for (let column = 0; column < 20 && await pendingColumn.count() > 0; column += 1) await pendingColumn.first().click()
  await expect(pendingColumn).toHaveCount(0)
  await expect(page.getByText('Review saved', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(finalizeMember).toHaveCount(0)
  kei.codebook = false
})
