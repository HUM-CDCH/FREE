import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createProjectStore,
  type IngestSourceDocumentInput,
} from './project-store.js'

type Row = Record<string, unknown>
type Order = { field: string; direction: 'asc' | 'desc' }

const PROJECT = '51000000-0000-4000-8000-000000000001'
const OTHER_PROJECT = '51000000-0000-4000-8000-000000000002'
const EMPTY_PROJECT = '51000000-0000-4000-8000-000000000003'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const REVISION_1 = '51000000-0000-4000-8004-000000000001'

const DOCUMENT = '51000000-0000-4000-8001-000000000001'
const OTHER_DOCUMENT = '51000000-0000-4000-8001-000000000002'
const SHARED_PACKAGE = 'a'.repeat(64)
const OWN_PACKAGE = 'b'.repeat(64)

const nodes = (name: string) => [{ id: `node-${name}`, name, type: 'string' }]

const ingestion = (
  overrides: Partial<IngestSourceDocumentInput> = {},
): IngestSourceDocumentInput => ({
  ingestionKey: '51000000-0000-4000-9000-000000000001',
  contentSha256: 'c'.repeat(64),
  mediaType: 'application/pdf',
  originalName: 'Ellekilde.pdf',
  artifactReference: 'd'.repeat(64),
  artifactSha256: 'd'.repeat(64),
  contractVersion: 'parsed_document.v2',
  preprocessId: `sha256:${'e'.repeat(64)}`,
  parserName: 'docling_pdf',
  parserVersion: '2.0.0',
  ensureRetained: async () => {},
  ...overrides,
})

