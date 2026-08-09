import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createProjectStore } from './project-store.js'

type Row = Record<string, unknown>
type Order = { field: string; direction: 'asc' | 'desc' }

const PROJECT = '51000000-0000-4000-8000-000000000001'
const OTHER_PROJECT = '51000000-0000-4000-8000-000000000002'
const EMPTY_PROJECT = '51000000-0000-4000-8000-000000000003'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const REVISION_1 = '51000000-0000-4000-8004-000000000001'

const nodes = (name: string) => [{ id: `node-${name}`, name, type: 'string' }]

function fakeDatabase(options: { raceOnCreate?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    ProjectContext: [
      { id: PROJECT },
      { id: OTHER_PROJECT },
      { id: EMPTY_PROJECT },
    ],
    ExtractionSchema: [
      { id: SCHEMA, projectContextId: PROJECT },
      { id: '51000000-0000-4000-8003-000000000002', projectContextId: OTHER_PROJECT },
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
  const orderProbe = () =>
    new Proxy({}, {
      get: (_target, field: string) => ({
        asc: (): Order => ({ field, direction: 'asc' }),
        desc: (): Order => ({ field, direction: 'desc' }),
      }),
    })
  const collection = (table: string) => {
    const rows = tables[table] ??= []
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
        orders = (Array.isArray(value) ? value : [value]).map((pick) => pick(orderProbe() as Row))
        return query
      },
      take(value: number) { limit = value; return query },
      async all() {
        return [...selected].sort((left, right) => {
          for (const { field, direction } of orders) {
            const a = left[field] instanceof Date ? (left[field] as Date).getTime() : left[field]
            const b = right[field] instanceof Date ? (right[field] as Date).getTime() : right[field]
            if (a === b) continue
            const result = (a as number | string) < (b as number | string) ? -1 : 1
            return direction === 'asc' ? result : -result
          }
          return 0
        }).slice(0, limit)
      },
      async first(filter?: Row) {
        if (filter) query.where(filter)
        return (await query.all())[0] ?? null
      },
      async create(input: Row) {
        if (options.raceOnCreate && !raced) {
          raced = true
          rows.push({
            ...input,
            id: '51000000-0000-4000-8004-000000000099',
            schemaTree: nodes('rival'),
            createdAt: new Date('2026-08-01T12:01:00Z'),
          })
          throw Object.assign(new Error('unique constraint'), { sqlState: '23505' })
        }
        const row = {
          ...input,
          id: input.id ?? `51000000-0000-4000-${table === 'ExtractionSchema' ? '8003' : '8004'}-${String(rows.length + 1).padStart(12, '0')}`,
          createdAt: new Date(`2026-08-01T12:0${rows.length}:00Z`),
        }
        rows.push(row)
        return row
      },
    }
    return query
  }
  const orm = { public: new Proxy({}, { get: (_target, table: string) => collection(table) }) }
  return {
    tables,
    orm,
    transaction: async <T>(run: (tx: { orm: typeof orm }) => Promise<T>) => run({ orm }),
  }
}

describe('ProjectStore Schema Revisions', () => {
  it('creates the shared Extraction Schema and its initial suggestion revision atomically', async () => {
    const database = fakeDatabase()
    const store = createProjectStore(database as never)

    const result = await store.initializeSchemaRevision(EMPTY_PROJECT, nodes('site'))

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

    const result = await store.appendSchemaRevision(PROJECT, SCHEMA, 1, nodes('year'))

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

    const result = await store.appendSchemaRevision(PROJECT, SCHEMA, 0, nodes('stale'))

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

    const result = await store.appendSchemaRevision(PROJECT, SCHEMA, 1, nodes('mine'))

    assert.equal(result?.status, 'conflict')
    assert.equal(result?.currentRevision.revisionNumber, 2)
    assert.deepEqual(result?.currentRevision.schemaTree, nodes('rival'))
    assert.equal(database.tables.SchemaRevision.length, 2)
  })

  it('gets exact revisions and lists a deterministic bounded owner-scoped window', async () => {
    const database = fakeDatabase()
    database.tables.SchemaRevision.push(
      { id: '51000000-0000-4000-8004-000000000002', extractionSchemaId: SCHEMA, revisionNumber: 2, origin: 'RESEARCHER_EDIT', schemaTree: nodes('year'), createdAt: new Date('2026-08-01T12:01:00Z') },
      { id: '51000000-0000-4000-8004-000000000003', extractionSchemaId: SCHEMA, revisionNumber: 3, origin: 'MODEL_EDIT', schemaTree: nodes('place'), createdAt: new Date('2026-08-01T12:02:00Z') },
    )
    const store = createProjectStore(database as never)

    assert.deepEqual(
      (await store.listSchemaRevisions(PROJECT, SCHEMA, 2))?.map((revision) => revision.revisionNumber),
      [3, 2],
    )
    assert.equal((await store.getSchemaRevision(PROJECT, SCHEMA, REVISION_1))?.revisionNumber, 1)
    assert.equal(await store.listSchemaRevisions(OTHER_PROJECT, SCHEMA, 2), null)
    assert.equal(await store.getSchemaRevision(OTHER_PROJECT, SCHEMA, REVISION_1), null)
  })
})
