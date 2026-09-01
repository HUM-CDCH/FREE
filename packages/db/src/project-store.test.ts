import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canonicalPackageStore } from './artifact-store.js'
import {
  createInternalProjectWorkerStore,
  createResearcherProjectStore,
  type IngestSourceDocumentInput,
} from './project-store.js'

type Row = Record<string, unknown>
type Order = { field: string; direction: 'asc' | 'desc' }
type FieldReference = { table: string; field: string }
type JoinedRows = Record<string, Row>
type Predicate = (rows: JoinedRows) => boolean
type SqlFunctions = {
  eq(left: unknown, right: unknown): Predicate
  and(...predicates: Predicate[]): Predicate
}

const RESEARCHER_A = '52000000-0000-4000-8000-000000000001'
const RESEARCHER_B = '52000000-0000-4000-8000-000000000002'
const PROJECT = '51000000-0000-4000-8000-000000000001'
const OTHER_PROJECT = '51000000-0000-4000-8000-000000000002'
const EMPTY_PROJECT = '51000000-0000-4000-8000-000000000003'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const REVISION_1 = '51000000-0000-4000-8004-000000000001'
const FOREIGN_REVISION = '51000000-0000-4000-8004-000000000002'

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
    raceOnContent?: boolean
    failRepresentationCreate?: boolean
  } = {},
) {
  const tables: Record<string, Row[]> = {
    ResearcherAccount: [
      { id: RESEARCHER_A, email: 'researcher-a@example.org' },
      { id: RESEARCHER_B, email: 'researcher-b@example.org' },
    ],
    ProjectContext: [
      {
        id: PROJECT,
        researcherAccountId: RESEARCHER_A,
        name: 'Ellekilde, TAK 1355',
        createdAt: new Date('2026-08-01T11:00:00Z'),
      },
      {
        id: OTHER_PROJECT,
        researcherAccountId: RESEARCHER_B,
        name: 'Other',
        createdAt: new Date('2026-08-01T11:01:00Z'),
      },
      {
        id: EMPTY_PROJECT,
        researcherAccountId: RESEARCHER_A,
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
    let groupField: string | undefined
    const query = {
      select: () => query,
      where(filter: Row | ((fields: Row) => (row: Row) => boolean)) {
        if (typeof filter === 'function') {
          const fields = new Proxy(
            {},
            {
              get: (_target, field: string) => ({
                in: (values: readonly unknown[]) => (row: Row) =>
                  values.includes(row[field]),
              }),
            },
          ) as Row
          selected = selected.filter(filter(fields))
          return query
        }
        selected = selected.filter((row) =>
          Object.entries(filter).every(([key, value]) => row[key] === value),
        )
        return query
      },
      groupBy(field: string) {
        groupField = field
        return query
      },
      async aggregate(
        select: (aggregate: { count: () => number }) => Record<string, number>,
      ) {
        const groupedBy = groupField
        if (!groupedBy) throw new Error('aggregate requires groupBy')
        const [countName] = Object.keys(select({ count: () => 0 }))
        const counts: Record<string, number> = {}
        for (const row of selected) {
          const key = String(row[groupedBy])
          counts[key] = (counts[key] ?? 0) + 1
        }
        return Object.entries(counts).map(([key, count]) => ({
          [groupedBy]: key,
          [countName]: count,
        }))
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
        if (
          table === 'ProjectContext' &&
          !tables.ResearcherAccount.some(
            (account) => account.id === input.researcherAccountId,
          )
        )
          throw Object.assign(new Error('foreign key constraint'), {
            sqlState: '23503',
          })
        if (input.id !== undefined && rows.some((row) => row.id === input.id))
          throw Object.assign(new Error('unique constraint'), {
            sqlState: '23505',
          })
        if (
          table === 'SourceDocument' &&
          rows.some(
            (row) =>
              row.projectContextId === input.projectContextId &&
              (row.ingestionKey === input.ingestionKey ||
                row.contentSha256 === input.contentSha256),
          )
        )
          throw Object.assign(new Error('unique constraint'), {
            sqlState: '23505',
          })
        if (
          table === 'SourceDocument' &&
          (options.raceOnIngestion || options.raceOnContent) &&
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
      async delete() {
        const doomed = await query.all()
        if (table === 'ProjectContext') {
          const projectIds = new Set(doomed.map((row) => row.id))
          const documentIds = new Set(
            tables.SourceDocument.filter((document) =>
              projectIds.has(document.projectContextId),
            ).map((document) => document.id),
          )
          tables.SourceRepresentationRevision =
            tables.SourceRepresentationRevision.filter(
              (representation) =>
                !documentIds.has(representation.sourceDocumentId),
            )
          tables.SourceDocument = tables.SourceDocument.filter(
            (document) => !projectIds.has(document.projectContextId),
          )
        }
        if (table === 'SourceDocument') {
          const documentIds = new Set(doomed.map((row) => row.id))
          tables.SourceRepresentationRevision =
            tables.SourceRepresentationRevision.filter(
              (representation) =>
                !documentIds.has(representation.sourceDocumentId),
            )
        }
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
  const fieldValue = (value: unknown, rows: JoinedRows) => {
    if (
      value &&
      typeof value === 'object' &&
      'table' in value &&
      'field' in value
    ) {
      const reference = value as FieldReference
      return rows[reference.table]?.[reference.field]
    }
    return value
  }
  const fields = new Proxy(
    {},
    {
      get: (_target, table: string) =>
        new Proxy(
          {},
          {
            get: (_fields, field: string): FieldReference => ({
              table,
              field,
            }),
          },
        ),
    },
  ) as Record<string, Row>
  const functions: SqlFunctions = {
    eq: (left: unknown, right: unknown): Predicate => (rows) =>
      fieldValue(left, rows) === fieldValue(right, rows),
    and: (...predicates: Predicate[]): Predicate => (rows) =>
      predicates.every((predicate) => predicate(rows)),
  }
  const sqlQuery = (baseTable: string) => {
    const tableRows = (table: string) =>
      tables[`${table[0]?.toUpperCase()}${table.slice(1)}`] ?? []
    const joins: Array<{ table: string; predicate: Predicate }> = []
    let predicate: Predicate = () => true
    let projection: (rows: JoinedRows) => Record<string, unknown> = () => ({})
    const query = {
      innerJoin(
        joined: { table: string },
        condition: (
          fields: Record<string, Row>,
          functions: SqlFunctions,
        ) => Predicate,
      ) {
        joins.push({ table: joined.table, predicate: condition(fields, functions) })
        return query
      },
      select(
        select: (fields: Record<string, Row>) => Record<string, unknown>,
      ) {
        const selected = select(fields)
        projection = (rows) =>
          Object.fromEntries(
            Object.entries(selected).map(([key, value]) => [
              key,
              fieldValue(value, rows),
            ]),
          )
        return query
      },
      where(
        condition: (
          fields: Record<string, Row>,
          functions: SqlFunctions,
        ) => Predicate,
      ) {
        predicate = condition(fields, functions)
        return query
      },
      build() {
        let joinedRows = tableRows(baseTable).map((row) => ({
          [baseTable]: row,
        }))
        for (const join of joins)
          joinedRows = joinedRows.flatMap((rows) =>
            tableRows(join.table)
              .map((row) => ({ ...rows, [join.table]: row }))
              .filter(join.predicate),
          )
        return joinedRows.filter(predicate).map(projection)
      },
    }
    return query
  }
  const sql = {
    public: new Proxy(
      {},
      {
        get: (_target, table: string) => ({
          table,
          innerJoin: sqlQuery(table).innerJoin,
        }),
      },
    ),
  }
  const execute = (rows: Record<string, unknown>[]) => ({
    async first() {
      return rows[0] ?? null
    },
  })
  return {
    tables,
    orm,
    transaction: async <T>(
      run: (tx: {
        orm: typeof orm
        sql: typeof sql
        execute: typeof execute
      }) => Promise<T>,
    ) => {
      const snapshot = Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [
          name,
          rows.map((row) => ({ ...row })),
        ]),
      )
      try {
        return await run({ orm, sql, execute })
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
            ...(options.raceOnContent
              ? { ingestionKey: '51000000-0000-4000-9000-000000000099' }
              : {}),
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

describe('ResearcherProjectStore Project Context lifecycle', () => {
  it('creates a Project Context and answers its durable identity', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

    const created = await store.createProjectContext('  Ellekilde, TAK 1356  ')

    assert.equal(created.name, 'Ellekilde, TAK 1356')
    assert.equal(database.tables.ProjectContext.length, 4)
    assert.equal(
      database.tables.ProjectContext.at(-1)?.id,
      created.projectContextId,
    )
    assert.equal(
      database.tables.ProjectContext.at(-1)?.researcherAccountId,
      RESEARCHER_A,
    )
    assert.ok(created.createdAt instanceof Date)
  })

  it('keeps request and worker capabilities separate at runtime', () => {
    const database = fakeDatabase()
    const researcher = createResearcherProjectStore(
      RESEARCHER_A,
      database as never,
    )
    const worker = createInternalProjectWorkerStore(database as never)

    assert.equal(researcher.researcherAccountId, RESEARCHER_A)
    assert.equal('isPackageReferenced' in researcher, false)
    assert.equal('claimBatchSchemaSuggestion' in researcher, false)
    assert.equal('createProjectContext' in worker, false)
    assert.equal('getSourceRepresentation' in worker, false)
  })

  it('rejects Project Context creation for a nonexistent account owner', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(
      '52000000-0000-4000-8000-000000000099',
      database as never,
    )

    await assert.rejects(
      store.createProjectContext('Unowned research'),
      /foreign key constraint/,
    )
    assert.equal(database.tables.ProjectContext.length, 3)
  })

  it('persists no blank, untrimmed, or oversized name from any caller', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
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
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

    const renamed = await store.renameProjectContext(PROJECT, ' Ellekilde II ')

    assert.deepEqual(renamed, {
      projectContextId: PROJECT,
      name: 'Ellekilde II',
      createdAt: new Date('2026-08-01T11:00:00Z'),
    })
    assert.equal(database.tables.ProjectContext[1].name, 'Other')
    assert.equal(
      await store.renameProjectContext(OTHER_PROJECT, 'Foreign rename'),
      null,
    )
    assert.equal(
      await store.renameProjectContext(
        '51000000-0000-4000-8000-000000000099',
        'Absent',
      ),
      null,
    )
  })

  it('summarizes an empty Project Context as ingest with creation as activity', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

    const empty = (await store.listProjectContexts(20)).find(
      (item) => item.projectContextId === EMPTY_PROJECT,
    )

    assert.deepEqual(empty?.summary, {
      phase: 'ingest',
      extractionCount: 0,
      extractedSourceDocumentCount: 0,
      reviewedSourceDocumentCount: 0,
      staleSourceDocumentCount: 0,
      schemaDraftCount: 0,
      lastActivityAt: new Date('2026-08-01T11:02:00Z'),
      runningBatch: null,
    })
  })

  it('moves the phase from chat to approve on a ready suggestion, counting drafts', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
    // No approved Schema Revision yet: the researcher is still in chat.
    database.tables.SchemaRevision = []

    const chatting = await store.listProjectContexts(20)
    const chattingSummary = chatting.find(
      (item) => item.projectContextId === PROJECT,
    )?.summary
    assert.equal(chattingSummary?.phase, 'chat')
    assert.equal(chattingSummary?.schemaDraftCount, 0)

    database.tables.BatchSchemaSuggestion = [
      {
        id: '51000000-0000-4000-8005-000000000001',
        projectContextId: PROJECT,
        phase: 'READY',
        confirmedSchemaRevisionId: null,
        createdAt: new Date('2026-08-02T09:00:00Z'),
      },
    ]
    const ready = await store.listProjectContexts(20)
    const readySummary = ready.find(
      (item) => item.projectContextId === PROJECT,
    )?.summary
    assert.equal(readySummary?.phase, 'approve')
    assert.equal(readySummary?.schemaDraftCount, 1)
    assert.deepEqual(readySummary?.lastActivityAt, new Date('2026-08-02T09:00:00Z'))

    // A confirmed suggestion is no longer a draft and no longer gates approve.
    database.tables.BatchSchemaSuggestion[0].confirmedSchemaRevisionId = REVISION_1
    const confirmed = await store.listProjectContexts(20)
    const confirmedSummary = confirmed.find(
      (item) => item.projectContextId === PROJECT,
    )?.summary
    assert.equal(confirmedSummary?.phase, 'chat')
    assert.equal(confirmedSummary?.schemaDraftCount, 0)
  })

  it('summarizes extraction, review, and staleness from the latest Extraction', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
    const representations = database.tables.SourceRepresentationRevision
    // The fixture document's two representations become revisions 1 and 2.
    representations[0].revisionNumber = 1
    representations[1].revisionNumber = 2
    const currentRepresentation = representations[1].id as string

    // An approved Schema Revision with no Extraction yet: extract phase.
    const before = await store.listProjectContexts(20)
    assert.equal(
      before.find((item) => item.projectContextId === PROJECT)?.summary.phase,
      'extract',
    )

    database.tables.Extraction = [
      {
        id: '51000000-0000-4000-8006-000000000001',
        sourceDocumentId: DOCUMENT,
        sourceRepresentationRevisionId: currentRepresentation,
        createdAt: new Date('2026-08-03T10:00:00Z'),
        reviewedAt: null,
      },
    ]
    const extracted = await store.listProjectContexts(20)
    const extractedSummary = extracted.find(
      (item) => item.projectContextId === PROJECT,
    )?.summary
    assert.equal(extractedSummary?.phase, 'extract')
    assert.equal(extractedSummary?.extractionCount, 1)
    assert.equal(extractedSummary?.extractedSourceDocumentCount, 1)
    assert.equal(extractedSummary?.reviewedSourceDocumentCount, 0)
    assert.equal(extractedSummary?.staleSourceDocumentCount, 0)
    assert.deepEqual(
      extractedSummary?.lastActivityAt,
      new Date('2026-08-03T10:00:00Z'),
    )

    // Review moves the phase to validate and review activity forward.
    database.tables.Extraction[0].reviewedAt = new Date('2026-08-04T10:00:00Z')
    const reviewed = await store.listProjectContexts(20)
    const reviewedSummary = reviewed.find(
      (item) => item.projectContextId === PROJECT,
    )?.summary
    assert.equal(reviewedSummary?.phase, 'validate')
    assert.equal(reviewedSummary?.reviewedSourceDocumentCount, 1)
    assert.deepEqual(
      reviewedSummary?.lastActivityAt,
      new Date('2026-08-04T10:00:00Z'),
    )

    // A newer current representation than the latest Extraction's pin is
    // exactly what makes the Source Document stale.
    representations.push({
      id: '51000000-0000-4000-8002-000000000009',
      sourceDocumentId: DOCUMENT,
      revisionNumber: 3,
      artifactReference: 'f'.repeat(64),
      artifactSha256: 'f'.repeat(64),
    })
    const stale = await store.listProjectContexts(20)
    assert.equal(
      stale.find((item) => item.projectContextId === PROJECT)?.summary
        .staleSourceDocumentCount,
      1,
    )
  })

  it('reports the open Batch Extraction with persisted member progress', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
    const batchId = '51000000-0000-4000-8007-000000000001'
    database.tables.BatchExtraction = [
      {
        id: batchId,
        projectContextId: PROJECT,
        createdAt: new Date('2026-08-05T08:00:00Z'),
      },
    ]
    database.tables.BatchExtractionMember = [
      { batchExtractionId: batchId, initialExtractionJobId: 'job-1' },
      { batchExtractionId: batchId, initialExtractionJobId: 'job-2' },
      { batchExtractionId: batchId, initialExtractionJobId: 'job-3' },
    ]
    database.tables.ExtractionJob = [
      { id: 'job-1', executionStatus: 'COMPLETED' },
      { id: 'job-2', executionStatus: 'FAILED' },
      { id: 'job-3', executionStatus: 'RUNNING' },
    ]

    const running = await store.listProjectContexts(20)
    assert.deepEqual(
      running.find((item) => item.projectContextId === PROJECT)?.summary
        .runningBatch,
      { completedMemberCount: 2, memberCount: 3 },
    )

    // A finished batch stops reporting progress but remains activity.
    database.tables.ExtractionJob[2].executionStatus = 'COMPLETED'
    const finished = await store.listProjectContexts(20)
    const finishedSummary = finished.find(
      (item) => item.projectContextId === PROJECT,
    )?.summary
    assert.equal(finishedSummary?.runningBatch, null)
    assert.deepEqual(
      finishedSummary?.lastActivityAt,
      new Date('2026-08-05T08:00:00Z'),
    )
  })

  it('lists persisted activity newest first, bounded, across owned projects only', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
    database.tables.Extraction = [
      {
        id: '51000000-0000-4000-8006-000000000001',
        sourceDocumentId: DOCUMENT,
        createdAt: new Date('2026-08-03T10:00:00Z'),
        reviewedAt: new Date('2026-08-05T10:00:00Z'),
      },
      // A foreign researcher's Extraction never surfaces.
      {
        id: '51000000-0000-4000-8006-000000000002',
        sourceDocumentId: OTHER_DOCUMENT,
        createdAt: new Date('2026-08-06T10:00:00Z'),
        reviewedAt: null,
      },
    ]
    database.tables.BatchExtraction = [
      {
        id: '51000000-0000-4000-8007-000000000001',
        projectContextId: PROJECT,
        executionStatus: 'COMPLETED',
        createdAt: new Date('2026-08-04T10:00:00Z'),
      },
    ]

    const events = await store.listRecentActivity(3)

    // SchemaRevision fixture (2026-08-01T12:00) is oldest and bounded away.
    assert.deepEqual(
      events.map(({ kind, occurredAt }) => ({ kind, occurredAt })),
      [
        {
          kind: 'review_decisions_stored',
          occurredAt: new Date('2026-08-05T10:00:00Z'),
        },
        {
          kind: 'batch_extraction_opened',
          occurredAt: new Date('2026-08-04T10:00:00Z'),
        },
        {
          kind: 'extraction_appended',
          occurredAt: new Date('2026-08-03T10:00:00Z'),
        },
      ],
    )
    assert.ok(
      events.every(
        (event) =>
          event.projectContextId === PROJECT &&
          event.projectContextName === 'Ellekilde, TAK 1355',
      ),
    )
    // The Schema Revision event surfaces once the bound allows it.
    assert.equal(
      (await store.listRecentActivity(10)).at(-1)?.kind,
      'schema_revision_appended',
    )
  })

  it('scopes project, document, and representation reads to one account', async () => {
    const database = fakeDatabase()
    const storeA = createResearcherProjectStore(RESEARCHER_A, database as never)
    const storeB = createResearcherProjectStore(RESEARCHER_B, database as never)
    const ownRepresentation = '51000000-0000-4000-8002-000000000001'
    const foreignRepresentation = '51000000-0000-4000-8002-000000000003'

    assert.deepEqual(
      (await storeA.listProjectContexts(20)).map(
        ({ projectContextId, sourceDocumentCount }) => ({
          projectContextId,
          sourceDocumentCount,
        }),
      ),
      [
        { projectContextId: EMPTY_PROJECT, sourceDocumentCount: 0 },
        { projectContextId: PROJECT, sourceDocumentCount: 1 },
      ],
    )
    assert.equal(
      await storeA.getProjectContextWithDocuments(OTHER_PROJECT),
      null,
    )
    assert.equal(
      await storeA.getDocumentReopenSnapshot(OTHER_PROJECT, OTHER_DOCUMENT),
      null,
    )
    database.tables.SchemaRevision.push({
      id: FOREIGN_REVISION,
      extractionSchemaId: '51000000-0000-4000-8003-000000000002',
      revisionNumber: 1,
      origin: 'RESEARCHER_EDIT',
      schemaTree: nodes('foreign-secret'),
      createdAt: new Date('2026-08-01T12:00:00Z'),
    })
    const foreignPinnedSchema = await storeA.getDocumentReopenSnapshot(
      PROJECT,
      DOCUMENT,
      {
        sourceRepresentationRevisionId: ownRepresentation,
        schemaRevisionId: FOREIGN_REVISION,
      },
    )
    assert.equal(
      foreignPinnedSchema?.extractionSchema?.extractionSchemaId,
      SCHEMA,
    )
    assert.notDeepEqual(
      foreignPinnedSchema?.extractionSchema?.schemaTree,
      nodes('foreign-secret'),
    )
    assert.deepEqual(
      await storeA.getSourceRepresentation(PROJECT, ownRepresentation),
      { artifactReference: OWN_PACKAGE, artifactSha256: OWN_PACKAGE },
    )
    assert.equal(
      await storeA.getSourceRepresentation(PROJECT, foreignRepresentation),
      null,
    )
    assert.deepEqual(
      await storeB.getSourceRepresentation(
        OTHER_PROJECT,
        foreignRepresentation,
      ),
      { artifactReference: SHARED_PACKAGE, artifactSha256: SHARED_PACKAGE },
    )
  })

  it('deletes only owned research and removes packages only after their final reference', async () => {
    const database = fakeDatabase()
    const storeA = createResearcherProjectStore(RESEARCHER_A, database as never)
    const storeB = createResearcherProjectStore(RESEARCHER_B, database as never)
    const removed: string[] = []
    const originalRemove = canonicalPackageStore.remove
    canonicalPackageStore.remove = async (descriptor, isReferenced) => {
      if (await isReferenced()) return false
      removed.push(descriptor.artifactReference)
      return true
    }

    try {
      assert.equal(await storeA.deleteProjectContext(OTHER_PROJECT), false)
      assert.equal(await storeA.deleteProjectContext(PROJECT), true)
      assert.deepEqual(removed, [OWN_PACKAGE])
      assert.deepEqual(
        database.tables.ProjectContext.map((row) => row.id),
        [OTHER_PROJECT, EMPTY_PROJECT],
      )

      assert.equal(await storeB.deleteProjectContext(OTHER_PROJECT), true)
      assert.deepEqual(removed, [OWN_PACKAGE, SHARED_PACKAGE])
    } finally {
      canonicalPackageStore.remove = originalRemove
    }
  })

  it('reports whether any surviving revision pins a content-addressed package', async () => {
    const database = fakeDatabase()
    const store = createInternalProjectWorkerStore(database as never)

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
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

    assert.equal(
      await store.deleteProjectContext('51000000-0000-4000-8000-000000000099'),
      false,
    )
    assert.equal(database.tables.ProjectContext.length, 3)
  })
})

describe('ResearcherProjectStore Source Document ingestion', () => {
  it('creates one Source Document and revision 1 together', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

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

  it('does not make a package visible through a missing or foreign Project Context', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

    assert.equal(
      await store.ingestSourceDocument(
        OTHER_PROJECT,
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
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

    await assert.rejects(
      store.ingestSourceDocument(EMPTY_PROJECT, ingestion()),
      /representation write failed/,
    )
    assert.equal(database.tables.SourceDocument.length, 2)
    assert.equal(database.tables.SourceRepresentationRevision.length, 3)
  })

  it('removes only its new Source Document when post-commit retention fails', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

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
    assert.equal(database.tables.SourceRepresentationRevision.length, 3)
  })

  it('returns the durable result when equal content is replayed with a different package', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
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
    const race = createResearcherProjectStore(RESEARCHER_A, racedDatabase as never)
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

  it('returns the first durable identity and name for equal bytes under distinct keys and names', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
    const first = await store.ingestSourceDocument(EMPTY_PROJECT, ingestion())
    const second = await store.ingestSourceDocument(
      EMPTY_PROJECT,
      ingestion({
        ingestionKey: '51000000-0000-4000-9000-000000000002',
        originalName: 'renamed.pdf',
      }),
    )

    assert.deepEqual(second, first)
    assert.equal(second?.name, 'Ellekilde.pdf')
    assert.equal(database.tables.SourceDocument.length, 3)
    assert.equal(database.tables.SourceRepresentationRevision.length, 4)
  })

  it('returns a concurrent same-content winner created under a different key', async () => {
    const database = fakeDatabase({ raceOnContent: true })
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
    const winner = await store.ingestSourceDocument(EMPTY_PROJECT, ingestion())

    assert.equal(
      winner?.sourceDocumentId,
      '51000000-0000-4000-8001-000000000099',
    )
    assert.equal(database.tables.SourceDocument.length, 3)
    assert.equal(database.tables.SourceRepresentationRevision.length, 4)
  })

  it('creates distinct documents for the same filename with different bytes', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
    const first = await store.ingestSourceDocument(EMPTY_PROJECT, ingestion())
    const second = await store.ingestSourceDocument(
      EMPTY_PROJECT,
      ingestion({
        ingestionKey: '51000000-0000-4000-9000-000000000002',
        contentSha256: 'f'.repeat(64),
      }),
    )

    assert.notEqual(second?.sourceDocumentId, first?.sourceDocumentId)
    assert.equal(second?.name, first?.name)
    assert.equal(database.tables.SourceDocument.length, 4)
  })

  it('scopes identical ingestion keys to each account-owned Project Context', async () => {
    const database = fakeDatabase()
    const storeA = createResearcherProjectStore(RESEARCHER_A, database as never)
    const storeB = createResearcherProjectStore(RESEARCHER_B, database as never)
    const first = await storeA.ingestSourceDocument(PROJECT, ingestion())
    const second = await storeB.ingestSourceDocument(
      OTHER_PROJECT,
      ingestion({
        artifactReference: 'e'.repeat(64),
        artifactSha256: 'e'.repeat(64),
      }),
    )

    assert.notEqual(first?.sourceDocumentId, second?.sourceDocumentId)
    assert.deepEqual(
      database.tables.SourceDocument.filter(
        (row) =>
          row.ingestionKey === '51000000-0000-4000-9000-000000000001',
      ).map((row) => row.projectContextId),
      [PROJECT, OTHER_PROJECT],
    )
    assert.equal(
      await storeA.getSourceRepresentation(
        PROJECT,
        second?.sourceRepresentationId ?? '',
      ),
      null,
    )
    assert.deepEqual(
      await storeB.getSourceRepresentation(
        OTHER_PROJECT,
        second?.sourceRepresentationId ?? '',
      ),
      {
        artifactReference: 'e'.repeat(64),
        artifactSha256: 'e'.repeat(64),
      },
    )
  })

  it('rejects one ingestion key reused for different content', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)
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
describe('ResearcherProjectStore Schema Revisions', () => {
  it('lists project-owned Extraction Schemas with their Current Schema Revision', async () => {
    const store = createResearcherProjectStore(
      RESEARCHER_A,
      fakeDatabase() as never,
    )

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
      await store.listExtractionSchemas(OTHER_PROJECT, 20),
      null,
    )
  })

  it('renames only a project-owned Extraction Schema with a durable bounded name', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

    assert.deepEqual(
      await store.renameExtractionSchema(PROJECT, SCHEMA, '  Historic places  '),
      {
        extractionSchemaId: SCHEMA,
        name: 'Historic places',
        createdAt: new Date('2026-08-01T11:10:00Z'),
      },
    )
    assert.equal(database.tables.ExtractionSchema[1].name, 'Other schema')
    assert.equal(
      await store.renameExtractionSchema(OTHER_PROJECT, SCHEMA, 'Not owned'),
      null,
    )
    await assert.rejects(
      store.renameExtractionSchema(PROJECT, SCHEMA, '   '),
      /1 to 512/,
    )
    assert.equal(database.tables.ExtractionSchema[0].name, 'Historic places')
  })

  it('deletes only an owned Source Document without exposing package metadata', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

    assert.equal(await store.deleteSourceDocument(PROJECT, DOCUMENT), true)
    assert.deepEqual(
      database.tables.SourceDocument.map((row) => row.id),
      [OTHER_DOCUMENT],
    )
    assert.equal(
      await store.deleteSourceDocument(PROJECT, OTHER_DOCUMENT),
      false,
    )
  })

  it('creates the shared Extraction Schema and its initial suggestion revision atomically', async () => {
    const database = fakeDatabase()
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

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
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

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
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

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
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

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
    const store = createResearcherProjectStore(RESEARCHER_A, database as never)

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