function fakeDatabase(
  options: {
    raceOnCreate?: boolean
    raceOnIngestion?: boolean
    failRepresentationCreate?: boolean
  } = {},
) {
  const tables: Record<string, Row[]> = {
    ProjectContext: [
      {
        id: PROJECT,
        name: 'Ellekilde, TAK 1355',
        createdAt: new Date('2026-08-01T11:00:00Z'),
      },
      {
        id: OTHER_PROJECT,
        name: 'Other',
        createdAt: new Date('2026-08-01T11:01:00Z'),
      },
      {
        id: EMPTY_PROJECT,
        name: 'Empty',
        createdAt: new Date('2026-08-01T11:02:00Z'),
      },
    ],
    SourceDocument: [
      { id: DOCUMENT, projectContextId: PROJECT },
      { id: OTHER_DOCUMENT, projectContextId: OTHER_PROJECT },
    ],
    SourceRepresentationRevision: [
      {
        id: '51000000-0000-4000-8002-000000000001',
        sourceDocumentId: DOCUMENT,
        artifactReference: OWN_PACKAGE,
        artifactSha256: OWN_PACKAGE,
      },
      {
        id: '51000000-0000-4000-8002-000000000002',
        sourceDocumentId: DOCUMENT,
        artifactReference: SHARED_PACKAGE,
        artifactSha256: SHARED_PACKAGE,
      },
      // Another Project Context still references the content-addressed package.
      {
        id: '51000000-0000-4000-8002-000000000003',
        sourceDocumentId: OTHER_DOCUMENT,
        artifactReference: SHARED_PACKAGE,
        artifactSha256: SHARED_PACKAGE,
      },
    ],
    ExtractionSchema: [
      {
        id: SCHEMA,
        projectContextId: PROJECT,
        name: 'Places',
        createdAt: new Date('2026-08-01T11:10:00Z'),
      },
      {
        id: '51000000-0000-4000-8003-000000000002',
        projectContextId: OTHER_PROJECT,
        name: 'Other schema',
        createdAt: new Date('2026-08-01T11:11:00Z'),
      },
    ],
    SchemaRevision: [
      {
        id: REVISION_1,
        extractionSchemaId: SCHEMA,
        revisionNumber: 1,
        origin: 'SUGGESTION',
        schemaTree: nodes('site'),
        createdAt: new Date('2026-08-01T12:00:00Z'),
      },
    ],
  }
  let raced = false
  let ingestionRaced = false
  const orderProbe = () =>
    new Proxy(
      {},
      {
        get: (_target, field: string) => ({
          asc: (): Order => ({ field, direction: 'asc' }),
          desc: (): Order => ({ field, direction: 'desc' }),
        }),
      },
    )
  const collection = (table: string) => {
    const rows = (tables[table] ??= [])
    let selected = rows
    let orders: Order[] = []
    let limit: number | undefined
    const query = {
      select: () => query,
      where(filter: Row) {
        selected = selected.filter((row) =>
          Object.entries(filter).every(([key, value]) => row[key] === value),
        )
        return query
      },
      orderBy(value: ((row: Row) => Order) | Array<(row: Row) => Order>) {
        orders = (Array.isArray(value) ? value : [value]).map((pick) =>
          pick(orderProbe() as Row),
        )
        return query
      },
      take(value: number) {
        limit = value
        return query
      },
      async all() {
        return [...selected]
          .sort((left, right) => {
            for (const { field, direction } of orders) {
              const a =
                left[field] instanceof Date
                  ? (left[field] as Date).getTime()
                  : left[field]
              const b =
                right[field] instanceof Date
                  ? (right[field] as Date).getTime()
                  : right[field]
              if (a === b) continue
              const result =
                (a as number | string) < (b as number | string) ? -1 : 1
              return direction === 'asc' ? result : -result
            }
            return 0
          })
          .slice(0, limit)
      },
      async first(filter?: Row) {
        if (filter) query.where(filter)
        return (await query.all())[0] ?? null
      },
      async create(input: Row) {
        if (input.id !== undefined && rows.some((row) => row.id === input.id))
          throw Object.assign(new Error('unique constraint'), {
            sqlState: '23505',
          })
        if (
          table === 'SourceDocument' &&
          rows.some((row) => row.ingestionKey === input.ingestionKey)
        )
          throw Object.assign(new Error('unique constraint'), {
            sqlState: '23505',
          })
        if (
          table === 'SourceDocument' &&
          options.raceOnIngestion &&
          !ingestionRaced
        ) {
          ingestionRaced = true
          throw Object.assign(new Error('unique constraint'), {
            sqlState: '23505',
            ingestionInput: input,
          })
        }
        if (
          table === 'SourceRepresentationRevision' &&
          options.failRepresentationCreate
        )
          throw new Error('representation write failed')
        if (table === 'SchemaRevision' && options.raceOnCreate && !raced) {
          raced = true
          rows.push({
            ...input,
            id: '51000000-0000-4000-8004-000000000099',
            schemaTree: nodes('rival'),
            createdAt: new Date('2026-08-01T12:01:00Z'),
          })
          throw Object.assign(new Error('unique constraint'), {
            sqlState: '23505',
          })
        }
        const row = {
          ...input,
          id:
            input.id ??
            `51000000-0000-4000-${table === 'ExtractionSchema' ? '8003' : '8004'}-${String(rows.length + 1).padStart(12, '0')}`,
          createdAt:
            input.createdAt ?? new Date(`2026-08-01T12:0${rows.length}:00Z`),
        }
        rows.push(row)
        return row
      },
      async update(input: Row) {
        const row = (await query.all())[0]
        if (!row) return null
        Object.assign(row, input)
        return row
      },
      // No cascade: the owned graph is PostgreSQL's job, proven by
      // `project-store.postgres.check.ts`. Re-implementing it here would only
      // prove that two hand-written copies agree.
      async delete() {
        const doomed = await query.all()
        for (const row of doomed) rows.splice(rows.indexOf(row), 1)
        return doomed[0] ?? null
      },
    }
    return query
  }
  const orm = {
    public: new Proxy(
      {},
      { get: (_target, table: string) => collection(table) },
    ),
  }
  return {
    tables,
    orm,
    transaction: async <T>(run: (tx: { orm: typeof orm }) => Promise<T>) => {
      const snapshot = Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [
          name,
          rows.map((row) => ({ ...row })),
        ]),
      )
      try {
        return await run({ orm })
      } catch (error) {
        const concurrentSchemaWinner =
          options.raceOnCreate &&
          typeof error === 'object' &&
          error !== null &&
          'sqlState' in error &&
          error.sqlState === '23505'
        if (!concurrentSchemaWinner)
          for (const [name, rows] of Object.entries(snapshot))
            tables[name].splice(0, tables[name].length, ...rows)
        const racedInput =
          typeof error === 'object' &&
          error !== null &&
          'ingestionInput' in error
            ? (error.ingestionInput as Row)
            : null
        if (racedInput) {
          const sourceDocumentId = '51000000-0000-4000-8001-000000000099'
          tables.SourceDocument.push({
            ...racedInput,
            id: sourceDocumentId,
            createdAt: new Date('2026-08-01T12:05:00Z'),
          })
          tables.SourceRepresentationRevision.push({
            id: '51000000-0000-4000-8002-000000000099',
            sourceDocumentId,
            revisionNumber: 1,
            artifactReference: 'd'.repeat(64),
            artifactSha256: 'd'.repeat(64),
          })
        }
        throw error
      }
    },
  }
}

