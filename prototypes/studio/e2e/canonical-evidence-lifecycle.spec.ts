import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { db } from '../../../packages/db/src/prisma/db.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import type { ParsedDocument } from 'extraction/parsed-document'
import { hashPassword } from '../server/password.js'
import {
  E2E_ORIGIN,
  E2E_PASSWORD,
  e2eStudioPath,
  loginResearcher,
} from './auth.js'
import {
  activateWithKeyboard,
  expectOperableInViewport,
  REQUIRED_VIEWPORTS,
} from './accessibility.js'

test.describe.configure({ mode: 'serial' })

const sha256 = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

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
) {
  const { strToU8, zipSync } = await import(
    createRequire(
      resolve(import.meta.dirname, '../../../packages/db/package.json'),
    ).resolve('fflate')
  )
  const pdf = await readFile(
    resolve(import.meta.dirname, '../../../examples/Beretning_Ellekilde_8_13.pdf'),
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

  const entries = [
    ['source.pdf', pdf, 'application/pdf'],
    ['parsed_document.json', strToU8(JSON.stringify(document)), 'application/json'],
    ['artifacts/document.llm.md', strToU8('# Article fixture\n\nGrav 8\n'), 'text/markdown; charset=utf-8'],
  ] as const
  const manifest = strToU8(
    JSON.stringify({
      package_version: 'canonical-ingestion-package.v1',
      parsed_document_schema_version: 'parsed_document.v2',
      source_sha256: sourceHash,
      preprocess_id: document.preprocessing.preprocess_id,
      entries: entries.map(([path, bytes, mediaType]) => ({
        path,
        media_type: mediaType,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      })),
    }),
  )
  return {
    bytes: zipSync(
      Object.fromEntries([
        ['manifest.json', manifest],
        ...entries.map(([path, bytes]) => [path, bytes]),
      ]),
      { level: 0 },
    ),
    sourceHash,
  }
}

test('real Article lifecycle persists review, exports its reviewed result, and reopens newer unreviewed pins independently @deterministic', async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    !process.env.EXTRACTION_TEST_DATABASE_URL ||
      process.env.DATABASE_URL !== process.env.EXTRACTION_TEST_DATABASE_URL,
    'DATABASE_URL must equal the disposable EXTRACTION_TEST_DATABASE_URL',
  )

  const configHome = resolve(import.meta.dirname, '../test-results/config-home')
  const configRoot =
    process.platform === 'win32'
      ? join(configHome, 'FREE Studio-nodejs', 'Config')
      : join(configHome, 'free-studio-nodejs')
  await rm(configHome, { recursive: true, force: true })

  let delayNextResponse = false
  let omitGrounding = false
  const modelServer = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const prompt = JSON.parse(body) as { prompt: string }
      const generated = prompt.prompt.includes('"links"')
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
            }],
          })
      const send = () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ response: generated, done_reason: 'stop', prompt_eval_count: 10, eval_count: 4, total_duration: 1_000_000 }))
      }
      if (delayNextResponse) {
        delayNextResponse = false
        setTimeout(send, 1_000)
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
  const researcherEmail = `canonical-evidence-${researcherAccountId}@example.test`
  const sourceDocumentId = randomUUID()
  const extractionSchemaId = randomUUID()
  const firstRepresentationId = randomUUID()
  const secondRepresentationId = randomUUID()
  const firstSchemaRevisionId = randomUUID()
  const secondSchemaRevisionId = randomUUID()
  const packageStore = createCanonicalPackageStore()
  const firstPackage = await canonicalPackage('reviewed.pdf')
  const firstDescriptor = await packageStore.save(firstPackage.bytes)

  await db.orm.public.ResearcherAccount.create({
    id: researcherAccountId,
    email: researcherEmail,
    passwordHash: await hashPassword(E2E_PASSWORD),
    mustChangePassword: false,
    disabledAt: null,
    sessionVersion: 0,
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
  await page.goto(
    `${e2eStudioPath('/login')}?${new URLSearchParams({ returnTo: internalUrl })}`,
  )
  const email = page.getByLabel('Email address')
  await expect(email).toBeFocused()
  await page.keyboard.type(researcherEmail)
  await page.keyboard.press('Tab')
  await page.keyboard.type(E2E_PASSWORD)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(url)
  await expect(page.getByText('6 pages', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await activateWithKeyboard(
    page,
    page.getByRole('button', { name: '▶ Run extraction' }),
  )
  await expect(page.getByRole('button', { name: '↻ Re-run extraction' })).toBeVisible()
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
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2'
  })
  await expectOperableInViewport(
    page,
    page.getByRole('button', { name: 'View Evidence for title' }),
  )
  await expectOperableInViewport(page, page.getByRole('button', { name: 'Export' }))
  await page.evaluate(() => {
    document.documentElement.style.zoom = ''
  })
  const titleReview = page.getByRole('group', { name: 'Review title' })
  await activateWithKeyboard(
    page,
    titleReview.getByRole('button', { name: 'Edit title' }),
  )
  await page.getByRole('textbox', { name: 'Reviewed value for title', exact: true }).fill('Reviewed, café')
  await activateWithKeyboard(
    page,
    page.getByRole('button', { name: 'Save reviewed value for title' }),
  )
  await expect(page.getByText('Reviewed, café', { exact: true })).toBeVisible()
  await activateWithKeyboard(
    page,
    page.getByRole('button', { name: 'Save Review' }),
  )
  await expect(page.getByRole('button', { name: 'Review saved' })).toBeVisible()
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
  const persistedDecisions = await db.orm.public.ReviewDecision.where({ extractionId: reviewed!.id })
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

  const fresh = await browser.newContext()
  const freshPage = await fresh.newPage()
  await loginResearcher(freshPage, researcherEmail)
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(freshPage.getByText('No reviewable result')).toBeVisible()
  await expect(freshPage.getByRole('button', { name: 'Save Review' })).toHaveCount(0)
  await freshPage.getByRole('button', { name: 'Raw JSON' }).click()
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
  await freshPage.getByRole('button', { name: 'Pinned schema' }).click()
  await expect(freshPage.locator('pre').filter({ hasText: 'One lifecycle fixture record.' })).toBeVisible()
  await expect(freshPage.getByText(firstSchemaRevisionId, { exact: true })).toBeVisible()
  await freshPage.getByRole('button', { name: 'Review' }).click()
  await expect(freshPage.getByText('Reviewed, café', { exact: true })).toBeVisible()
  await expect(freshPage.getByRole('button', { name: /^Edit / })).toHaveCount(0)
  await freshPage.screenshot({
    path: testInfo.outputPath('canonical-fresh-context-review.png'),
    fullPage: true,
  })
  await freshPage.getByLabel('Extraction snapshot').selectOption(newerExtractionId)
  await expect(freshPage.locator('iframe[title="Pinned Source Document"]')).toHaveCount(0)
  delayNextResponse = true
  await freshPage.getByRole('button', { name: '↻ Re-run extraction' }).click()
  await freshPage.getByRole('button', { name: 'Cancel extraction' }).click()
  await expect(
    freshPage.getByRole('tabpanel', { name: 'Results' }).getByText('Extraction cancelled', { exact: true }),
  ).toBeVisible()
  await fresh.close()
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolveClose())),
    )
    await rm(configHome, { recursive: true, force: true })
  }
})
