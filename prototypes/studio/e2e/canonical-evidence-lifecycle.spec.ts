import { expect, test, type APIRequestContext } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import {
  createCanonicalPackageStore,
  packCanonicalPackage,
} from '../../../packages/db/src/artifact-store.js'
import { db } from '../../../packages/db/src/prisma/db.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { extractionAttemptSchema, type ExtractionAttempt } from '../shared/extraction.contract.js'
import type { ParsedContentBlock, ParsedDocument } from 'extraction/parsed-document'
import { CATALOG_RECORD_LIMIT } from 'extraction'
import { catalogDiscoveryContext, splitCatalogDiscoveryContext } from 'extraction/source-context'
import { DEVELOPMENT_ENTRA_TENANT_ID } from '../server/entraIdentityProvider.js'
import {
  E2E_ORIGIN,
  e2eStudioPath,
  loginResearcher,
} from './auth.js'
import {
  activateWithKeyboard,
  emulateBrowserZoom200,
  expectOperableInViewport,
  REQUIRED_VIEWPORTS,
} from './accessibility.js'

test.describe.configure({ mode: 'serial' })

const nodeRequire = createRequire(import.meta.url)

const sha256 = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

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

async function canonicalPackage(
  originalFilename: string,
  sourceDocument?: ParsedDocument,
  pdfFilename = 'Beretning_Ellekilde_8_13.pdf',
) {
  const pdf = await readFile(
    resolve(import.meta.dirname, '../../../examples', pdfFilename),
  )
  const sourceHash = sha256(pdf)
  const document = structuredClone(
    sourceDocument ??
      JSON.parse(
        await readFile(
          resolve(import.meta.dirname, '../src/assets/parsed_document.v2.json'),
          'utf8',
        ),
      ),
  ) as ParsedDocument
  document.document.content_sha256 = sourceHash
  document.document.source.original_filename = originalFilename
  document.document.source.byte_size = pdf.byteLength
  for (const anchor of document.evidence_index.anchors)
    anchor.content_sha256 = sourceHash

  return {
    bytes: packCanonicalPackage({
      pdf,
      document,
      markdown: '# Article fixture\n\nGrav 8\n',
    }),
    sourceHash,
  }
}

