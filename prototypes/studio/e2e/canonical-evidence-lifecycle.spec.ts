import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { db } from '../../../packages/db/src/prisma/db.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import type { ParsedContentBlock, ParsedDocument } from '../shared/parsedDocument.js'

const nodeRequire = createRequire(import.meta.url)

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
  document.pages[0].ordered_content = blocks.map((block: { block_id: string }) => block.block_id)
  return document
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
    schemaTree: {
      recordDescription: 'One lifecycle fixture record.',
      schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
    },
  })

  const url = `/projects/${projectContextId}/documents/${sourceDocumentId}`
  await page.goto(url)
  await expect(page.getByText(/6 pages · text highlights only/)).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: '▶ Run extraction' }).click()
  await expect(page.getByRole('button', { name: '↻ Re-run extraction' })).toBeVisible()
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(
    page.getByRole('button', { name: 'View Evidence for title' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Accept result' }).click()
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
  await expect(
    freshPage.getByRole('button', { name: 'View Evidence for title' }),
  ).toBeVisible()
  await expect(
    freshPage.getByRole('button', { name: 'Accept result' }),
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
  await expect(freshPage.getByTitle('Pinned Source Document')).toBeVisible()
  await freshPage.getByRole('button', { name: 'Pinned schema' }).click()
  await expect(freshPage.locator('pre').filter({ hasText: 'One lifecycle fixture record.' })).toBeVisible()
  await freshPage.getByLabel('Extraction snapshot').selectOption(newerExtractionId)
  await expect(freshPage.getByTitle('Pinned Source Document')).toHaveCount(0)
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

test('real Catalog lifecycle covers partials, retry, truncation, cancellation, review, and reopen', async ({
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
      : join(configHome, 'free-studio-nodejs')
  await rm(configHome, { recursive: true, force: true })

  type FixtureResponse = {
    result?: Record<string, unknown>
    status?: number
    delayMs?: number
    grounding?: boolean
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
        const labels = [...prompt.matchAll(/(?:^|\n)\s*\[C(\d+)\]/g)].map((match) => match[1])
        result = {
          links: Object.fromEntries([...new Set(labels)].map((label) => [`C${label}`, 'E1'])),
        }
      }
      const send = () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            response: JSON.stringify(result),
            done_reason: 'stop',
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
  const sourceDocumentId = randomUUID()
  const extractionSchemaId = randomUUID()
  const firstRepresentationId = randomUUID()
  const truncationRepresentationId = randomUUID()
  const cancellationRepresentationId = randomUUID()
  const firstSchemaRevisionId = randomUUID()
  const packageSchemaRevisionId = randomUUID()
  const packageStore = createCanonicalPackageStore()
  const firstPackage = await canonicalPackage('catalog.pdf', catalogDocument(['First', 'Second', 'Third']))
  const truncationPackage = await canonicalPackage(
    'catalog-truncation.pdf',
    catalogDocument(Array.from({ length: 101 }, (_, index) => `Record ${index + 1}`)),
  )
  const cancellationPackage = await canonicalPackage('catalog-cancellation.pdf', catalogDocument(['First', 'Second', 'Third']))
  const firstDescriptor = await packageStore.save(firstPackage.bytes)
  const truncationDescriptor = await packageStore.save(truncationPackage.bytes)
  const cancellationDescriptor = await packageStore.save(cancellationPackage.bytes)
  const url = `/projects/${projectContextId}/documents/${sourceDocumentId}`
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
    await db.orm.public.ProjectContext.create({ id: projectContextId, name: 'Catalog lifecycle E2E' })
    await db.orm.public.SourceDocument.create({
      id: sourceDocumentId,
      projectContextId,
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

    await page.goto(url)
    await expect(page.getByText(/6 pages · text highlights only/)).toBeVisible({ timeout: 20_000 })

    resetQueues()
    enqueue('document', { result: { records: [{ year: 2026 }] } })
    enqueue('discovery', { result: { starts: ['First', 'Second'] } })
    enqueue('record', { result: { records: [{ title: 'A' }] } }, { result: { records: [{ title: 'B' }] } })
    enqueue('grounding', { grounding: true }, { grounding: true })
    await page.getByLabel('Extraction strategy').selectOption('CATALOG')
    await page.getByRole('button', { name: '▶ Run extraction' }).click()
    await expect(page.getByRole('tab', { name: /Results/ })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('tab', { name: /Results/ }).click()
    await expect(page.getByText('catalog', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Accept result' })).toBeVisible()
    await page.getByRole('button', { name: 'Accept result' }).click()
    await expect(page.getByRole('button', { name: 'Review saved' })).toBeVisible()
    const complete = await db.orm.public.Extraction.where({ sourceDocumentId }).orderBy((attempt) => attempt.createdAt.asc()).first()
    expect(complete?.outcome).toBe('SUCCEEDED')
    expect(complete?.complete).toBe(true)

    resetQueues()
    enqueue('document', { result: { records: [{ year: 2026 }] } })
    enqueue('discovery', { result: { starts: ['First', 'Second', 'Third'] } })
    enqueue('record', { result: { records: [{ title: 'A' }] } }, { status: 500 }, { result: { records: [{ title: 'C' }] } })
    enqueue('grounding', { grounding: true }, { grounding: true })
    const partialId = randomUUID()
    const partialResponse = await page.request.post('/api/extractions', {
      data: { id: partialId, sourceRepresentationRevisionId: firstRepresentationId, schemaRevisionId: firstSchemaRevisionId, strategy: 'CATALOG' },
    })
    expect(partialResponse.status()).toBe(201)
    const partial = await partialResponse.json()
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
    expect(partial.resultPayload.records).not.toContainEqual({})
    expect(partial.diagnostics.catalog.records[1]).toMatchObject({ outcome: 'failed', calls: 1 })

    resetQueues()
    enqueue('document', { result: { records: [{ year: 2026 }] } })
    enqueue('discovery', { result: { starts: ['Missing'] } })
    const discoveryFailureResponse = await page.request.post('/api/extractions', {
      data: { id: randomUUID(), sourceRepresentationRevisionId: firstRepresentationId, schemaRevisionId: firstSchemaRevisionId, strategy: 'CATALOG' },
    })
    expect(discoveryFailureResponse.status()).toBe(201)
    const discoveryFailure = await discoveryFailureResponse.json()
    expect(discoveryFailure).toMatchObject({ outcome: 'FAILED', resultPayload: null })
    expect(discoveryFailure.diagnostics.catalog.records).toEqual([])
    expect(discoveryFailure.diagnostics.catalog.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'discovery', outcome: 'failed', failureCode: 'unknown_label' }),
        expect.objectContaining({ stage: 'record-values', outcome: 'not_attempted', calls: 0 }),
      ]),
    )

    const failedRecordStart = partial.diagnostics.catalog.records[1].boundary.startBlockId
    resetQueues()
    enqueue('record', { result: { records: [{ title: 'B' }] } })
    enqueue('grounding', { grounding: true }, { grounding: true }, { grounding: true })
    const retryId = randomUUID()
    const retryResponse = await page.request.post('/api/extractions', {
      data: {
        id: retryId,
        retryOfId: partialId,
        retryDocument: false,
        rediscover: false,
        retryRecordStartBlockIds: [failedRecordStart],
      },
    })
    expect(retryResponse.status()).toBe(201)
    const retry = await retryResponse.json()
    expect(retry).toMatchObject({ outcome: 'SUCCEEDED', resultPayload: { records: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] } })
    expect(retry.diagnostics.catalog.records.map((record: { provenance: string }) => record.provenance)).toEqual(['reused', 'executed', 'reused'])
    const reviewResponse = await page.request.post(`/api/extractions/${retryId}/review`, {
      data: { reviewDecisions: [{ evidenceAnchorId: 'bundled-anchor', reviewedOccurrenceIds: ['bundled-occurrence'] }] },
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

    resetQueues()
    enqueue('discovery', { result: { starts: Array.from({ length: 101 }, (_, index) => `Record ${index + 1}`) } })
    const truncationResponse = await page.request.post('/api/extractions', {
      data: { id: randomUUID(), sourceRepresentationRevisionId: truncationRepresentationId, schemaRevisionId: packageSchemaRevisionId, strategy: 'CATALOG' },
    })
    expect(truncationResponse.status()).toBe(201)
    const truncation = await truncationResponse.json()
    expect(truncation).toMatchObject({ outcome: 'SUCCEEDED', complete: false })
    expect(truncation.resultPayload.records).toHaveLength(100)
    expect(truncation.diagnostics.catalog.records).toHaveLength(101)
    expect(truncation.diagnostics.catalog.records[100]).toMatchObject({ outcome: 'not_attempted', failureCode: 'not_attempted_limit', calls: 0 })

    const cancellationId = randomUUID()
    const callsBeforeCancellation = callCount
    resetQueues()
    enqueue('document', { result: { records: [{ year: 2026 }] } })
    enqueue('discovery', { result: { starts: ['First', 'Second', 'Third'] } })
    enqueue('record', { result: { records: [{ title: 'A' }] } }, { result: { records: [{ title: 'B' }] }, delayMs: 10_000 })
    const cancellationPost = page.request.post('/api/extractions', {
      data: { id: cancellationId, sourceRepresentationRevisionId: cancellationRepresentationId, schemaRevisionId: firstSchemaRevisionId, strategy: 'CATALOG' },
    })
    await waitForCalls(callsBeforeCancellation + 4)
    const cancellationDelete = await page.request.delete(`/api/extractions/${cancellationId}`)
    expect(cancellationDelete.status()).toBe(202)
    const cancelledResponse = await cancellationPost
    expect(cancelledResponse.status()).toBe(201)
    const cancelled = await cancelledResponse.json()
    expect(cancelled).toMatchObject({ outcome: 'CANCELLED', resultPayload: null })

    const fresh = await browser.newContext()
    const freshPage = await fresh.newPage()
    await freshPage.goto(url)
    await freshPage.getByRole('tab', { name: /Results/ }).click()
    await expect(
      freshPage.getByRole('tabpanel', { name: 'Results' }).getByText('Extraction cancelled', { exact: true }),
    ).toBeVisible()
    const reopened = documentReopenResponseSchema.parse(
      await (await freshPage.request.get(`/api/project-contexts/${projectContextId}/source-documents/${sourceDocumentId}/reopen`)).json(),
    )
    expect(reopened.latestAttempt).toMatchObject({ extractionId: cancellationId, sourceRepresentationRevisionId: cancellationRepresentationId, schemaRevisionId: firstSchemaRevisionId, outcome: 'CANCELLED' })
    expect(reopened.latestReviewed).toMatchObject(finalizedRetry)
    expect(reopened.latestReviewed?.extractionId).toBe(finalizedRetry.extractionId)
    expect(reopened.latestReviewed?.sourceRepresentationRevisionId).toBe(
      finalizedRetry.sourceRepresentationRevisionId,
    )
    expect(reopened.latestReviewed?.schemaRevisionId).toBe(finalizedRetry.schemaRevisionId)
    expect(reopened.latestReviewed?.strategy).toBe(finalizedRetry.strategy)
    expect(reopened.latestReviewed?.retryOfId).toBe(finalizedRetry.retryOfId)
    expect(reopened.latestReviewed?.resultPayload).toEqual(finalizedRetry.resultPayload)
    expect(reopened.latestReviewed?.complete).toBe(finalizedRetry.complete)
    expect(reopened.latestReviewed?.reviewable).toBe(finalizedRetry.reviewable)
    expect(reopened.latestReviewed?.reviewedAt).toBe(finalizedRetry.reviewedAt)
    expect(reopened.latestReviewed?.diagnostics).toEqual(finalizedRetry.diagnostics)
    expect(reopened.latestReviewed?.evidenceLinks).toEqual(finalizedRetry.evidenceLinks)
    expect(reopened.latestReviewed?.modelAttribution).toEqual(finalizedRetry.modelAttribution)
    expect(reopened.latestReviewed?.failure).toEqual(finalizedRetry.failure)
    expect(reopened.latestReviewed?.reviewDecisions).toEqual(finalizedRetry.reviewDecisions)
    expect(reopened.latestReviewed?.sourceRepresentation).toMatchObject({
      revisionNumber: 1,
      resources: {
        sourcePdfUrl: expect.stringContaining(firstRepresentationId),
        markdownUrl: expect.stringContaining(firstRepresentationId),
        parsedDocumentUrl: expect.stringContaining(firstRepresentationId),
      },
    })
    expect(reopened.latestReviewed?.extractionSchema).toMatchObject({
      extractionSchemaId,
      revisionNumber: 1,
      recordDescription: 'One catalog record.',
      schemaNodes: [
        { id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' },
        { id: 'year', name: 'year', type: 'integer', valueSource: 'document' },
        { id: 'title', name: 'title', type: 'string' },
      ],
    })
    expect(reopened.latestAttempt?.sourceRepresentation).toMatchObject({
      revisionNumber: 3,
      resources: {
        sourcePdfUrl: expect.stringContaining(cancellationRepresentationId),
        markdownUrl: expect.stringContaining(cancellationRepresentationId),
        parsedDocumentUrl: expect.stringContaining(cancellationRepresentationId),
      },
    })
    expect(reopened.latestAttempt?.extractionSchema).toMatchObject({
      extractionSchemaId,
      revisionNumber: 1,
      recordDescription: 'One catalog record.',
      schemaNodes: [
        { id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' },
        { id: 'year', name: 'year', type: 'integer', valueSource: 'document' },
        { id: 'title', name: 'title', type: 'string' },
      ],
    })
    expect(reopened.sourceRepresentation).toMatchObject({
      sourceRepresentationId: cancellationRepresentationId,
      revisionNumber: 3,
      resources: {
        sourcePdfUrl: expect.stringContaining(cancellationRepresentationId),
        markdownUrl: expect.stringContaining(cancellationRepresentationId),
        parsedDocumentUrl: expect.stringContaining(cancellationRepresentationId),
      },
    })
    expect(reopened.extractionSchema).toMatchObject({
      extractionSchemaId,
      schemaRevisionId: packageSchemaRevisionId,
      revisionNumber: 2,
      recordDescription: 'One package-only catalog record.',
      schemaNodes: [{ id: 'filename', name: 'filename', type: 'string', valueSource: 'source-filename' }],
    })
    await fresh.close()
  } finally {
    await new Promise<void>((resolveClose, reject) => modelServer.close((error) => (error ? reject(error) : resolveClose())))
    await rm(configHome, { recursive: true, force: true })
  }
})