describe('ProjectStore Project Context lifecycle', () => {
  it('creates a Project Context and answers its durable identity', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    const created = await store.createProjectContext('  Ellekilde, TAK 1356  ')

    assert.equal(created.name, 'Ellekilde, TAK 1356')
    assert.equal(database.tables.ProjectContext.length, 4)
    assert.equal(
      database.tables.ProjectContext.at(-1)?.id,
      created.projectContextId,
    )
    assert.ok(created.createdAt instanceof Date)
  })

  it('persists no blank, untrimmed, or oversized name from any caller', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)
    const invalid = ['', '   ', '\n\t', 'x'.repeat(513)]

    for (const name of invalid) {
      await assert.rejects(store.createProjectContext(name), /1 to 512/)
      await assert.rejects(
        store.renameProjectContext(PROJECT, name),
        /1 to 512/,
      )
    }
    assert.equal(database.tables.ProjectContext.length, 3)
    assert.equal(database.tables.ProjectContext[0].name, 'Ellekilde, TAK 1355')
    // The boundary itself is accepted, trimmed.
    assert.equal(
      (await store.createProjectContext(` ${'x'.repeat(512)} `)).name.length,
      512,
    )
  })

  it('renames only the named Project Context and refuses an unknown one', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    const renamed = await store.renameProjectContext(PROJECT, ' Ellekilde II ')

    assert.deepEqual(renamed, {
      projectContextId: PROJECT,
      name: 'Ellekilde II',
      createdAt: new Date('2026-08-01T11:00:00Z'),
    })
    assert.equal(database.tables.ProjectContext[1].name, 'Other')
    assert.equal(
      await store.renameProjectContext(
        '51000000-0000-4000-8000-000000000099',
        'Absent',
      ),
      null,
    )
  })

  it('deletes the Project Context and answers every package its revisions pinned', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    const candidates = await store.deleteProjectContext(PROJECT)

    // Candidates, not a verdict: the caller re-asks `isPackageReferenced`
    // immediately before it removes each one.
    assert.deepEqual(candidates, [
      { artifactReference: OWN_PACKAGE, artifactSha256: OWN_PACKAGE },
      { artifactReference: SHARED_PACKAGE, artifactSha256: SHARED_PACKAGE },
    ])
    assert.deepEqual(
      database.tables.ProjectContext.map((row) => row.id),
      [OTHER_PROJECT, EMPTY_PROJECT],
    )
  })

  it('reports whether any surviving revision pins a content-addressed package', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    assert.equal(await store.isPackageReferenced(SHARED_PACKAGE), true)
    assert.equal(await store.isPackageReferenced('f'.repeat(64)), false)

    database.tables.SourceRepresentationRevision =
      database.tables.SourceRepresentationRevision.filter(
        (row) => row.artifactReference !== OWN_PACKAGE,
      )

    assert.equal(await store.isPackageReferenced(OWN_PACKAGE), false)
  })

  it('refuses to delete an unknown Project Context', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    assert.equal(
      await store.deleteProjectContext('51000000-0000-4000-8000-000000000099'),
      null,
    )
    assert.equal(database.tables.ProjectContext.length, 3)
  })
})