test('real Article lifecycle persists review, exports its reviewed result, and reopens newer unreviewed pins independently @deterministic', async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  test.skip(
    !process.env.EXTRACTION_TEST_DATABASE_URL ||
      process.env.DATABASE_URL !== process.env.EXTRACTION_TEST_DATABASE_URL,
    'DATABASE_URL must equal the disposable EXTRACTION_TEST_DATABASE_URL',
  )

  const configHome = resolve(import.meta.dirname, '../test-results/config-home')
  const configRoot =
    process.platform === 'win32'
      ? join(configHome, 'FREE Studio-nodejs', 'Config')
      : join(configHome, 'FREE Studio-nodejs')
  await rm(configHome, { recursive: true, force: true })

  let omitGrounding = false
  let addUnexpectedField = false
  let blockNextValues = false
  let blockNextGrounding = false
  let failNextValues = false
  let failNextGrounding = false
  const groundingGate: { release: (() => void) | null } = { release: null }
  const valuesGate: { release: (() => void) | null } = { release: null }
  const modelServer = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const prompt = JSON.parse(body) as { prompt: string }
      const grounding = prompt.prompt.includes('"links"')
      if ((grounding && failNextGrounding) || (!grounding && failNextValues)) {
        if (grounding) failNextGrounding = false
        else failNextValues = false
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'Deterministic model failure.' }))
        return
      }
      const generated = grounding
        ? JSON.stringify({
            links: Object.fromEntries(
              [...prompt.prompt.matchAll(/"(C\d+)"\s*:/g)]
                .map((match) => match[1]!)
                .filter((label, index, labels) => labels.indexOf(label) === index)
                .map((label) => [label, omitGrounding ? 'E999' : 'E1']),
            ),
          })
        : JSON.stringify({
            records: [{
              title: 'Résumé, source\nline',
              year: 1801,
              tags: ['æ', 'quoted "tag"'],
              findings: [
                { kind: 'A', detail: 'First,\nline' },
                { kind: 'B', detail: 'Second' },
              ],
              ...(addUnexpectedField ? { surprise: 'not in schema' } : {}),
            }],
          })
      const send = () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ response: generated, done_reason: 'stop', prompt_eval_count: 10, eval_count: 4, total_duration: 1_000_000 }))
      }
      if (!grounding && blockNextValues) {
        blockNextValues = false
        const blocked = Promise.withResolvers<void>()
        valuesGate.release = blocked.resolve
        void blocked.promise.then(() => {
          valuesGate.release = null
          send()
        })
      } else if (grounding && blockNextGrounding) {
        blockNextGrounding = false
        const blocked = Promise.withResolvers<void>()
        groundingGate.release = blocked.resolve
        void blocked.promise.then(() => {
          groundingGate.release = null
          send()
        })
      } else send()
    })
  })
  await new Promise<void>((resolveListen) =>
    modelServer.listen(0, '127.0.0.1', resolveListen),
  )
  const address = modelServer.address()
  if (!address || typeof address === 'string')
    throw new Error('The deterministic model server did not start.')
  const connectionId = randomUUID()
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    join(configRoot, 'model-config.json'),
    JSON.stringify({
      connections: [
        {
          id: connectionId,
          name: 'Article lifecycle fixture',
          provider: 'ollama',
          baseUrl: `http://127.0.0.1:${address.port}`,
        },
      ],
      routes: {
        extraction: {
          connectionId,
          modelId: 'fixture/nuextract',
          nuextractRaw: true,
        },
        interaction: null,
      },
    }),
    'utf8',
  )

  try {
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
  await db.orm.public.ProjectContext.create({
    id: projectContextId,
    researcherAccountId,
    name: 'Article lifecycle E2E',
  })
  await db.orm.public.SourceDocument.create({
    id: sourceDocumentId,
    projectContextId,
    ingestionKey: sourceDocumentId,
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
    preprocessId: 'bundled-fixture',
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
  })

  const internalUrl = `/projects/${projectContextId}/documents/${sourceDocumentId}`
  const url = e2eStudioPath(internalUrl)
  await loginResearcher(page, researcherObjectId)
  await page.goto(url)
  await expect(page).toHaveURL(url)
  await expect(page.getByText('6 pages', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  let interactivePosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/extractions'))
      interactivePosts += 1
  })
  await page.getByRole('button', { name: '▶ Run extraction' }).dblclick()
  await expect(page.getByRole('button', { name: '↻ Re-run extraction' })).toBeVisible()
  expect(interactivePosts).toBe(1)

  const otherPackage = await canonicalPackage(
    'different-document.pdf',
    undefined,
    '1790-06-17-1.pdf',
  )
  const otherDescriptor = await packageStore.save(otherPackage.bytes)
  await db.orm.public.SourceDocument.create({
    id: otherSourceDocumentId,
    projectContextId,
    ingestionKey: otherSourceDocumentId,
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
    preprocessId: 'bundled-fixture',
    parserName: 'fixture',
    parserVersion: '1',
  })

  addUnexpectedField = true
  await page.goto(
    e2eStudioPath(
      `/projects/${projectContextId}/documents/${otherSourceDocumentId}`,
    ),
  )
  await activateWithKeyboard(
    page,
    page.getByRole('button', { name: '▶ Run extraction' }),
  )
  await expect(page.getByRole('button', { name: '↻ Re-run extraction' })).toBeVisible()
  await expect(
    page.getByText('Unexpected model key: surprise', { exact: true }),
  ).toHaveCount(0)
  // Completion announces itself but never switches the rail tab.
  await expect(page.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'false')
  const completionDialog = page.getByRole('dialog', { name: 'Extraction finished', exact: true })
  await expect(completionDialog).toBeVisible()
  await activateWithKeyboard(
    page,
    completionDialog.getByRole('button', { name: 'Dismiss', exact: true }),
  )
  await expect(completionDialog).toBeHidden()
  await activateWithKeyboard(page, page.getByRole('tab', { name: /Results/ }))
  await expect(
    page.getByRole('button', { name: 'View Evidence for title' }),
  ).toBeVisible()

  addUnexpectedField = false
  await page.goto(url)
  await activateWithKeyboard(page, page.getByRole('tab', { name: /Results/ }))
  await expect(
    page.getByRole('button', { name: 'View Evidence for title' }),
  ).toBeVisible()
  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport)
    await expectOperableInViewport(
      page,
      page.getByRole('button', { name: 'View Evidence for title' }),
    )
    const exportTrigger = page.getByRole('button', { name: 'Export' })
    await expectOperableInViewport(page, exportTrigger)
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
  const draftTab = await page.context().newPage()
  await draftTab.goto(url)
  await draftTab.getByRole('tab', { name: /Results/ }).click()
  await expect(draftTab.getByText('Reviewed, café', { exact: true })).toBeVisible()
  await draftTab.close()
  await page.goto(e2eStudioPath(`/projects/${projectContextId}/documents/${otherSourceDocumentId}`))
  await page.goto(url)
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(page.getByText('Reviewed, café', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(page.getByText('Reviewed, café', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('free.review-draft.')))).toEqual([])
  await page.getByRole('tab', { name: 'Raw JSON' }).click()
  const rawResult = await page.locator('pre').filter({ hasText: 'Reviewed, café' }).textContent()
  expect(rawResult!.indexOf('"title"')).toBeLessThan(rawResult!.indexOf('"year"'))
  expect(rawResult!.indexOf('"year"')).toBeLessThan(rawResult!.indexOf('"tags"'))
  await page.getByRole('tab', { name: 'Review', exact: true }).click()
  await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0)
  await activateWithKeyboard(page, page.getByRole('button', { name: /Approve remaining/ }))
  await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
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
  for (const value of ['Reviewed, café', 'æ', 'quoted "tag"', 'First,\nline', 'Second'])
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
    '"Reviewed, café",1801,"æ, quoted ""tag""",A,"First,\nline"\r\n' +
    '"Reviewed, café",1801,"æ, quoted ""tag""",B,Second',
  )

  const reviewed = await db.orm.public.Extraction.where({ sourceDocumentId })
    .select('id', 'reviewedAt')
    .orderBy((attempt) => attempt.createdAt.desc())
    .first()
  expect(reviewed?.reviewedAt).not.toBeNull()
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

  const secondPackage = await canonicalPackage('newer-unreviewed.pdf')
  const secondDescriptor = await packageStore.save(secondPackage.bytes)
  await db.orm.public.SourceRepresentationRevision.create({
    id: secondRepresentationId,
    sourceDocumentId,
    revisionNumber: 2,
    artifactReference: secondDescriptor.artifactReference,
    artifactSha256: secondDescriptor.artifactSha256,
    contractVersion: 'parsed_document.v2',
    preprocessId: 'bundled-fixture',
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
  })

  const newerExtractionId = randomUUID()
  omitGrounding = true
  blockNextGrounding = true
  const created = await page.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      id: newerExtractionId,
      sourceRepresentationRevisionId: secondRepresentationId,
      schemaRevisionId: secondSchemaRevisionId,
      strategy: 'ARTICLE',
    },
  })
  expect(created.status()).toBe(201)
  await waitForExtraction(
    page.request,
    newerExtractionId,
    (attempt) => attempt.executionStatus === 'RUNNING' && attempt.resultPayload !== null,
  )

  const fresh = await browser.newContext()
  const freshPage = await fresh.newPage()
  await loginResearcher(freshPage, researcherObjectId)
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(
    freshPage.getByText('Values extracted · linking Evidence…'),
  ).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Export' })).toBeDisabled()
  await expect(freshPage.getByRole('button', { name: 'Rerun' })).toBeDisabled()
  await expect(freshPage.getByRole('button', { name: 'Save Review' })).toHaveCount(0)
  await freshPage.getByRole('tab', { name: 'Raw JSON' }).click()
  await expect(freshPage.locator('pre').filter({ hasText: 'Résumé, source' })).toBeVisible()

  await freshPage.goto(e2eStudioPath('/projects'))
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(
    freshPage.getByText('Values extracted · linking Evidence…'),
  ).toBeVisible()
  if (!groundingGate.release) throw new Error('Grounding was not blocked.')
  groundingGate.release()
  await expect(
    freshPage.getByText('Values extracted · linking Evidence…'),
  ).toBeHidden({ timeout: 30_000 })
  await expect(freshPage.getByText('No reviewable result')).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Save Review' })).toHaveCount(0)
  await freshPage.getByRole('tab', { name: 'Raw JSON' }).click()
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
  await expect(freshPage.getByLabel('Extraction snapshot')).toBeVisible()
  await freshPage.getByLabel('Extraction snapshot').selectOption(String(reviewed?.id))
  await expect(freshPage.locator('iframe[title="Pinned Source Document"]')).toHaveCount(0)
  await expect(freshPage.locator('.pdfViewer .page')).toHaveCount(6)
  await freshPage.getByRole('button', { name: 'View used schema' }).click()
  await expect(freshPage.locator('pre').filter({ hasText: 'One lifecycle fixture record.' })).toBeVisible()
  await expect(freshPage.getByText(firstSchemaRevisionId, { exact: true })).toBeVisible()
  await expect(freshPage.getByText('Previous schema')).toBeVisible()
  await expect(freshPage.getByText('Review applies to Schema Revision 1')).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Run with current schema' })).toHaveCount(0)
  await freshPage.getByRole('tab', { name: 'Review' }).click()
  await expect(
    freshPage.getByRole('tabpanel', { name: /Results/ }),
  ).toContainText('Reviewed, café')
  await expect(freshPage.getByRole('button', { name: /^Edit / })).toHaveCount(0)
  await freshPage.screenshot({
    path: testInfo.outputPath('canonical-fresh-context-review.png'),
    fullPage: true,
  })
  await freshPage.getByLabel('Extraction snapshot').selectOption(newerExtractionId)
  await expect(freshPage.locator('iframe[title="Pinned Source Document"]')).toHaveCount(0)
  omitGrounding = false
  blockNextGrounding = true
  await freshPage.getByRole('button', { name: '↻ Re-run extraction' }).click()
  await expect(freshPage.getByText('Values extracted · linking Evidence…')).toBeVisible()
  await freshPage.goto(e2eStudioPath('/projects'))
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(freshPage.getByText('Values extracted · linking Evidence…')).toBeVisible()
  await freshPage.getByRole('region', { name: 'Extraction status' }).getByRole('button', { name: 'Cancel extraction' }).click()
  await expect(freshPage.getByText('Evidence linking stopped: Extraction cancelled.')).toBeVisible()
  await freshPage.getByRole('tab', { name: 'Raw JSON' }).click()
  await expect(freshPage.locator('pre').filter({ hasText: 'Résumé, source' })).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Export' })).toBeDisabled()
  groundingGate.release?.()

  failNextValues = true
  await freshPage.getByRole('button', { name: '↻ Re-run extraction' }).click()
  await expect(freshPage.getByText('Extraction failed', { exact: true })).toBeVisible()
  await expect(freshPage.getByRole('tab', { name: 'Raw JSON' })).toHaveCount(0)

  failNextGrounding = true
  await freshPage.getByRole('button', { name: 'Retry extraction' }).click()
  await expect(freshPage.getByText('Incomplete Extraction', { exact: true })).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Export' })).toBeEnabled()
  await expect(freshPage.getByRole('button', { name: 'Save Review' })).toHaveCount(0)
  const retryCompletionDialog = freshPage.getByRole('dialog', { name: 'Extraction finished', exact: true })
  await expect(retryCompletionDialog).toBeVisible()
  await activateWithKeyboard(
    freshPage,
    retryCompletionDialog.getByRole('button', { name: 'Dismiss', exact: true }),
  )
  await expect(retryCompletionDialog).toBeHidden()
  await freshPage.getByRole('tab', { name: 'Raw JSON' }).click()
  await expect(freshPage.locator('pre').filter({ hasText: 'Résumé, source' })).toBeVisible()

  const blockerId = randomUUID()
  blockNextValues = true
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      id: blockerId,
      sourceRepresentationRevisionId: otherRepresentationId,
      schemaRevisionId: secondSchemaRevisionId,
      strategy: 'ARTICLE',
    },
  })).status()).toBe(201)
  await expect.poll(() => valuesGate.release !== null).toBe(true)
  await freshPage.getByRole('button', { name: '↻ Re-run extraction' }).click()
  await expect(freshPage.getByText('Queued extraction…')).toBeVisible()
  await freshPage.getByTitle('Cancel the active Extraction').click()
  await expect(freshPage.getByText('Extraction cancelled', { exact: true })).toBeVisible()
  valuesGate.release?.()
  await waitForExtraction(freshPage.request, blockerId)

  const replayRequest = {
    id: reviewed!.id,
    sourceRepresentationRevisionId: firstRepresentationId,
    schemaRevisionId: firstSchemaRevisionId,
    strategy: 'ARTICLE',
  }
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: replayRequest,
  })).status()).toBe(200)
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: { ...replayRequest, sourceRepresentationRevisionId: otherRepresentationId },
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
  blockNextValues = true
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      id: activeId,
      sourceRepresentationRevisionId: secondRepresentationId,
      schemaRevisionId: secondSchemaRevisionId,
      strategy: 'ARTICLE',
    },
  })).status()).toBe(201)
  await expect.poll(() => valuesGate.release !== null).toBe(true)
  const activeDeletes = await Promise.all([
    freshPage.request.delete(e2eStudioPath(`/api/extractions/${activeId}`), { headers: { Origin: E2E_ORIGIN } }),
    freshPage.request.delete(e2eStudioPath(`/api/extractions/${activeId}`), { headers: { Origin: E2E_ORIGIN } }),
  ])
  expect(activeDeletes.map((response) => response.status())).toEqual([202, 202])
  valuesGate.release?.()
  await waitForExtraction(freshPage.request, activeId)
  expect((await freshPage.request.delete(e2eStudioPath(`/api/extractions/${activeId}`), {
    headers: { Origin: E2E_ORIGIN },
  })).status()).toBe(404)

  // Previous-schema regression: start with Schema Revision 3, save Revision 4
  // from the editor while the run is still linking Evidence, leave and come
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
  })
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  blockNextGrounding = true
  await freshPage.getByRole('button', { name: /▶ Run extraction|↻ Re-run extraction/ }).click()
  await expect(freshPage.getByText('Values extracted · linking Evidence…')).toBeVisible()
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
  await expect(freshPage.getByText('Values extracted · linking Evidence…')).toBeVisible()
  await expect(status.getByRole('button', { name: 'Cancel extraction' })).toBeEnabled()
  await expect(freshPage.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true')

  await freshPage.goto(e2eStudioPath(`/projects/${projectContextId}/documents/${otherSourceDocumentId}`))
  await expect(freshPage.getByRole('button', { name: /Run extraction|Re-run extraction/ })).toBeVisible()
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(freshPage.getByText('Values extracted · linking Evidence…')).toBeVisible()
  await expect(status).toContainText('Using Schema Revision 3 · Current revision: 4')
  await expect(status.getByText('Previous schema')).toBeVisible()
  if (!groundingGate.release) throw new Error('Grounding was not blocked.')
  groundingGate.release()
  await expect(freshPage.getByText('Values extracted · linking Evidence…')).toBeHidden({ timeout: 30_000 })
  await expect(status).toContainText('Completed')
  await expect(status).toContainText('Review applies to Schema Revision 3')
  await expect(status.getByRole('button', { name: 'Run with current schema' })).toBeEnabled()
  await expect(freshPage.getByRole('button', { name: 'Rerun' })).toHaveCount(0)
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
      strategy: 'ARTICLE',
      sourceDocumentIds: [otherSourceDocumentId],
      force: true,
    },
  })
  expect(batchResponse.status()).toBe(202)
  const batchExtractionId = (await batchResponse.json()).batchExtraction.batchExtractionId as string
  const batchMember = await db.orm.public.ExtractionJob.where({ batchExtractionId })
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
    },
  })).status()).toBe(409)
  await fresh.close()
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolveClose())),
    )
    await rm(configHome, { recursive: true, force: true })
  }
})

