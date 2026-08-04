import { describe, expect, it } from 'vitest'
import {
  createProjectStore,
  type DocumentReopenSnapshot,
} from '../../../packages/db/src/project-store.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import {
  DEMO_DOCUMENT_ID,
  DEMO_PROJECT_ID,
  DEMO_REPRESENTATION_ID,
  projectContextFixture,
} from './project_contexts.fixture.js'
import { createGetDocumentReopen } from './document_reopen.js'

type Row = Record<string, unknown>
type Ordering = { field: string; direction: 'asc' | 'desc' }

const projectContextId = '51000000-0000-4000-8000-000000000001'
const otherProjectContextId = '51000000-0000-4000-8000-000000000002'
const sourceDocumentId = '51000000-0000-4000-8001-000000000001'
const otherSourceDocumentId = '51000000-0000-4000-8001-000000000002'
const staleRepresentationId = '51000000-0000-4000-8002-000000000001'
const headRepresentationId = '51000000-0000-4000-8002-000000000002'
const extractionSchemaId = '51000000-0000-4000-8003-000000000001'
const staleSchemaRevisionId = '51000000-0000-4000-8004-000000000001'
const headSchemaRevisionId = '51000000-0000-4000-8004-000000000002'

const at = (minute: number) =>
  new Date(Date.UTC(2026, 6, 31, 12, minute, 0))

/**
 * An in-memory query engine, so selection is proven by the rows a read returns
 * rather than by the builder calls it happens to make.
 */
function fakeDatabase(tables: Readonly<Record<string, Row[]>>) {
  const reads: Array<{ table: string; transactional: boolean }> = []
  let depth = 0

  const orderingProbe = () =>
    new Proxy(
      {},
      {
        get: (_target, field: string) => ({
          asc: (): Ordering => ({ field, direction: 'asc' }),
          desc: (): Ordering => ({ field, direction: 'desc' }),
        }),
      },
    )

  const collection = (table: string) => {
    let rows = tables[table] ?? []
    let orderings: Ordering[] = []
    let limit: number | undefined
    const compare = (left: Row, right: Row) => {
      for (const { field, direction } of orderings) {
        const [a, b] = [left[field], right[field]].map((value) =>
          value instanceof Date ? value.getTime() : value,
        )
        if (a === b) continue
        const ascending = (a as number | string) < (b as number | string) ? -1 : 1
        return direction === 'asc' ? ascending : -ascending
      }
      return 0
    }
    const query = {
      select: () => query,
      where(filter: Row) {
        rows = rows.filter((row) =>
          Object.entries(filter).every(([key, value]) => row[key] === value),
        )
        return query
      },
      orderBy(
        selection:
          | ((model: Row) => Ordering)
          | ReadonlyArray<(model: Row) => Ordering>,
      ) {
        orderings = (Array.isArray(selection) ? selection : [selection]).map(
          (select: (model: Row) => Ordering) => select(orderingProbe() as Row),
        )
        return query
      },
      take(count: number) {
        limit = count
        return query
      },
      async all() {
        reads.push({ table, transactional: depth > 0 })
        return [...rows].sort(compare).slice(0, limit)
      },
      async first(filter?: Row) {
        if (filter) query.where(filter)
        return (await query.all())[0] ?? null
      },
    }
    return query
  }

  const orm = {
    public: new Proxy({}, { get: (_target, table: string) => collection(table) }),
  }
  return {
    reads,
    orm,
    async transaction<T>(run: (tx: { orm: typeof orm }) => PromiseLike<T>) {
      depth += 1
      try {
        return await run({ orm })
      } finally {
        depth -= 1
      }
    },
  }
}