describe('ProjectStore Source Document ingestion', () => {
  it('creates one Source Document and revision 1 together', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    const result = await store.ingestSourceDocument(EMPTY_PROJECT, ingestion())

    assert.equal(result?.name, 'Ellekilde.pdf')
    assert.equal(result?.revisionNumber, 1)
    assert.equal(database.tables.SourceDocument.length, 3)
    assert.equal(database.tables.SourceRepresentationRevision.length, 4)
    assert.deepEqual(database.tables.SourceDocument.at(-1), {
      projectContextId: EMPTY_PROJECT,
      ingestionKey: '51000000-0000-4000-9000-000000000001',
      contentSha256: 'c'.repeat(64),
      mediaType: 'application/pdf',
      originalName: 'Ellekilde.pdf',
      id: result?.sourceDocumentId,
      createdAt: result?.createdAt,
    })
    assert.deepEqual(database.tables.SourceRepresentationRevision.at(-1), {
      sourceDocumentId: result?.sourceDocumentId,
      revisionNumber: 1,
      artifactReference: 'd'.repeat(64),
      artifactSha256: 'd'.repeat(64),
      contractVersion: 'parsed_document.v2',
      preprocessId: `sha256:${'e'.repeat(64)}`,
      parserName: 'docling_pdf',
      parserVersion: '2.0.0',
      id: result?.sourceRepresentationId,
      createdAt: database.tables.SourceRepresentationRevision.at(-1)?.createdAt,
    })
  })

  it('does not make a package visible when the Project Context is absent', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    assert.equal(
      await store.ingestSourceDocument(
        '51000000-0000-4000-8000-000000000099',
        ingestion(),
      ),
      null,
    )
    assert.equal(database.tables.SourceDocument.length, 2)
    assert.equal(database.tables.SourceRepresentationRevision.length, 3)

    await store.ingestSourceDocument(EMPTY_PROJECT, ingestion())
    assert.equal(
      await store.ingestSourceDocument(
        '51000000-0000-4000-8000-000000000099',
        ingestion(),
      ),
      null,
    )
  })

  it('rolls back the Source Document when its first representation fails', async () => {
    const database = fakeDatabase({ failRepresentationCreate: true })
    const store = createProjectStore(database as never)

    await assert.rejects(
      store.ingestSourceDocument(EMPTY_PROJECT, ingestion()),
      /representation write failed/,
    )
    assert.equal(database.tables.SourceDocument.length, 2)
    assert.equal(database.tables.SourceRepresentationRevision.length, 3)
  })

  it('removes only its new Source Document when post-commit retention fails', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    await assert.rejects(
      store.ingestSourceDocument(
        EMPTY_PROJECT,
        ingestion({
          ensureRetained: async () => {
            throw new Error('package unavailable')
          },
        }),
      ),
      /package unavailable/,
    )
    assert.equal(database.tables.SourceDocument.length, 2)
    // The fake intentionally does not reproduce PostgreSQL cascades; the real
    // check proves the owned representation is removed with this document.
    assert.equal(database.tables.SourceRepresentationRevision.length, 4)
  })

  it('returns the durable result when equal content is replayed with a different package', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)
    const first = await store.ingestSourceDocument(EMPTY_PROJECT, ingestion())
    let retained: unknown
    const replay = await store.ingestSourceDocument(
      EMPTY_PROJECT,
      ingestion({
        artifactReference: 'f'.repeat(64),
        artifactSha256: 'f'.repeat(64),
        ensureRetained: async (descriptor: unknown) => {
          retained = descriptor
        },
      }),
    )

    assert.deepEqual(replay, first)
    assert.deepEqual(retained, {
      artifactReference: 'd'.repeat(64),
      artifactSha256: 'd'.repeat(64),
    })
    assert.equal(database.tables.SourceDocument.length, 3)
    assert.equal(database.tables.SourceRepresentationRevision.length, 4)
  })

  it('returns and reasserts a concurrent unique-key winner', async () => {
    const racedDatabase = fakeDatabase({ raceOnIngestion: true })
    const race = createProjectStore(racedDatabase as never)
    let retained: unknown
    const winner = await race.ingestSourceDocument(
      EMPTY_PROJECT,
      ingestion({
        artifactReference: 'f'.repeat(64),
        artifactSha256: 'f'.repeat(64),
        ensureRetained: async (descriptor: unknown) => {
          retained = descriptor
        },
      }),
    )
    assert.equal(
      winner?.sourceDocumentId,
      '51000000-0000-4000-8001-000000000099',
    )
    assert.equal(
      winner?.sourceRepresentationId,
      '51000000-0000-4000-8002-000000000099',
    )
    assert.deepEqual(retained, {
      artifactReference: 'd'.repeat(64),
      artifactSha256: 'd'.repeat(64),
    })
    assert.equal(racedDatabase.tables.SourceDocument.length, 3)
    assert.equal(racedDatabase.tables.SourceRepresentationRevision.length, 4)
  })

  it('makes distinct Source Documents for distinct keys, even with the same bytes', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)
    const first = await store.ingestSourceDocument(EMPTY_PROJECT, ingestion())
    const second = await store.ingestSourceDocument(
      EMPTY_PROJECT,
      ingestion({ ingestionKey: '51000000-0000-4000-9000-000000000002' }),
    )

    assert.notEqual(first?.sourceDocumentId, second?.sourceDocumentId)
    assert.equal(database.tables.SourceDocument.length, 4)
    assert.equal(database.tables.SourceRepresentationRevision.length, 5)
  })

  it("does not disclose another Project Context's ingestion key", async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)
    await store.ingestSourceDocument(PROJECT, ingestion())

    await assert.rejects(
      store.ingestSourceDocument(EMPTY_PROJECT, ingestion()),
      /already belongs to another Source Document/,
    )
  })

  it('rejects one ingestion key reused for different content', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)
    await store.ingestSourceDocument(EMPTY_PROJECT, ingestion())

    await assert.rejects(
      store.ingestSourceDocument(
        EMPTY_PROJECT,
        ingestion({
          contentSha256: 'f'.repeat(64),
          artifactReference: 'f'.repeat(64),
          artifactSha256: 'f'.repeat(64),
        }),
      ),
      /already belongs to another Source Document/,
    )
  })
})

