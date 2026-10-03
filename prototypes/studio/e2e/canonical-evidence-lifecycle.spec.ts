import { expect, test, type APIRequestContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { db } from '../../../packages/db/src/prisma/db.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionAttemptSchema, type ExtractionAttempt } from '../shared/extraction.contract.js'
import { keiExpArtifact, keiExpEvidence } from 'extraction/kei-exp-fixture'
import type { KeiExtractInput } from 'extraction/kei-handoff'
import { launchKeiStandIn, type KeiStandIn, type StandInDecision } from 'extraction/kei-stand-in'
import { DEVELOPMENT_ENTRA_TENANT_ID } from '../server/entraIdentityProvider.js'
import {
  E2E_ORIGIN,
  e2eStudioPath,
  loginResearcher,
} from './auth.js'
import { canonicalPackage } from './interactiveStack.js'
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
}
const resultGate: { release: (() => void) | null } = { release: null }
const valuesGate: { release: (() => void) | null } = { release: null }

/** kei's `extract` as this spec scripts it: kei-exp's artifact for the request, grounded unless a switch says
 *  otherwise, answered at once unless a gate holds it. */
async function extractFor(request: KeiExtractInput): Promise<StandInDecision<{ artifact: unknown }>> {
  if (kei.failNextValues) {
    kei.failNextValues = false
    return { failure: { code: 'extraction_failed', reason: 'Deterministic extraction failure.', retryable: false } }
  }
  const { schema, options } = request.request
  const nodes = (schema as { schemaNodes: Array<{ name: string; type: string }> }).schemaNodes
  const records = kei.codebook ? [Object.fromEntries(nodes.map((node) => [node.name,
    node.type === 'integer' ? 1801 : 'Résumé, source\nline']))] : [{
    title: 'Résumé, source\nline',
    [nodes.some((node) => node.name === 'year_of_record') ? 'year_of_record' : 'year']: 1801,
    tags: ['æ', 'quoted "tag"'],
    findings: [{ kind: 'A', detail: 'First,\nline' }, { kind: 'B', detail: 'Second' }],
  }]
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

let standIn: KeiStandIn | undefined

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
    script: { extract: (request) => extractFor(request) },
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
  test.setTimeout(180_000)
  test.skip(
    !extractionDatabaseReady(),
    'DATABASE_URL must equal the disposable EXTRACTION_TEST_DATABASE_URL',
  )

  Object.assign(kei, {
    omitGrounding: false, blockNextValues: false, blockNextResult: false, failNextValues: false, incompleteNextResult: false, groundedLimit: null,
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
  const strategyLabel = strategy === 'CATALOG' ? 'Catalog' : 'Article'
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
  await page.getByRole('button', { name: '▶ Run extraction' }).dblclick()
  await expect(page.getByRole('dialog', { name: 'Extraction finished', exact: true })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  expect(interactivePosts).toBe(1)
  const chosen = await db.orm.public.Extraction.where({ sourceDocumentId })
    .select('requestedModels', 'diagnostics').first()
  expect(chosen?.requestedModels).toEqual({ fields: 'instruct' })
  expect((chosen?.diagnostics as { models?: unknown } | undefined)?.models)
    .toEqual({ fields: 'fixture/nuextract', reasoning: 'fixture/nuextract' })

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
  await activateWithKeyboard(
    page,
    page.getByRole('button', { name: '▶ Run extraction' }),
  )
  await expect(page.getByRole('dialog', { name: 'Extraction finished', exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(
    page.getByText('Unexpected model key: surprise', { exact: true }),
  ).toHaveCount(0)
  // Completion announces itself but never switches the rail tab.
  await expect(page.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'false')
  const completionDialog = page.getByRole('dialog', { name: 'Extraction finished', exact: true })
  await expect(completionDialog).toBeVisible({ timeout: 20_000 })
  await activateWithKeyboard(
    page,
    completionDialog.getByRole('button', { name: 'Dismiss', exact: true }),
  )
  await expect(completionDialog).toBeHidden()
  await activateWithKeyboard(page, page.getByRole('tab', { name: /Results/ }))
  await expect(
    page.getByRole('button', { name: 'View Evidence for title' }),
  ).toBeVisible()

  await page.goto(url)
  await activateWithKeyboard(page, page.getByRole('tab', { name: /Results/ }))
  await expect(
    page.getByRole('button', { name: 'View Evidence for title' }),
  ).toBeVisible()
  const reviewProgress = page.getByRole('region', { name: 'Review progress', exact: true })
  await expect(reviewProgress).toHaveText(/^(\d+) of \1 required decisions remaining$/)
  const requiredCount = Number((await reviewProgress.textContent())!.match(/of (\d+)/)![1])
  const approveRemaining = page.getByRole('button', { name: `Approve remaining (${requiredCount})`, exact: true })
  await expect(approveRemaining).toHaveAccessibleDescription(/ungrounded values, are unchanged.*saves automatically/)
  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport)
    await expectOperableInViewport(
      page,
      page.getByRole('button', { name: 'View Evidence for title' }),
    )
    const exportTrigger = page.getByRole('button', { name: 'Export' })
    await expectOperableInViewport(page, exportTrigger)
    await expectOperableInViewport(page, reviewProgress)
    await expectOperableInViewport(page, approveRemaining)
    if (viewport.width === 390) await page.screenshot({ path: testInfo.outputPath('review-progress-mobile.png'), fullPage: true })
    await activateWithKeyboard(page, exportTrigger)
    const responsiveExportDialog = page.getByRole('dialog', {
      name: 'Export options',
    })
    await expectOperableInViewport(
      page,
      responsiveExportDialog.getByRole('button', { name: 'CSV' }),
    )
    await page.keyboard.press('Escape')
    await expect(responsiveExportDialog).toBeHidden()
    await expect(exportTrigger).toBeFocused()
  }
  // Review progress and Approve remaining stay operable, with no horizontal scroll, at every width, including 360 px.
  for (const viewport of [{ width: 360, height: 800 }, ...REQUIRED_VIEWPORTS]) {
    await page.setViewportSize(viewport)
    await expectOperableInViewport(page, reviewProgress)
    await expectOperableInViewport(page, approveRemaining)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${viewport.width}px`).toBe(true)
  }
  await emulateBrowserZoom200(page)
  await expectOperableInViewport(
    page,
    page.getByRole('button', { name: 'View Evidence for title' }),
  )
  await expectOperableInViewport(page, page.getByRole('button', { name: 'Export' }))
  await page.setViewportSize({ width: 1280, height: 800 })
  const titleReview = page.getByRole('group', { name: 'Review title' })
  await activateWithKeyboard(
    page,
    titleReview.getByRole('button', { name: 'Edit title' }),
  )
  await page.getByRole('textbox', { name: 'Reviewed value for title', exact: true }).fill('Reviewed, café')
  await page.getByRole('textbox', { name: 'Reviewed value for title', exact: true }).press('Enter')
  await expect(page.getByText('Reviewed, café', { exact: true })).toBeVisible()
  // Partial decisions survive a real document change and full page reload.
  await expect(page.getByText('Draft saved', { exact: true })).toBeVisible()
  await expect(reviewProgress).toContainText(`${requiredCount - 1} of ${requiredCount} required decisions remaining`)
  await expect(page.getByRole('button', { name: `Approve remaining (${requiredCount - 1})`, exact: true })).toBeEnabled()
  const draftTab = await page.context().newPage()
  await draftTab.goto(url)
  await draftTab.getByRole('tab', { name: /Results/ }).click()
  await expect(draftTab.getByText('Reviewed, café', { exact: true })).toBeVisible()
  await expect(draftTab.getByRole('region', { name: 'Review progress' })).toContainText(`${requiredCount - 1} of ${requiredCount} required decisions remaining`)
  await draftTab.close()
  await page.goto(e2eStudioPath(`/projects/${projectContextId}/documents/${otherSourceDocumentId}`))
  await page.goto(url)
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(page.getByText('Reviewed, café', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(page.getByText('Reviewed, café', { exact: true })).toBeVisible()
  await expect(reviewProgress).toContainText(`${requiredCount - 1} of ${requiredCount} required decisions remaining`)
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('free.review-draft.')))).toEqual([])
  await page.getByRole('tab', { name: 'Values as code' }).click()
  const rawResult = await page.locator('pre').filter({ hasText: 'Reviewed, café' }).textContent()
  expect(rawResult!.indexOf('"title"')).toBeLessThan(rawResult!.indexOf('"year"'))
  expect(rawResult!.indexOf('"year"')).toBeLessThan(rawResult!.indexOf('"tags"'))
  await page.getByRole('tab', { name: 'Review', exact: true }).click()
  await expect(page.getByRole('button', { name: 'View Evidence for extracted value of title', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'tags › 2 items', exact: true }).click()
  await page.getByRole('button', { name: 'Edit Tag 1', exact: true }).click()
  await page.getByRole('textbox', { name: 'Reviewed value for Tag 1', exact: true }).fill('æ (reviewed)')
  await page.getByRole('textbox', { name: 'Reviewed value for Tag 1', exact: true }).press('Enter')
  await expect(page.getByText('æ (reviewed)', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View Evidence for extracted value of Tag 1', exact: true })).toBeVisible()
  await expect(page.getByText('Draft saved', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0)
  await activateWithKeyboard(page, page.getByRole('button', { name: /Approve remaining/ }))
  await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
  await expect(reviewProgress).toHaveText(`Review saved · ${requiredCount} decisions`)
  await page.screenshot({
    path: testInfo.outputPath('canonical-reviewed-results.png'),
    fullPage: true,
  })

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
  await expect(reviewProgress).toHaveText('2 of 2 required decisions remaining')
  // With a claim accounting the Completion section names the values without evidence (not the lumped sentence).
  await expect(page.getByText(/· 6 values without evidence are not reviewable$/)).toBeVisible()
  await expect(page.getByText('Draft saved', { exact: true })).toHaveCount(0)
  await page.getByRole('group', { name: 'Review title' }).getByRole('button', { name: 'Reject title' }).click()
  await expect(page.getByText('Draft saved', { exact: true })).toBeVisible()
  await expect(reviewProgress).toContainText('1 of 2 required decisions remaining')
  await expect(page.getByRole('button', { name: 'Approve remaining (1)', exact: true })).toBeEnabled()
  await page.reload()
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(reviewProgress).toContainText('1 of 2 required decisions remaining')
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
  await expect(
    freshPage.getByText('Running extraction…'),
  ).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Export' })).toHaveCount(0)
  await expect(freshPage.getByRole('button', { name: /^Run (Article|Catalog) extraction/ })).toHaveCount(0)
  await expect(freshPage.getByRole('button', { name: 'Save Review' })).toHaveCount(0)

  await freshPage.goto(e2eStudioPath('/projects'))
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(
    freshPage.getByText('Running extraction…'),
  ).toBeVisible()
  if (!resultGate.release) throw new Error('The remote result was not blocked.')
  resultGate.release()
  await expect(
    freshPage.getByText('Running extraction…'),
  ).toBeHidden({ timeout: 30_000 })
  await expect(freshPage.getByText('No grounded values')).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Save Review' })).toBeEnabled()
  await freshPage.getByRole('tab', { name: 'Values as code' }).click()
  await expect(freshPage.locator('pre').filter({ hasText: 'Résumé, source' })).toBeVisible()
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
  await freshPage.getByRole('button', { name: 'View used schema' }).click()
  await expect(freshPage.locator('pre').filter({ hasText: 'One lifecycle fixture record.' })).toBeVisible()
  await expect(freshPage.getByText(firstSchemaRevisionId, { exact: true })).toBeVisible()
  await expect(freshPage.getByText('Previous schema')).toBeVisible()
  await expect(freshPage.getByText('Review applies to Schema Revision 1')).toBeVisible()
  await expect(freshPage.getByRole('button', { name: /^Run (Article|Catalog) extraction with current schema$/ })).toHaveCount(0)
  await freshPage.getByRole('tab', { name: 'Review' }).click()
  await expect(
    freshPage.getByRole('tabpanel', { name: /Results/ }),
  ).toContainText('Reviewed, café')
  await expect(freshPage.getByRole('button', { name: /^Edit / })).toHaveCount(0)
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
  await expect(freshPage.getByText('Running extraction…')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => resultGate.release !== null).toBe(true)
  await freshPage.goto(e2eStudioPath('/projects'))
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(freshPage.getByText('Running extraction…')).toBeVisible({ timeout: 20_000 })
  await freshPage.getByRole('region', { name: 'Extraction status' }).getByRole('button', { name: 'Cancel extraction' }).click()
  await expect(freshPage.getByText('Extraction cancelled', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(freshPage.getByRole('button', { name: 'Export' })).toHaveCount(0)
  resultGate.release?.()

  kei.failNextValues = true
  // The Record scope is in the Schema tab's header; the journey continues in Results.
  await freshPage.getByRole('tab', { name: /^Schema/ }).click()
  await expect(freshPage.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await freshPage.getByRole('button', { name: '▶ Run extraction' }).click()
  await expect(freshPage.getByText('Extraction failed', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(freshPage.getByRole('tab', { name: 'Values as code' })).toHaveCount(0)

  kei.incompleteNextResult = true
  // The Record scope is in the Schema tab's header; the journey continues in Results.
  await freshPage.getByRole('tab', { name: /^Schema/ }).click()
  await expect(freshPage.getByRole('combobox', { name: 'Record scope' })).toHaveValue(recordScope)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  // The failed attempt's Results action names the schema's saved strategy.
  await freshPage.getByRole('button', {
    name: strategy === 'CATALOG' ? 'Run Catalog extraction' : 'Run Article extraction',
    exact: true,
  }).click()
  await expect(freshPage.getByText('Incomplete Extraction', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(freshPage.getByRole('button', { name: 'Export' })).toBeEnabled()
  await expect(freshPage.getByRole('button', { name: 'Save Review' })).toBeEnabled()
  const retryCompletionDialog = freshPage.getByRole('dialog', { name: 'Extraction finished', exact: true })
  await expect(retryCompletionDialog).toBeVisible({ timeout: 20_000 })
  await activateWithKeyboard(
    freshPage,
    retryCompletionDialog.getByRole('button', { name: 'Dismiss', exact: true }),
  )
  await expect(retryCompletionDialog).toBeHidden()
  await freshPage.getByRole('tab', { name: 'Values as code' }).click()
  await expect(freshPage.locator('pre').filter({ hasText: 'Résumé, source' })).toBeVisible()

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
  await expect(freshPage.getByText('Queued extraction…')).toBeVisible()
  await freshPage.getByTitle('Cancel the active Extraction').click()
  await expect(freshPage.getByText('Extraction cancelled', { exact: true })).toBeVisible({ timeout: 20_000 })
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
  await expect(freshPage.getByText('Running extraction…')).toBeVisible({ timeout: 20_000 })
  const status = freshPage.getByRole('region', { name: 'Extraction status' })
  await expect(status).toContainText('Using Schema Revision 3 · Current revision: 3')
  await expect(status.getByText('Previous schema')).toHaveCount(0)
  await status.getByRole('button', { name: 'View used schema' }).click()
  await expect(status.locator('pre').filter({ hasText: 'One lifecycle fixture record.' })).toBeVisible()
  await expect(status.getByText(thirdSchemaRevisionId, { exact: true })).toBeVisible()

  await freshPage.getByRole('tab', { name: /^Schema/ }).click()
  await freshPage.getByTitle('Edit year').click()
  await freshPage.getByPlaceholder('field_name').fill('year_of_record')
  await freshPage.getByRole('button', { name: 'Save', exact: true }).click()
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(status).toContainText('Using Schema Revision 3 · Current revision: 4', { timeout: 10_000 })
  await expect(status.getByText('Previous schema')).toBeVisible()
  await expect(freshPage.getByText('Running extraction…')).toBeVisible({ timeout: 20_000 })
  await expect(status.getByRole('button', { name: 'Cancel extraction' })).toBeEnabled()
  await expect(freshPage.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true')

  await freshPage.goto(e2eStudioPath(`/projects/${projectContextId}/documents/${otherSourceDocumentId}`))
  await expect(freshPage.getByRole('button', { name: '▶ Run extraction' })).toBeVisible()
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(freshPage.getByText('Running extraction…')).toBeVisible({ timeout: 20_000 })
  await expect(status).toContainText('Using Schema Revision 3 · Current revision: 4')
  await expect(status.getByText('Previous schema')).toBeVisible()
  if (!resultGate.release) throw new Error('The remote result was not blocked.')
  resultGate.release()
  await expect(freshPage.getByText('Running extraction…')).toBeHidden({ timeout: 30_000 })
  await expect(status).toContainText('Completed')
  await expect(status).toContainText('Review applies to Schema Revision 3')
  // Revision 4 was an edit, so it kept the schema's scope: the next run is the same strategy.
  await expect(status.getByRole('button', { name: `Run ${strategyLabel} extraction with current schema` })).toBeEnabled()
  await expect(freshPage.getByRole('button', { name: /^Run (Article|Catalog) extraction$/ })).toHaveCount(0)
  await expect(freshPage.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true')
  await activateWithKeyboard(freshPage, freshPage.getByRole('button', { name: /Approve remaining/ }))
  await expect(freshPage.getByText('Review saved', { exact: true })).toBeVisible()
  await expect(status.getByText('Previous schema')).toBeVisible()
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
  // The whole-document run waits on its required decisions; the review saves itself once they are all made.
  const approveRemaining = page.getByRole('button', { name: /^Approve remaining \(\d+\)$/ })
  await expect(approveRemaining).toBeEnabled({ timeout: 20_000 })
  await approveRemaining.click()
  await expect(page.getByText('Review saved', { exact: true })).toBeVisible({ timeout: 20_000 })
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
