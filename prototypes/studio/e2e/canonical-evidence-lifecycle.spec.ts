import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { db } from '../../../packages/db/src/prisma/db.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'

const sha256 = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

async function canonicalPackage(originalFilename: string) {
  const { strToU8, zipSync } = await import(
    createRequire(
      resolve(import.meta.dirname, '../../../packages/db/package.json'),
    ).resolve('fflate')
  )
  const pdf = await readFile(
    resolve(import.meta.dirname, '../../../examples/Beretning_Ellekilde_8_13.pdf'),
  )
  const sourceHash = sha256(pdf)
  const document = JSON.parse(
    await readFile(
      resolve(import.meta.dirname, '../src/assets/parsed_document.v2.json'),
      'utf8',
    ),
  )
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
  test.skip(!process.env.ARTICLE_LIFECYCLE_E2E, 'set ARTICLE_LIFECYCLE_E2E=1')

  const projectContextId = randomUUID()
  const sourceDocumentId = randomUUID()
  const extractionSchemaId = randomUUID()
  const firstRepresentationId = randomUUID()
  const secondRepresentationId = randomUUID()
  const firstSchemaRevisionId = randomUUID()
  const secondSchemaRevisionId = randomUUID()
  const packageStore = createCanonicalPackageStore()
  const firstPackage = await canonicalPackage('reviewed.pdf')
  const firstDescriptor = await packageStore.save(firstPackage.bytes)

  await db.orm.public.ProjectContext.create({
    id: projectContextId,
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
    schemaTree: [
      {
        id: 'filename',
        name: 'filename',
        type: 'string',
        valueSource: 'source-filename',
      },
    ],
  })

  const url = `/projects/${projectContextId}/documents/${sourceDocumentId}`
  await page.goto(url)
  await expect(page.getByText(/6 pages · text highlights only/)).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: '▶ Run extraction' }).click()
  await expect(page.getByRole('button', { name: '↻ Re-run extraction' })).toBeVisible()
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(page.getByText('reviewed.pdf')).toBeVisible()
  await page.getByRole('button', { name: 'Accept result' }).click()
  await expect(page.getByRole('button', { name: 'Review saved' })).toBeVisible()

  const reviewed = await db.orm.public.Extraction.where({ sourceDocumentId })
    .select('id', 'reviewedAt')
    .orderBy((attempt) => attempt.createdAt.desc())
    .first()
  expect(reviewed?.reviewedAt).not.toBeNull()

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
    schemaTree: [
      {
        id: 'filename',
        name: 'filename',
        type: 'string',
        valueSource: 'source-filename',
      },
    ],
  })

  const newerExtractionId = randomUUID()
  const created = await page.request.post('/api/extractions', {
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
  await freshPage.goto(url)
  await freshPage.getByRole('tab', { name: /Results/ }).click()
  await expect(freshPage.getByText('newer-unreviewed.pdf')).toBeVisible()
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
  await fresh.close()
})