describe('ProjectStore Schema Revisions', () => {
  it('lists project-owned Extraction Schemas with their Current Schema Revision', async () => {
    const store = createProjectStore(fakeDatabase() as never)

    assert.deepEqual(await store.listExtractionSchemas(PROJECT, 20), [
      {
        extractionSchemaId: SCHEMA,
        name: 'Places',
        createdAt: new Date('2026-08-01T11:10:00Z'),
        currentRevision: {
          schemaRevisionId: REVISION_1,
          revisionNumber: 1,
          origin: 'suggestion',
          createdAt: new Date('2026-08-01T12:00:00Z'),
        },
      },
    ])
    assert.equal(
      await store.listExtractionSchemas(
        '51000000-0000-4000-8000-000000000099',
        20,
      ),
      null,
    )
  })

  it('deletes only an owned Source Document and answers its package candidates', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    assert.deepEqual(await store.deleteSourceDocument(PROJECT, DOCUMENT), [
      { artifactReference: OWN_PACKAGE, artifactSha256: OWN_PACKAGE },
      { artifactReference: SHARED_PACKAGE, artifactSha256: SHARED_PACKAGE },
    ])
    assert.deepEqual(
      database.tables.SourceDocument.map((row) => row.id),
      [OTHER_DOCUMENT],
    )
    assert.equal(
      await store.deleteSourceDocument(PROJECT, OTHER_DOCUMENT),
      null,
    )
  })

  it('creates the shared Extraction Schema and its initial suggestion revision atomically', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    const result = await store.initializeSchemaRevision(
      EMPTY_PROJECT,
      nodes('site'),
    )

    assert.equal(result?.status, 'created')
    assert.deepEqual(result?.revision, {
      schemaRevisionId: '51000000-0000-4000-8004-000000000002',
      extractionSchemaId: result?.revision.extractionSchemaId,
      revisionNumber: 1,
      origin: 'suggestion',
      schemaTree: nodes('site'),
      createdAt: new Date('2026-08-01T12:01:00Z'),
    })
    assert.equal(
      database.tables.ExtractionSchema.at(-1)?.id,
      result?.revision.extractionSchemaId,
    )
    assert.equal(database.tables.ExtractionSchema.length, 3)
    assert.equal(database.tables.SchemaRevision.length, 2)
  })

  it('appends one immutable researcher revision and returns its durable identity', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    const result = await store.appendSchemaRevision(
      PROJECT,
      SCHEMA,
      1,
      nodes('year'),
    )

    assert.equal(result?.status, 'created')
    assert.deepEqual(result?.revision, {
      schemaRevisionId: '51000000-0000-4000-8004-000000000002',
      extractionSchemaId: SCHEMA,
      revisionNumber: 2,
      origin: 'researcher-edit',
      schemaTree: nodes('year'),
      createdAt: new Date('2026-08-01T12:01:00Z'),
    })
    assert.equal(database.tables.SchemaRevision.length, 2)
  })

  it('rejects a stale expected revision without writing', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    const result = await store.appendSchemaRevision(
      PROJECT,
      SCHEMA,
      0,
      nodes('stale'),
    )

    assert.deepEqual(result, {
      status: 'conflict',
      currentRevision: {
        schemaRevisionId: REVISION_1,
        extractionSchemaId: SCHEMA,
        revisionNumber: 1,
        origin: 'suggestion',
        schemaTree: nodes('site'),
        createdAt: new Date('2026-08-01T12:00:00Z'),
      },
    })
    assert.equal(database.tables.SchemaRevision.length, 1)
  })

  it('maps a concurrent unique race to the winning head with no partial write', async () => {
    const database = fakeDatabase({ raceOnCreate: true })
    const store = createProjectStore(database as never)

    const result = await store.appendSchemaRevision(
      PROJECT,
      SCHEMA,
      1,
      nodes('mine'),
    )

    assert.equal(result?.status, 'conflict')
    assert.equal(result?.currentRevision.revisionNumber, 2)
    assert.deepEqual(result?.currentRevision.schemaTree, nodes('rival'))
    assert.equal(database.tables.SchemaRevision.length, 2)
  })

  it('gets exact revisions and lists a deterministic bounded owner-scoped window', async () => {
    const database = fakeDatabase()
    database.tables.SchemaRevision.push(
      {
        id: '51000000-0000-4000-8004-000000000002',
        extractionSchemaId: SCHEMA,
        revisionNumber: 2,
        origin: 'RESEARCHER_EDIT',
        schemaTree: nodes('year'),
        createdAt: new Date('2026-08-01T12:01:00Z'),
      },
      {
        id: '51000000-0000-4000-8004-000000000003',
        extractionSchemaId: SCHEMA,
        revisionNumber: 3,
        origin: 'MODEL_EDIT',
        schemaTree: nodes('place'),
        createdAt: new Date('2026-08-01T12:02:00Z'),
      },
    )
    const store = createProjectStore(database as never)

    assert.deepEqual(
      (await store.listSchemaRevisions(PROJECT, SCHEMA, 2))?.map(
        (revision) => revision.revisionNumber,
      ),
      [3, 2],
    )
    assert.equal(
      (await store.getSchemaRevision(PROJECT, SCHEMA, REVISION_1))
        ?.revisionNumber,
      1,
    )
    assert.equal(
      await store.listSchemaRevisions(OTHER_PROJECT, SCHEMA, 2),
      null,
    )
    assert.equal(
      await store.getSchemaRevision(OTHER_PROJECT, SCHEMA, REVISION_1),
      null,
    )
  })
})

