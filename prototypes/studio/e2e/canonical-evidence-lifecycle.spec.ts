import { expect, test, type APIRequestContext } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
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
import type { ParsedDocument } from 'extraction/parsed-document'
import { keiExpAccepted, keiExpArtifact, keiExpEnvelope, keiExpEvidence } from 'extraction/kei-exp-fixture'
import type { KeiExpArtifact } from 'extraction'
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
  for (const [index, anchor] of document.evidence_index.anchors.entries()) {
    anchor.content_sha256 = sourceHash
    anchor.anchor_id = `a_p1_s${index}`
  }

  return {
    bytes: packCanonicalPackage({
      pdf,
      document,
      markdown: '# Article fixture\n\nGrav 8\n',
    }),
    sourceHash,
  }
}

for (const strategy of ['ARTICLE', 'CATALOG'] as const)
test(`real ${strategy} lifecycle persists review, exports its reviewed result, and reopens newer unreviewed pins independently @deterministic`, async ({
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
  let blockNextValues = false
  let blockNextResult = false
  let failNextValues = false
  let incompleteNextResult = false
  const resultGate: { release: (() => void) | null } = { release: null }
  const valuesGate: { release: (() => void) | null } = { release: null }
  const artifacts = new Map<string, { ready: boolean; runId: string; artifact: KeiExpArtifact }>()
  const modelServer = createServer((request, response) => {
    const send = (value: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    // kei-exp's deployment listing: the fixture serves one instruction model for both roles.
    if (request.method === 'GET' && request.url === '/api/extraction-models') {
      send({
        defaults: { fields: 'instruct', reasoning: 'instruct' },
        models: [{ key: 'instruct', repo: 'fixture/nuextract', roles: ['fields', 'reasoning'], reachable: true, serving: true }],
      })
      return
    }
    if (request.method === 'GET') {
      const id = request.url!.split('/').at(-1)!
      const job = artifacts.get(id)
      // The polling envelope kei-exp serves: the artifact is nested under `result`, and only once done.
      send(keiExpEnvelope({
        id, run_id: job?.runId ?? decodeURIComponent(request.url!.split('/')[3]!),
        status: job?.ready ? 'done' : 'running', result: job?.ready ? job.artifact : null,
      }))
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (failNextValues) {
        failNextValues = false
        send({ error: 'Deterministic extraction failure.' }, 500)
        return
      }
      const { schema, options } = JSON.parse(body)
      const id = randomUUID()
      const runId = decodeURIComponent(request.url!.split('/')[3]!)
      const records = [{
        title: 'Résumé, source\nline',
        [schema.schemaNodes.some((node: { name: string }) => node.name === 'year_of_record') ? 'year_of_record' : 'year']: 1801,
        tags: ['æ', 'quoted "tag"'],
        findings: [{ kind: 'A', detail: 'First,\nline' }, { kind: 'B', detail: 'Second' }],
      }]
      const paths = (value: unknown, path: (string | number)[] = []): (string | number)[][] =>
        Array.isArray(value) ? value.flatMap((item, i) => paths(item, [...path, i])) :
        value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => paths(item, [...path, key])) : [path]
      const ungrounded = omitGrounding || incompleteNextResult
      incompleteNextResult = false
      const resultPaths = paths({ records })
      const job = { ready: true, runId, artifact: keiExpArtifact({
        run_id: runId, generation: 'g1', fingerprint: id,
        strategy: options.strategy, model: 'fixture/nuextract',
        models: { fields: 'fixture/nuextract', reasoning: 'fixture/nuextract' }, schema,
        // kei-exp records the options it ran under, `models` null when the run kept the deployment defaults.
        options: { model: null, models: null, ...options },
        started: new Date().toISOString(), seconds: 0.1, complete: !ungrounded, records,
        evidence: ungrounded ? [] : resultPaths.map(path => keiExpEvidence({ path, verbatim: false, hits: 0, linked_by: 'model' })),
        ungrounded: ungrounded ? resultPaths : [],
      }) }
      if (blockNextValues || blockNextResult) {
        job.ready = false
        const gate = blockNextValues ? valuesGate : resultGate
        gate.release = () => { job.ready = true; gate.release = null }
        blockNextValues = false
        blockNextResult = false
      }
      artifacts.set(id, job)
      send(keiExpAccepted({ id, run_id: runId, generation: 'g1' }), 202)
    })
  })
  await new Promise<void>(resolveListen => modelServer.listen(41_750, '127.0.0.1', resolveListen))
  const address = modelServer.address()
  if (!address || typeof address === 'string') throw new Error('The kei-exp fixture did not start.')
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
        schemaSuggestion: {
          connectionId,
          modelId: 'fixture/nuextract',
        },
        interaction: null,
      },
      // The deployment-wide Extraction Model Choice every run is requested on.
      extractionModels: { fields: 'instruct' },
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
  // The configured Extraction Model Choice goes with the run and stays with its Extraction; the header offers none.
  await expect(page.getByRole('combobox', { name: 'Field model' })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Extraction strategy' }).selectOption(strategy)
  await page.getByRole('button', { name: '▶ Run extraction' }).dblclick()
  await expect(page.getByRole('button', { name: '↻ Re-run extraction' })).toBeVisible()
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

  await page.goto(
    e2eStudioPath(
      `/projects/${projectContextId}/documents/${otherSourceDocumentId}`,
    ),
  )
  await page.getByRole('combobox', { name: 'Extraction strategy' }).selectOption(strategy)
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
  blockNextResult = true
  const created = await page.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      id: newerExtractionId,
      sourceRepresentationRevisionId: secondRepresentationId,
      schemaRevisionId: secondSchemaRevisionId,
      strategy,
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
  await freshPage.getByLabel('Extraction snapshot').selectOption(newerExtractionId)
  await expect(freshPage.locator('iframe[title="Pinned Source Document"]')).toHaveCount(0)
  omitGrounding = false
  blockNextResult = true
  await freshPage.getByRole('combobox', { name: 'Extraction strategy' }).selectOption(strategy)
  await freshPage.getByRole('button', { name: '↻ Re-run extraction' }).click()
  await expect(freshPage.getByText('Running extraction…')).toBeVisible()
  await freshPage.goto(e2eStudioPath('/projects'))
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(freshPage.getByText('Running extraction…')).toBeVisible()
  await freshPage.getByRole('region', { name: 'Extraction status' }).getByRole('button', { name: 'Cancel extraction' }).click()
  await expect(freshPage.getByText('Extraction cancelled', { exact: true })).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Export' })).toHaveCount(0)
  resultGate.release?.()

  failNextValues = true
  await freshPage.getByRole('combobox', { name: 'Extraction strategy' }).selectOption(strategy)
  await freshPage.getByRole('button', { name: '▶ Run extraction' }).click()
  await expect(freshPage.getByText('Extraction failed', { exact: true })).toBeVisible()
  await expect(freshPage.getByRole('tab', { name: 'Raw JSON' })).toHaveCount(0)

  incompleteNextResult = true
  await freshPage.getByRole('combobox', { name: 'Extraction strategy' }).selectOption(strategy)
  // The failed attempt's Results action names the strategy just selected in the toolbar.
  await freshPage.getByRole('button', {
    name: strategy === 'CATALOG' ? 'Run Catalog extraction' : 'Run Article extraction',
    exact: true,
  }).click()
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
      strategy,
    },
  })).status()).toBe(201)
  await expect.poll(() => valuesGate.release !== null).toBe(true)
  await freshPage.getByRole('combobox', { name: 'Extraction strategy' }).selectOption(strategy)
  await freshPage.getByRole('button', { name: '↻ Re-run extraction' }).click()
  await expect(freshPage.getByText('Queued extraction…')).toBeVisible()
  await freshPage.getByTitle('Cancel the active Extraction').click()
  await expect(freshPage.getByText('Extraction cancelled', { exact: true })).toBeVisible()
  valuesGate.release?.()
  await waitForExtraction(freshPage.request, blockerId)

  const replayPins = {
    id: reviewed!.id,
    sourceRepresentationRevisionId: firstRepresentationId,
    schemaRevisionId: firstSchemaRevisionId,
    strategy,
  }
  // The configured field model is part of the first run's identity, and a client cannot choose another.
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
  blockNextValues = true
  expect((await freshPage.request.post(e2eStudioPath('/api/extractions'), {
    headers: { Origin: E2E_ORIGIN },
    data: {
      id: activeId,
      sourceRepresentationRevisionId: secondRepresentationId,
      schemaRevisionId: secondSchemaRevisionId,
      strategy,
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
  })
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  blockNextResult = true
  await freshPage.getByRole('combobox', { name: 'Extraction strategy' }).selectOption(strategy)
  await freshPage.getByRole('button', { name: /▶ Run extraction|↻ Re-run extraction/ }).click()
  await expect(freshPage.getByText('Running extraction…')).toBeVisible()
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
  await expect(freshPage.getByText('Running extraction…')).toBeVisible()
  await expect(status.getByRole('button', { name: 'Cancel extraction' })).toBeEnabled()
  await expect(freshPage.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true')

  await freshPage.goto(e2eStudioPath(`/projects/${projectContextId}/documents/${otherSourceDocumentId}`))
  await expect(freshPage.getByRole('button', { name: /Run extraction|Re-run extraction/ })).toBeVisible()
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(freshPage.getByText('Running extraction…')).toBeVisible()
  await expect(status).toContainText('Using Schema Revision 3 · Current revision: 4')
  await expect(status.getByText('Previous schema')).toBeVisible()
  if (!resultGate.release) throw new Error('The remote result was not blocked.')
  resultGate.release()
  await expect(freshPage.getByText('Running extraction…')).toBeHidden({ timeout: 30_000 })
  await expect(status).toContainText('Completed')
  await expect(status).toContainText('Review applies to Schema Revision 3')
  // The toolbar's one-shot selection is back at Article, whatever strategy this Extraction ran with.
  await expect(status.getByRole('button', { name: 'Run Article extraction with current schema' })).toBeEnabled()
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
  // Finish the admitted batch before closing its remote service; the shared
  // Studio worker must be available for the next strategy's fixture.
  expect((await waitForExtraction(freshPage.request, batchMember!.id)).outcome).toBe('SUCCEEDED')
  await fresh.close()
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolveClose())),
    )
    await rm(configHome, { recursive: true, force: true })
  }
})