function seededTables(): Record<string, Row[]> {
  return {
    ProjectContext: [
      {
        id: projectContextId,
        name: 'Ellekilde, TAK 1355',
        createdAt: at(0),
      },
      { id: otherProjectContextId, name: 'Test documents', createdAt: at(1) },
    ],
    SourceDocument: [
      {
        id: sourceDocumentId,
        projectContextId,
        originalName: 'Beretning_Ellekilde_8_13.pdf',
        createdAt: at(2),
      },
      {
        id: otherSourceDocumentId,
        projectContextId: otherProjectContextId,
        originalName: '1790-06-17-1.pdf',
        createdAt: at(3),
      },
    ],
    SourceRepresentationRevision: [
      {
        id: headRepresentationId,
        sourceDocumentId,
        revisionNumber: 2,
        createdAt: at(5),
        artifactReference: 'head-artifact',
        artifactSha256: 'b'.repeat(64),
        contractVersion: 'parsed_document.v1',
      },
      {
        id: staleRepresentationId,
        sourceDocumentId,
        revisionNumber: 1,
        createdAt: at(4),
        artifactReference: 'stale-artifact',
        artifactSha256: 'a'.repeat(64),
        contractVersion: 'parsed_document.v1',
      },
    ],
    AnnotationSetRevision: [
      {
        id: 'annotation-pinned-to-stale',
        sourceDocumentId,
        sourceRepresentationRevisionId: staleRepresentationId,
        revisionNumber: 3,
        snapshot: [{ annotationId: 'stale' }],
      },
      {
        id: 'annotation-head',
        sourceDocumentId,
        sourceRepresentationRevisionId: headRepresentationId,
        revisionNumber: 2,
        snapshot: [{ annotationId: 'head' }],
      },
    ],
    ExtractionSchema: [
      { id: extractionSchemaId, projectContextId, createdAt: at(6) },
    ],
    SchemaRevision: [
      {
        id: staleSchemaRevisionId,
        extractionSchemaId,
        revisionNumber: 1,
        schemaTree: { stale: 'verbatim-string' },
      },
      {
        id: headSchemaRevisionId,
        extractionSchemaId,
        revisionNumber: 2,
        schemaTree: { head: 'verbatim-string' },
      },
    ],
    Extraction: [
      {
        id: 'extraction-wrong-representation',
        sourceRepresentationRevisionId: staleRepresentationId,
        schemaRevisionId: headSchemaRevisionId,
        outcome: 'SUCCEEDED',
        createdAt: at(20),
        resultPayload: { result: { wrong: 'representation' }, evidence: null },
        failure: null,
      },
      {
        id: 'extraction-wrong-schema-revision',
        sourceRepresentationRevisionId: headRepresentationId,
        schemaRevisionId: staleSchemaRevisionId,
        outcome: 'SUCCEEDED',
        createdAt: at(21),
        resultPayload: { result: { wrong: 'schema' }, evidence: null },
        failure: null,
      },
      {
        id: 'extraction-compatible-older',
        sourceRepresentationRevisionId: headRepresentationId,
        schemaRevisionId: headSchemaRevisionId,
        outcome: 'SUCCEEDED',
        createdAt: at(9),
        resultPayload: { result: { older: true }, evidence: null },
        failure: null,
      },
      {
        id: 'extraction-compatible-newest',
        sourceRepresentationRevisionId: headRepresentationId,
        schemaRevisionId: headSchemaRevisionId,
        outcome: 'SUCCEEDED',
        createdAt: at(10),
        resultPayload: { result: { newest: true }, evidence: null },
        failure: null,
      },
    ],
  }
}