describe('ProjectStore batch schema suggestions', () => {
  it('orders equal-time attempts and fences stale workers while recovering a lease', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)
    const schemaCount = database.tables.ExtractionSchema.length
    const revisionCount = database.tables.SchemaRevision.length
    const claimedAt = new Date('2026-08-15T10:00:00Z')
    const claims = await Promise.all([
      store.beginSourceSchemaSuggestion(PROJECT, DOCUMENT, claimedAt),
      store.beginSourceSchemaSuggestion(PROJECT, DOCUMENT, claimedAt),
    ])
    const owner = claims.find((claim) => claim?.status === 'work')

    assert.equal(claims.filter((claim) => claim?.status === 'work').length, 1)
    assert.equal(
      claims.filter((claim) => claim?.status === 'pending').length,
      1,
    )
    if (!owner || owner.status !== 'work')
      throw new Error('Expected one lease owner.')
    const ownedAttempt = database.tables.SchemaSuggestion.find(
      (attempt) => attempt.id === owner.schemaSuggestionId,
    )
    assert.equal(ownedAttempt?.projectContextId, PROJECT)
    assert.equal(ownedAttempt?.sourceDocumentId, DOCUMENT)
    assert.equal(ownedAttempt?.extractionSchemaId, undefined)
    assert.equal(ownedAttempt?.outcome, 'RUNNING')
    assert.ok(ownedAttempt?.leaseExpiresAt instanceof Date)

    await store.failSourceSchemaSuggestion(owner.schemaSuggestionId, {
      code: 'model_operation_failed',
    })
    assert.deepEqual(ownedAttempt?.failure, {
      state: 'failed',
      code: 'model_operation_failed',
    })
    const retry = await store.beginSourceSchemaSuggestion(
      PROJECT,
      DOCUMENT,
      claimedAt,
    )
    assert.equal(retry?.status, 'work')
    assert.notEqual(
      retry?.status === 'work' ? retry.schemaSuggestionId : null,
      owner.schemaSuggestionId,
    )
    assert.equal(
      (await store.beginSourceSchemaSuggestion(PROJECT, DOCUMENT, claimedAt))
        ?.status,
      'pending',
    )
    assert.deepEqual(
      database.tables.SchemaSuggestion.map((attempt) => [
        (attempt.createdAt as Date).toISOString(),
        (attempt.modelAttribution as { attemptOrdinal: number }).attemptOrdinal,
        attempt.outcome,
      ]),
      [
        [claimedAt.toISOString(), 1, 'FAILED'],
        [claimedAt.toISOString(), 2, 'RUNNING'],
      ],
    )

    const recovered = await store.beginSourceSchemaSuggestion(
      PROJECT,
      DOCUMENT,
      new Date('2026-08-15T10:03:00Z'),
    )
    assert.equal(recovered?.status, 'work')
    assert.notEqual(
      recovered?.status === 'work' ? recovered.schemaSuggestionId : null,
      retry?.status === 'work' ? retry.schemaSuggestionId : null,
    )
    if (recovered?.status !== 'work')
      throw new Error('Expected recovered lease owner.')
    if (retry?.status !== 'work') throw new Error('Expected expired owner.')
    await store.completeSourceSchemaSuggestion(
      retry.schemaSuggestionId,
      { _description: 'Stale record.', stale: 'string' },
      '{"stale":"string"}',
    )
    const staleAttempt = database.tables.SchemaSuggestion.find(
      (attempt) => attempt.id === retry.schemaSuggestionId,
    )
    assert.equal(staleAttempt?.outcome, 'CANCELLED')
    assert.equal(staleAttempt?.failure, null)
    assert.equal(staleAttempt?.leaseExpiresAt, null)
    assert.equal(staleAttempt?.proposedTree, undefined)
    assert.equal(
      (
        await store.beginSourceSchemaSuggestion(
          PROJECT,
          DOCUMENT,
          new Date('2026-08-15T10:04:00Z'),
        )
      )?.status,
      'pending',
    )
    await store.completeSourceSchemaSuggestion(
      recovered.schemaSuggestionId,
      { _description: 'One record.', place: 'string' },
      '{"place":"string"}',
    )
    await store.failSourceSchemaSuggestion(retry.schemaSuggestionId, {
      code: 'unexpected_failure',
    })
    assert.equal(
      database.tables.SchemaSuggestion.find(
        (attempt) => attempt.id === retry.schemaSuggestionId,
      )?.failure,
      null,
    )
    const completedAttempt = database.tables.SchemaSuggestion.find(
      (attempt) => attempt.id === recovered.schemaSuggestionId,
    )
    assert.equal(completedAttempt?.outcome, 'SUCCEEDED')
    assert.equal(completedAttempt?.leaseExpiresAt, null)
    assert.deepEqual(
      await store.beginSourceSchemaSuggestion(PROJECT, DOCUMENT),
      {
        status: 'ready',
        template: { _description: 'One record.', place: 'string' },
      },
    )
    assert.equal(database.tables.ExtractionSchema.length, schemaCount)
    assert.equal(database.tables.SchemaRevision.length, revisionCount)
  })

  it('restores an exact confirmed definition after its deterministic schema head diverges', async () => {
    const store = createProjectStore(fakeDatabase() as never)
    const selection = await store.getBatchSchemaSuggestionInputs(PROJECT, [
      DOCUMENT,
    ])
    assert.ok(selection)
    const definition = {
      recordDescription: 'One place.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    }
    const initial = await store.confirmBatchSchemaSuggestion(
      PROJECT,
      [DOCUMENT],
      selection.selectionKey,
      definition,
    )
    assert.equal(initial?.status, 'created')
    if (initial?.status !== 'created')
      throw new Error('Expected initial confirmation.')

    const changed = await store.appendSchemaRevision(
      PROJECT,
      initial.revision.extractionSchemaId,
      initial.revision.revisionNumber,
      {
        recordDescription: 'A changed place.',
        schemaNodes: [{ id: 'changed', name: 'country', type: 'string' }],
      },
    )
    assert.equal(changed?.status, 'created')

    const restored = await store.confirmBatchSchemaSuggestion(
      PROJECT,
      [DOCUMENT],
      selection.selectionKey,
      definition,
    )
    assert.equal(restored?.status, 'created')
    assert.deepEqual(
      restored?.status === 'created' ? restored.revision.schemaTree : null,
      definition,
    )
    assert.equal(
      restored?.status === 'created' ? restored.revision.revisionNumber : null,
      3,
    )

    const replayed = await store.confirmBatchSchemaSuggestion(
      PROJECT,
      [DOCUMENT],
      selection.selectionKey,
      {
        recordDescription: 'One place.',
        schemaNodes: [{ id: 'generated-later', name: 'place', type: 'string' }],
      },
    )
    assert.equal(replayed?.status, 'replayed')
    assert.equal(
      replayed?.status === 'replayed'
        ? replayed.revision.schemaRevisionId
        : null,
      restored?.status === 'created'
        ? restored.revision.schemaRevisionId
        : null,
    )
  })

  it('does not overwrite a different schema head that wins a concurrent confirmation', async () => {
    const store = createProjectStore(
      fakeDatabase({ raceOnCreate: true }) as never,
    )
    const selection = await store.getBatchSchemaSuggestionInputs(PROJECT, [
      DOCUMENT,
    ])
    assert.ok(selection)

    const result = await store.confirmBatchSchemaSuggestion(
      PROJECT,
      [DOCUMENT],
      selection.selectionKey,
      {
        recordDescription: 'One place.',
        schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
      },
    )

    assert.equal(result?.status, 'conflict')
    assert.deepEqual(
      result?.status === 'conflict' ? result.currentRevision.schemaTree : null,
      nodes('rival'),
    )
  })
})