function catalogDocument(labels: readonly string[]) {
  const document = structuredClone(
    JSON.parse(
      nodeRequire('node:fs').readFileSync(
        resolve(import.meta.dirname, '../src/assets/parsed_document.v2.json'),
        'utf8',
      ),
    ),
  ) as ParsedDocument
  const existing = document.content_stream[0]
  const blocks = [
    existing,
    ...labels.map(
      (text, index) =>
        ({
          ...existing,
          block_id: `catalog-heading-${index}`,
          kind: 'heading',
          text,
          markdown_span: null,
          level: 1,
        }) as ParsedContentBlock,
    ),
  ]
  document.content_stream = blocks
  document.pages[0].ordered_content = blocks.map(
    (block: { block_id: string }) => block.block_id,
  )
  return document
}

test('real Catalog lifecycle covers partials, retry, truncation, cancellation, review, and reopen @deterministic', async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000)
  test.skip(
    !process.env.EXTRACTION_TEST_DATABASE_URL ||
      process.env.DATABASE_URL !== process.env.EXTRACTION_TEST_DATABASE_URL,
    'DATABASE_URL must equal the disposable EXTRACTION_TEST_DATABASE_URL',
  )

  const configHome = resolve(import.meta.dirname, '../test-results/config-home')
  const configRoot =
    process.platform === 'win32'
      ? join(configHome, 'FREE Studio-nodejs', 'Config')
      : join(configHome, 'FREE Studio-nodejs')
  await rm(configHome, { recursive: true, force: true })

  type FixtureResponse = {
    result?: Record<string, unknown>
    raw?: string
    status?: number
    delayMs?: number
    grounding?: boolean
    finishReason?: 'stop' | 'length'
  }
  type FixtureStage = 'document' | 'discovery' | 'record' | 'grounding'
  const queues: Record<FixtureStage, FixtureResponse[]> = {
    document: [],
    discovery: [],
    record: [],
    grounding: [],
  }
  const resetQueues = () => {
    for (const queue of Object.values(queues)) queue.length = 0
  }
  let callCount = 0
  const waiters: Array<{ count: number; resolve: () => void }> = []
  const enqueue = (stage: FixtureStage, ...responses: FixtureResponse[]) =>
    queues[stage].push(...responses)
  const waitForCalls = (count: number) => {
    if (callCount >= count) return Promise.resolve()
    return new Promise<void>((resolveWait) => waiters.push({ count, resolve: resolveWait }))
  }
  const modelServer = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      callCount += 1
      for (const waiter of waiters.splice(0))
        if (callCount >= waiter.count) waiter.resolve()
        else waiters.push(waiter)
      const payload = JSON.parse(body) as { prompt?: string }
      const prompt = payload.prompt ?? ''
      const stage: FixtureStage =
        prompt.includes('### Claims') || prompt.includes('"links"')
          ? 'grounding'
          : prompt.includes('Identify every catalog record start') || prompt.includes('"starts"')
            ? 'discovery'
            : prompt.includes('"title"')
              ? 'record'
              : 'document'
      const fixture = queues[stage].shift()
      if (!fixture) {
        response.writeHead(500)
        response.end('fixture response queue exhausted')
        return
      }
      if (fixture.status && fixture.status !== 200) {
        response.writeHead(fixture.status)
        response.end('deterministic fixture failure')
        return
      }
      let result = fixture.result ?? {}
      if (fixture.grounding) {
        const labels = [...prompt.matchAll(/"(C\d+)"\s*:/g)]
          .map((match) => match[1]!)
          .filter((label, index, all) => all.indexOf(label) === index)
        result = {
          links: Object.fromEntries(labels.map((label) => [label, 'E1'])),
        }
      }
      const send = () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            response: fixture.raw ?? JSON.stringify(result),
            done_reason: fixture.finishReason ?? 'stop',
            prompt_eval_count: 10,
            eval_count: 4,
            total_duration: 1_000_000,
          }),
        )
      }
      if (fixture.delayMs) setTimeout(send, fixture.delayMs)
      else send()
    })
  })
  await new Promise<void>((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen))
  const address = modelServer.address()
  if (!address || typeof address === 'string') throw new Error('The deterministic Catalog model server did not start.')
  const connectionId = randomUUID()
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    join(configRoot, 'model-config.json'),
    JSON.stringify({
      connections: [{ id: connectionId, name: 'Catalog lifecycle fixture', provider: 'ollama', baseUrl: `http://127.0.0.1:${address.port}` }],
      routes: { extraction: { connectionId, modelId: 'fixture/nuextract', nuextractRaw: true }, interaction: null },
    }),
    'utf8',
  )

  const projectContextId = randomUUID()
  const researcherAccountId = randomUUID()
  const researcherObjectId = randomUUID()
  const sourceDocumentId = randomUUID()
  const extractionSchemaId = randomUUID()
  const firstRepresentationId = randomUUID()
  const truncationRepresentationId = randomUUID()
  const cancellationRepresentationId = randomUUID()
  const firstSchemaRevisionId = randomUUID()
  const packageSchemaRevisionId = randomUUID()
  const packageStore = createCanonicalPackageStore()
  const firstPackage = await canonicalPackage('catalog.pdf', catalogDocument(['First', 'Second', 'Third']))
  const truncationDocument = catalogDocument(Array.from({ length: CATALOG_RECORD_LIMIT + 1 }, (_, index) => `Record ${index + 1}`))
  const truncationContext = catalogDiscoveryContext(truncationDocument)
  const truncationPackage = await canonicalPackage('catalog-truncation.pdf', truncationDocument)
  const cancellationPackage = await canonicalPackage('catalog-cancellation.pdf', catalogDocument(['First', 'Second', 'Third']))
  const firstDescriptor = await packageStore.save(firstPackage.bytes)
  const truncationDescriptor = await packageStore.save(truncationPackage.bytes)
  const cancellationDescriptor = await packageStore.save(cancellationPackage.bytes)
  const internalUrl = `/projects/${projectContextId}/documents/${sourceDocumentId}`
  const url = e2eStudioPath(internalUrl)
  const addRepresentation = async (id: string, revisionNumber: number, descriptor: { artifactReference: string; artifactSha256: string }) =>
    db.orm.public.SourceRepresentationRevision.create({
      id,
      sourceDocumentId,
      revisionNumber,
      artifactReference: descriptor.artifactReference,
      artifactSha256: descriptor.artifactSha256,
      contractVersion: 'parsed_document.v2',
      preprocessId: 'bundled-fixture',
      parserName: 'fixture',
      parserVersion: '1',
    })
  try {
    await db.orm.public.ResearcherAccount.create({
      id: researcherAccountId,
      tenantId: DEVELOPMENT_ENTRA_TENANT_ID,
      objectId: researcherObjectId,
      displayName: 'Catalog Lifecycle Researcher',
    })
    await db.orm.public.ProjectContext.create({
      id: projectContextId,
      researcherAccountId,
      name: 'Catalog lifecycle E2E',
    })
    await db.orm.public.SourceDocument.create({
      id: sourceDocumentId,
      projectContextId,
      ingestionKey: sourceDocumentId,
      contentSha256: firstPackage.sourceHash,
      mediaType: 'application/pdf',
      originalName: 'catalog-lifecycle.pdf',
    })
    await addRepresentation(firstRepresentationId, 1, firstDescriptor)
    await addRepresentation(truncationRepresentationId, 2, truncationDescriptor)
    await addRepresentation(cancellationRepresentationId, 3, cancellationDescriptor)
    await db.orm.public.ExtractionSchema.create({ id: extractionSchemaId, projectContextId, name: 'Catalog lifecycle schema' })
    await db.orm.public.SchemaRevision.create({
      id: firstSchemaRevisionId,
      extractionSchemaId,
      revisionNumber: 1,
      origin: 'RESEARCHER_EDIT',
      schemaTree: {
        recordDescription: 'One catalog record.',
        schemaNodes: [
          { id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' },
          { id: 'year', name: 'year', type: 'integer', valueSource: 'document' },
          { id: 'title', name: 'title', type: 'string' },
        ],
      },
    })
    await loginResearcher(page, researcherObjectId)
    await page.goto(url)
    await expect(page.getByText('6 pages', { exact: true })).toBeVisible({ timeout: 20_000 })

    resetQueues()
    enqueue('document', { result: { record: { year: 2026 } } })
    enqueue('discovery', {
      result: { starts: ['B2', 'B3'] },
    })
    // Both records share one identified values call under the default policy.
    enqueue('record', { result: { records: [{ record_id: 'R1', title: 'A' }, { record_id: 'R2', title: 'B' }] } })
    enqueue('grounding', { grounding: true }, { grounding: true })
    await page.getByLabel('Extraction strategy').selectOption('CATALOG')
    await page.getByRole('button', { name: '▶ Run extraction' }).click()
    await expect(page.getByRole('button', { name: '↻ Re-run extraction' })).toBeVisible({ timeout: 30_000 })
    const completionDialog = page.getByRole('dialog', { name: 'Extraction finished', exact: true })
    await expect(completionDialog).toBeVisible()
    await activateWithKeyboard(
      page,
      completionDialog.getByRole('button', { name: 'Dismiss', exact: true }),
    )
    await expect(completionDialog).toBeHidden()
    await page.getByRole('tab', { name: /Results/ }).click()
    await expect(page.getByText('catalog', { exact: true })).toBeVisible()
    // The one-shot selector defaults the next run back to Article.
    await expect(page.getByLabel('Extraction strategy')).toHaveValue('ARTICLE')
    await expect(page.getByRole('button', { name: 'Save Review' })).toHaveCount(0)
    await page.getByRole('button', { name: /Approve remaining/ }).click()
    await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
    const complete = await db.orm.public.Extraction.where({ sourceDocumentId }).orderBy((attempt) => attempt.createdAt.asc()).first()
    expect(complete?.outcome).toBe('SUCCEEDED')
    expect(complete?.complete).toBe(true)

    resetQueues()
    enqueue('document', { result: { record: { year: 2026 } } })
    enqueue('discovery', {
      result: {
        starts: ['B2', 'B3', 'B4'],
      },
    })
    // The batched call fails, so the policy re-runs one record per call: the
    // middle record fails on its own and leaves the attempt partial.
    enqueue('record', { status: 500 }, { result: { record: { title: 'A' } } }, { status: 500 }, { result: { record: { title: 'C' } } })
    enqueue('grounding', { grounding: true }, { grounding: true })
    const partialId = randomUUID()
    const partialResponse = await page.request.post(e2eStudioPath('/api/extractions'), {
      headers: { Origin: E2E_ORIGIN },
      data: { id: partialId, sourceRepresentationRevisionId: firstRepresentationId, schemaRevisionId: firstSchemaRevisionId, strategy: 'CATALOG' },
    })
    expect(partialResponse.status()).toBe(201)
    const partial = await waitForExtraction(page.request, partialId)
    expect(partial).toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      resultPayload: {
        records: [
          { filename: 'catalog.pdf', year: 2026, title: 'A' },
          { filename: 'catalog.pdf', year: 2026, title: 'C' },
        ],
      },
    })
    const partialCatalog = partial.diagnostics!.catalog!
    expect(partial.resultPayload!.records).not.toContainEqual({})
    expect(partialCatalog.records[1]).toMatchObject({ outcome: 'failed', calls: 1 })
    const failedRecordStart = partialCatalog.records[1].boundary.startBlockId

    resetQueues()
    enqueue('record', { result: { record: { title: 'B' } } })
    enqueue('grounding', { grounding: true }, { grounding: true }, { grounding: true })
    await expect.poll(async () =>
      (await page.request.get(e2eStudioPath(
        `/api/project-contexts/${projectContextId}/source-documents/${sourceDocumentId}/reopen`,
      ))).status(),
    ).toBe(200)
    await page.goto(url)
    await page.getByRole('tab', { name: /Results/ }).click()
    await page.getByRole('button', { name: 'Run details' }).click()
    await page.getByLabel('Retry record 2: Second').check()
    await page.getByRole('button', { name: 'Retry selected components' }).click()
    let selectedRetryId = ''
    await expect.poll(async () => {
      const retried = await db.orm.public.Extraction.where({ sourceDocumentId, retryOfId: partialId })
        .select('id').orderBy((attempt) => attempt.createdAt.desc()).first()
      selectedRetryId = retried?.id ?? ''
      return selectedRetryId
    }).not.toBe('')

    resetQueues()
    enqueue('grounding', { grounding: true }, { grounding: true }, { grounding: true })
    await page.getByRole('button', { name: 'Run details' }).click()
    await page.getByRole('button', { name: 'Grounding only' }).click()
    await expect.poll(async () =>
      (await db.orm.public.Extraction.where({ sourceDocumentId, retryOfId: selectedRetryId })
        .select('id').orderBy((attempt) => attempt.createdAt.desc()).first())?.id ?? '',
    ).not.toBe('')

    resetQueues()
    enqueue('document', { status: 500 })
    enqueue('discovery', { result: { starts: ['B2'] } })
    enqueue('record', { result: { record: { title: 'A' } } })
    enqueue('grounding', { grounding: true })
    const documentFailureId = randomUUID()
    expect((await page.request.post(e2eStudioPath('/api/extractions'), {
      headers: { Origin: E2E_ORIGIN },
      data: { id: documentFailureId, sourceRepresentationRevisionId: firstRepresentationId, schemaRevisionId: firstSchemaRevisionId, strategy: 'CATALOG' },
    })).status()).toBe(201)
    const documentFailure = await waitForExtraction(page.request, documentFailureId)
    expect(documentFailure.diagnostics?.catalog?.stages.find((stage) => stage.stage === 'document-values')?.outcome).toBe('failed')
    resetQueues()
    enqueue('document', { result: { record: { year: 2026 } } })
    enqueue('grounding', { grounding: true })
    await page.goto(url)
    await page.getByRole('tab', { name: /Results/ }).click()
    await page.getByRole('button', { name: 'Run details' }).click()
    await page.getByLabel('Retry failed or truncated document metadata').check()
    await page.getByRole('button', { name: 'Retry selected components' }).click()
    await expect.poll(async () =>
      (await db.orm.public.Extraction.where({ sourceDocumentId, retryOfId: documentFailureId })
        .select('id').orderBy((attempt) => attempt.createdAt.desc()).first())?.id ?? '',
    ).not.toBe('')

    resetQueues()
    enqueue('document', { result: { record: { year: 2026 } } })
    enqueue('discovery', { result: { starts: ['B999'] } })
    const discoveryFailureId = randomUUID()
    const discoveryFailureResponse = await page.request.post(e2eStudioPath('/api/extractions'), {
      headers: { Origin: E2E_ORIGIN },
      data: { id: discoveryFailureId, sourceRepresentationRevisionId: firstRepresentationId, schemaRevisionId: firstSchemaRevisionId, strategy: 'CATALOG' },
    })
    expect(discoveryFailureResponse.status()).toBe(201)
    const discoveryFailure = await waitForExtraction(page.request, discoveryFailureId)
    expect(discoveryFailure).toMatchObject({
      executionStatus: 'FAILED',
      outcome: null,
      resultPayload: null,
      diagnostics: null,
      failure: { code: 'catalog_discovery_failed' },
    })

    resetQueues()
    enqueue('record', { result: { record: { title: 'B' } } })
    enqueue('grounding', { grounding: true }, { grounding: true }, { grounding: true })
    const retryId = randomUUID()
    const retryResponse = await page.request.post(e2eStudioPath('/api/extractions'), {
      headers: { Origin: E2E_ORIGIN },
      data: {
        id: retryId,
        retryOfId: partialId,
        retryDocument: false,
        rediscover: false,
        retryRecordStartBlockIds: [failedRecordStart],
      },
    })
    expect(retryResponse.status()).toBe(201)
    const retry = await waitForExtraction(page.request, retryId)
    expect(retry).toMatchObject({
      outcome: 'SUCCEEDED',
      resultPayload: {
        records: [
          { filename: 'catalog.pdf', year: 2026, title: 'A' },
          { filename: 'catalog.pdf', year: 2026, title: 'B' },
          { filename: 'catalog.pdf', year: 2026, title: 'C' },
        ],
      },
    })
    expect(retry.diagnostics!.catalog!.records.map((record: { provenance: string }) => record.provenance)).toEqual(['reused', 'executed', 'reused'])
    expect(retry.diagnostics!.retry).toMatchObject({
      retryOfId: partialId,
      retryRecordStartBlockIds: [failedRecordStart],
    })
    const prepared = await page.request.get(e2eStudioPath(`/api/extractions/${retryId}`))
    expect(prepared.status()).toBe(200)
    const { pendingReviewDecisions } = await prepared.json()
    const reviewResponse = await page.request.post(e2eStudioPath(`/api/extractions/${retryId}/review`), {
      headers: { Origin: E2E_ORIGIN },
      data: { reviewDecisions: pendingReviewDecisions },
    })
    expect(reviewResponse.status()).toBe(200)
    const finalizedRetry = await reviewResponse.json()
    expect(finalizedRetry).toMatchObject({
      extractionId: retryId,
      sourceRepresentationRevisionId: firstRepresentationId,
      schemaRevisionId: firstSchemaRevisionId,
      strategy: 'CATALOG',
      retryOfId: partialId,
      outcome: 'SUCCEEDED',
      reviewable: true,
      reviewedAt: expect.any(String),
    })

    await db.orm.public.SchemaRevision.create({
      id: packageSchemaRevisionId,
      extractionSchemaId,
      revisionNumber: 2,
      origin: 'RESEARCHER_EDIT',
      schemaTree: {
        recordDescription: 'One package-only catalog record.',
        schemaNodes: [{ id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' }],
      },
    })

    resetQueues()
    const callsBeforeInvalidOutput = callCount
    enqueue('discovery',
      { raw: '[]' },
      { result: { starts: ['B2'], end: null } },
      { result: { starts: ['B3', 'B4'], end: null } },
    )
    const invalidOutputId = randomUUID()
    expect((await page.request.post(e2eStudioPath('/api/extractions'), {
      headers: { Origin: E2E_ORIGIN },
      data: { id: invalidOutputId, sourceRepresentationRevisionId: firstRepresentationId, schemaRevisionId: packageSchemaRevisionId, strategy: 'CATALOG' },
    })).status()).toBe(201)
    const recovered = await waitForExtraction(page.request, invalidOutputId)
    expect(recovered).toMatchObject({ outcome: 'SUCCEEDED', complete: true })
    expect(recovered.resultPayload!.records).toHaveLength(3)
    expect(callCount - callsBeforeInvalidOutput).toBe(3)

    resetQueues()
    const callsBeforeTruncation = callCount
    enqueue('discovery',
      { result: { starts: ['B2'], end: null }, finishReason: 'length' },
      ...splitCatalogDiscoveryContext(truncationDocument, truncationContext).map(half => ({
        result: { starts: [...half.startBlockIdByLabel.keys()].filter(label => label !== 'B1'), end: null },
      })),
    )
    const truncationId = randomUUID()
    const truncationResponse = await page.request.post(e2eStudioPath('/api/extractions'), {
      headers: { Origin: E2E_ORIGIN },
      data: { id: truncationId, sourceRepresentationRevisionId: truncationRepresentationId, schemaRevisionId: packageSchemaRevisionId, strategy: 'CATALOG' },
    })
    expect(truncationResponse.status()).toBe(201)
    const truncation = await waitForExtraction(page.request, truncationId)
    expect(truncation).toMatchObject({ outcome: 'SUCCEEDED', complete: false })
    expect(callCount - callsBeforeTruncation).toBe(3)
    expect(truncation.diagnostics!.catalog!.stages.find(stage => stage.stage === 'discovery')).toMatchObject({ outcome: 'succeeded', calls: 3, finishReason: 'stop' })
    expect(truncation.resultPayload!.records).toHaveLength(CATALOG_RECORD_LIMIT)
    expect(truncation.diagnostics!.catalog!.records).toHaveLength(CATALOG_RECORD_LIMIT + 1)
    expect(truncation.diagnostics!.catalog!.records[CATALOG_RECORD_LIMIT]).toMatchObject({ outcome: 'not_attempted', failureCode: 'not_attempted_limit', calls: 0 })

    resetQueues()
    await page.goto(url)
    await page.getByRole('tab', { name: /Results/ }).click()
    await page.getByRole('button', { name: 'Run details' }).click()
    await expect(page.getByLabel('Rediscover Catalog record boundaries')).toHaveCount(0)
    await page.getByLabel(`Retry record ${CATALOG_RECORD_LIMIT + 1}: Record ${CATALOG_RECORD_LIMIT + 1}`).check()
    await page.getByRole('button', { name: 'Retry selected components' }).click()
    let limitRetryId = ''
    await expect.poll(async () => {
      limitRetryId = (await db.orm.public.Extraction.where({ sourceDocumentId, retryOfId: truncationId })
        .select('id').orderBy((attempt) => attempt.createdAt.desc()).first())?.id ?? ''
      return limitRetryId
    }).not.toBe('')
    expect(await waitForExtraction(page.request, limitRetryId)).toMatchObject({ outcome: 'SUCCEEDED', complete: true })
    expect(callCount - callsBeforeTruncation).toBe(3)

    const cancellationId = randomUUID()
    const callsBeforeCancellation = callCount
    resetQueues()
    enqueue('document', { result: { record: { year: 2026 } } })
    enqueue('discovery', {
      result: {
        starts: ['B2', 'B3', 'B4'],
      },
    })
    // One batched values call for the three records, held open long enough to cancel.
    enqueue('record', {
      result: { records: [{ record_id: 'R1', title: 'A' }, { record_id: 'R2', title: 'B' }, { record_id: 'R3', title: 'C' }] },
      delayMs: 10_000,
    })
    const cancellationPost = page.request.post(e2eStudioPath('/api/extractions'), {
      headers: { Origin: E2E_ORIGIN },
      data: { id: cancellationId, sourceRepresentationRevisionId: cancellationRepresentationId, schemaRevisionId: firstSchemaRevisionId, strategy: 'CATALOG' },
    })
    await waitForCalls(callsBeforeCancellation + 3)
    const cancellationDelete = await page.request.delete(e2eStudioPath(`/api/extractions/${cancellationId}`), {
      headers: { Origin: E2E_ORIGIN },
    })
    expect(cancellationDelete.status()).toBe(202)
    expect((await cancellationPost).status()).toBe(201)
    const cancelled = await waitForExtraction(page.request, cancellationId)
    expect(cancelled).toMatchObject({
      executionStatus: 'FAILED',
      outcome: null,
      failure: { code: 'cancelled' },
    })

    const fresh = await browser.newContext()
    const freshPage = await fresh.newPage()
    await loginResearcher(freshPage, researcherObjectId)
    await freshPage.goto(url)
    await freshPage.getByRole('tab', { name: /Results/ }).click()
    await expect(
      freshPage.getByRole('tabpanel', { name: 'Results' }).getByText('Extraction cancelled', { exact: true }),
    ).toBeVisible()
    await freshPage
      .getByLabel('Extraction snapshot')
      .selectOption({ label: 'Latest reviewed' })
    await expect(freshPage.getByLabel('Extraction snapshot')).toHaveValue(retryId)
    await expect(freshPage.getByText('Item 1', { exact: true })).toBeVisible()
    await expect(freshPage.getByText('Item 2', { exact: true })).toBeVisible()
    await expect(freshPage.getByText('Item 3', { exact: true })).toBeVisible()
    await freshPage.getByRole('button', { name: 'Run details' }).click()
    await expect(
      freshPage.getByLabel(
        'Catalog stage document-values: succeeded, reused',
      ),
    ).toBeVisible()
    await expect(
      freshPage.getByLabel(
        'Catalog stage record-values: succeeded, executed',
      ),
    ).toBeVisible()
    await expect(
      freshPage.getByLabel(
        'Catalog record 1: succeeded, reused, First',
      ),
    ).toBeVisible()
    await expect(
      freshPage.getByLabel(
        'Catalog record 2: succeeded, executed, Second',
      ),
    ).toBeVisible()
    const reopened = documentReopenResponseSchema.parse(
      await (
        await freshPage.request.get(
          e2eStudioPath(`/api/project-contexts/${projectContextId}/source-documents/${sourceDocumentId}/reopen`),
        )
      ).json(),
    )
    expect(reopened.latestAttempt).toMatchObject({ extractionId: cancellationId, sourceRepresentationRevisionId: cancellationRepresentationId, schemaRevisionId: firstSchemaRevisionId, executionStatus: 'FAILED', outcome: null, failure: { code: 'cancelled' } })
    expect(reopened.latestReviewed?.extractionId).toBe(finalizedRetry.extractionId)
    expect(reopened.latestReviewed?.strategy).toBe('CATALOG')
    expect(reopened.latestReviewed?.retryOfId).toBe(partialId)
    expect(reopened.latestReviewed?.resultPayload).toEqual(finalizedRetry.resultPayload)
    expect(reopened.latestReviewed?.reviewedAt).toBe(finalizedRetry.reviewedAt)
    expect(reopened.latestReviewed?.diagnostics).toEqual(finalizedRetry.diagnostics)
    await fresh.close()
  } finally {
    await new Promise<void>((resolveClose, reject) => modelServer.close((error) => (error ? reject(error) : resolveClose())))
    await rm(configHome, { recursive: true, force: true })
  }
})