describe('getDocumentReopenSnapshot', () => {
  it('selects the head representation with its pinned annotations, schema head, and compatible Extraction in one transaction', async () => {
    const database = fakeDatabase(seededTables())
    const store = createProjectStore(database as never)

    const snapshot = await store.getDocumentReopenSnapshot(
      projectContextId,
      sourceDocumentId,
    )

    expect(snapshot).toEqual({
      projectContext: {
        projectContextId,
        name: 'Ellekilde, TAK 1355',
        createdAt: at(0),
      },
      sourceDocument: {
        sourceDocumentId,
        name: 'Beretning_Ellekilde_8_13.pdf',
        createdAt: at(2),
      },
      sourceRepresentation: {
        sourceRepresentationId: headRepresentationId,
        revisionNumber: 2,
        createdAt: at(5),
      },
      annotationSet: {
        annotationSetId: 'annotation-head',
        revisionNumber: 2,
        snapshot: [{ annotationId: 'head' }],
      },
      extractionSchema: {
        extractionSchemaId,
        revisionNumber: 2,
        schemaTree: { head: 'verbatim-string' },
      },
      extraction: {
        extractionId: 'extraction-compatible-newest',
        createdAt: at(10),
        outcome: 'SUCCEEDED',
        resultPayload: { result: { newest: true }, evidence: null },
        failure: null,
      },
    })
    expect(database.reads.length).toBeGreaterThan(1)
    expect(database.reads.every((read) => read.transactional)).toBe(true)
  })

  it('treats missing optional research state as a valid snapshot', async () => {
    const tables = seededTables()
    const database = fakeDatabase({
      ...tables,
      AnnotationSetRevision: [],
      ExtractionSchema: [],
      SchemaRevision: [],
      Extraction: [],
    })

    const snapshot = await createProjectStore(
      database as never,
    ).getDocumentReopenSnapshot(projectContextId, sourceDocumentId)

    expect(snapshot).toMatchObject({
      annotationSet: null,
      extractionSchema: null,
      extraction: null,
      sourceRepresentation: { revisionNumber: 2 },
    })
  })

  it.each([
    ['a Source Document held by another Project Context', otherProjectContextId, sourceDocumentId],
    ['an unknown Project Context', '51000000-0000-4000-8000-000000000009', sourceDocumentId],
    ['an unknown Source Document', projectContextId, '51000000-0000-4000-8001-000000000009'],
  ])('returns null for %s', async (_case, project, document) => {
    const store = createProjectStore(fakeDatabase(seededTables()) as never)
    await expect(
      store.getDocumentReopenSnapshot(project, document),
    ).resolves.toBeNull()
  })

  it('returns null for a Source Document with no durable representation', async () => {
    const database = fakeDatabase({
      ...seededTables(),
      SourceRepresentationRevision: [],
    })
    await expect(
      createProjectStore(database as never).getDocumentReopenSnapshot(
        projectContextId,
        sourceDocumentId,
      ),
    ).resolves.toBeNull()
  })

  it('resolves the server-only artifact descriptor of one representation', async () => {
    const store = createProjectStore(fakeDatabase(seededTables()) as never)

    await expect(
      store.getSourceRepresentation(headRepresentationId),
    ).resolves.toEqual({
      artifactReference: 'head-artifact',
      artifactSha256: 'b'.repeat(64),
    })
    await expect(
      store.getSourceRepresentation(staleSchemaRevisionId),
    ).resolves.toBeNull()
  })
})

const reopenUrl = (project: string, document: string) =>
  `http://test/api/project-contexts/${project}/source-documents/${document}/reopen`

