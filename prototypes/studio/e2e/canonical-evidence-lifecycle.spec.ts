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
import { E2E_ORIGIN, E2E_PASSWORD, loginResearcher } from './auth.js'

test.describe.configure({ mode: 'serial' })

const sha256 = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

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

test('real Article lifecycle persists review and reopens newer unreviewed pins independently', async ({
  browser,
  page,
}) => {
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
  const modelServer = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const prompt = JSON.parse(body) as { prompt: string }
      const generated = prompt.prompt.includes('"links"')
        ? '{"links":{"C1":"E1"}}'
        : '{"records":[{"title":"Grav 8"}]}'
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
      schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
    },
  })

  await loginResearcher(page, researcherEmail)
  const url = `/projects/${projectContextId}/documents/${sourceDocumentId}`
  await page.goto(url)
  await expect(page.getByText('6 pages', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: '▶ Run extraction' }).click()
  await expect(page.getByRole('button', { name: '↻ Re-run extraction' })).toBeVisible()
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(
    page.getByRole('button', { name: 'View Evidence for title' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Save Review' }).click()
  await expect(page.getByRole('button', { name: 'Review saved' })).toBeVisible()

  const reviewed = await db.orm.public.Extraction.where({ sourceDocumentId })
    .select('id', 'reviewedAt')
    .orderBy((attempt) => attempt.createdAt.desc())
    .first()
  expect(reviewed?.reviewedAt).not.toBeNull()
  expect(
    await db.orm.public.ReviewDecision.where({ extractionId: reviewed!.id })
      .select('id')
      .all(),
  ).toHaveLength(1)

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
      schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
    },
  })

  const newerExtractionId = randomUUID()
  const created = await page.request.post('/api/extractions', {
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
  await expect(
    freshPage.getByRole('button', { name: 'View Evidence for title' }),
  ).toBeVisible()
  await expect(
    freshPage.getByRole('button', { name: 'Save Review' }),
  ).toBeVisible()
  const reopened = documentReopenResponseSchema.parse(
    await (
      await freshPage.request.get(
        `/api/project-contexts/${projectContextId}/source-documents/${sourceDocumentId}/reopen`,
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