describe('GET /api/project-contexts/:id/source-documents/:id/reopen', () => {
  it('composes the browser snapshot with same-origin resources only', async () => {
    const GET = createGetDocumentReopen(projectContextFixture())

    const response = await GET(
      new Request(reopenUrl(DEMO_PROJECT_ID, DEMO_DOCUMENT_ID)),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body: unknown = await response.json()
    expect(documentReopenResponseSchema.parse(body)).toEqual({
      projectContext: {
        projectContextId: DEMO_PROJECT_ID,
        name: 'Ellekilde, TAK 1355',
        createdAt: '2026-07-31T12:00:00.000Z',
      },
      sourceDocument: {
        sourceDocumentId: DEMO_DOCUMENT_ID,
        name: 'Beretning_Ellekilde_8_13.pdf',
        createdAt: '2026-07-31T12:01:00.000Z',
      },
      sourceRepresentation: {
        sourceRepresentationId: DEMO_REPRESENTATION_ID,
        revisionNumber: 2,
        resources: {
          sourcePdfUrl: `/api/source-representations/${DEMO_REPRESENTATION_ID}/pdf`,
          markdownUrl: `/api/source-representations/${DEMO_REPRESENTATION_ID}/markdown`,
          parsedDocumentUrl: `/api/source-representations/${DEMO_REPRESENTATION_ID}/parsed-document`,
        },
      },
      annotationSet: null,
      extractionSchema: null,
      extraction: null,
    })
    // No artifact reference, hash, contract version, or storage path escapes.
    expect(JSON.stringify(body)).not.toMatch(/artifact|sha256|parsed_document\.v1/i)
  })

  it('projects durable annotations, the Schema head, and the compatible Extraction', async () => {
    const snapshot: DocumentReopenSnapshot = {
      ...(await projectContextFixture().getDocumentReopenSnapshot(
        DEMO_PROJECT_ID,
        DEMO_DOCUMENT_ID,
      ))!,
      annotationSet: {
        annotationSetId: '00000000-0000-4000-8000-0000000000c1',
        revisionNumber: 3,
        snapshot: [
          {
            annotationId: '00000000-0000-4000-8000-0000000000d1',
            evidenceAnchorId: 'anchor-7',
            text: 'jordfæstegrav',
            pageNumber: 4,
          },
        ],
      },
      extractionSchema: {
        extractionSchemaId: '00000000-0000-4000-8000-0000000000e1',
        revisionNumber: 5,
        schemaTree: { site: 'verbatim-string' },
      },
      extraction: {
        extractionId: '00000000-0000-4000-8000-0000000000f1',
        createdAt: new Date('2026-07-31T13:00:00.000Z'),
        outcome: 'SUCCEEDED',
        resultPayload: { result: { site: 'Ellekilde' }, evidence: null },
        failure: null,
      },
    }
    const GET = createGetDocumentReopen({
      async getDocumentReopenSnapshot() {
        return snapshot
      },
    })

    const response = await GET(
      new Request(reopenUrl(DEMO_PROJECT_ID, DEMO_DOCUMENT_ID)),
    )

    expect(
      documentReopenResponseSchema.parse(await response.json()),
    ).toMatchObject({
      annotationSet: {
        annotationSetId: '00000000-0000-4000-8000-0000000000c1',
        revisionNumber: 3,
        annotations: [{ evidenceAnchorId: 'anchor-7', pageNumber: 4 }],
      },
      extractionSchema: { revisionNumber: 5, template: { site: 'verbatim-string' } },
      extraction: {
        outcome: 'succeeded',
        createdAt: '2026-07-31T13:00:00.000Z',
        result: { site: 'Ellekilde' },
        evidence: null,
      },
    })
  })

  it.each([
    ['a failed attempt', 'FAILED' as const, { code: 'model_operation_failed', message: 'The model operation failed.' }, { outcome: 'failed', failure: { code: 'model_operation_failed', message: 'The model operation failed.' } }],
    ['a cancelled attempt', 'CANCELLED' as const, null, { outcome: 'cancelled' }],
  ])('projects %s without raw model output', async (_case, outcome, failure, expected) => {
    const base = (await projectContextFixture().getDocumentReopenSnapshot(
      DEMO_PROJECT_ID,
      DEMO_DOCUMENT_ID,
    ))!
    const GET = createGetDocumentReopen({
      async getDocumentReopenSnapshot() {
        return {
          ...base,
          extraction: {
            extractionId: '00000000-0000-4000-8000-0000000000f1',
            createdAt: new Date('2026-07-31T13:00:00.000Z'),
            outcome,
            resultPayload: null,
            failure,
          },
        }
      },
    })

    const response = await GET(
      new Request(reopenUrl(DEMO_PROJECT_ID, DEMO_DOCUMENT_ID)),
    )

    expect(
      documentReopenResponseSchema.parse(await response.json()),
    ).toMatchObject({ extraction: expected })
  })

  it.each([
    ['NOT-A-UUID', DEMO_DOCUMENT_ID, 422, 'invalid_request'],
    [DEMO_PROJECT_ID, 'NOT-A-UUID', 422, 'invalid_request'],
    [DEMO_PROJECT_ID, '00000000-0000-4000-8000-000000000046', 404, 'not_found'],
    ['00000000-0000-4000-8000-000000000046', DEMO_DOCUMENT_ID, 404, 'not_found'],
  ])('bounds %s / %s as %i', async (project, document, status, code) => {
    const GET = createGetDocumentReopen(projectContextFixture())

    const response = await GET(new Request(reopenUrl(project, document)))

    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({ error: { code } })
  })

  it('bounds a persistence failure and unreadable durable research state', async () => {
    const failing = createGetDocumentReopen({
      async getDocumentReopenSnapshot() {
        throw new Error('postgresql://secret@localhost/free')
      },
    })
    const failure = await failing(
      new Request(reopenUrl(DEMO_PROJECT_ID, DEMO_DOCUMENT_ID)),
    )
    expect(failure.status).toBe(503)
    await expect(failure.json()).resolves.toEqual({
      error: {
        code: 'persistence_unavailable',
        message: 'Project Context storage is unavailable.',
      },
    })

    const base = (await projectContextFixture().getDocumentReopenSnapshot(
      DEMO_PROJECT_ID,
      DEMO_DOCUMENT_ID,
    ))!
    const corrupt = createGetDocumentReopen({
      async getDocumentReopenSnapshot() {
        return {
          ...base,
          annotationSet: {
            annotationSetId: '00000000-0000-4000-8000-0000000000c1',
            revisionNumber: 1,
            snapshot: [{ annotationId: 'not-a-uuid' }],
          },
        }
      },
    })
    const integrity = await corrupt(
      new Request(reopenUrl(DEMO_PROJECT_ID, DEMO_DOCUMENT_ID)),
    )
    expect(integrity.status).toBe(503)
    await expect(integrity.json()).resolves.toMatchObject({
      error: { code: 'persistence_unavailable' },
    })
  })
})
