import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleProjects, seedExampleProjects, type Ingest } from './seed.js'

type Row = Record<string, unknown>
type Order = { field: string; direction: 'asc' | 'desc' }

/** An in-memory stand-in for the three tables the seed writes. */
function fakeDatabase() {
  const created: Record<string, Row[]> = {
    ProjectContext: [],
    SourceDocument: [],
    SourceRepresentationRevision: [],
  }
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
  const table = (name: string) => {
    let selected = created[name]
    let orders: Order[] = []
    const query = {
      where(filter: Row) {
        selected = selected.filter((row) =>
          Object.entries(filter).every(([key, value]) => row[key] === value),
        )
        return query
      },
      orderBy(value: (row: Row) => Order) {
        orders = [value(orderProbe() as Row)]
        return query
      },
      async first(filter?: Row) {
        if (filter) query.where(filter)
        const row = [...selected].sort((left, right) => {
          for (const { field, direction } of orders) {
            if (left[field] === right[field]) continue
            const result =
              (left[field] as number | string) <
              (right[field] as number | string)
                ? -1
                : 1
            return direction === 'asc' ? result : -result
          }
          return 0
        })[0] ?? null
        selected = created[name]
        orders = []
        return row
      },
      async create(row: Row) {
        created[name].push(row)
        return row
      },
      async delete() {
        for (const row of selected) {
          const index = created[name].indexOf(row)
          if (index >= 0) created[name].splice(index, 1)
        }
        selected = created[name]
      },
    }
    return query
  }
  const orm = {
    public: {
      ProjectContext: table('ProjectContext'),
      SourceDocument: table('SourceDocument'),
      SourceRepresentationRevision: table('SourceRepresentationRevision'),
    },
  }
  return {
    created,
    orm,
    transaction: async (work: (database: { orm: typeof orm }) => unknown) =>
      work({ orm }),
  }
}

function fakeIngest() {
  const filenames: string[] = []
  const ingest: Ingest = async (pdf, filename, current) => {
    if (current) return current
    assert.ok(pdf.byteLength > 0, 'the example PDF bytes reach ingestion')
    filenames.push(filename)
    return {
      artifactReference: `task-${filenames.length}`,
      artifactSha256: 'a'.repeat(64),
      contractVersion: 'parsed_document.v2',
      preprocessId: `sha256:${'b'.repeat(64)}`,
      parserName: 'docling_pdf',
      parserVersion: '2.0.0',
      ensureRetained: async () => {},
    }
  }
  return { filenames, ingest }
}

describe('example database seed', () => {
  it('puts every example PDF in two projects without duplicating rows', async () => {
    assert.equal(exampleProjects.length, 2)
    assert.deepEqual(
      exampleProjects.flatMap((project) => project.documents.map((document) => document.filename)),
      [
        'Beretning_Ellekilde_8_13.pdf',
        '1790-06-17-1.pdf',
        'Zhang et al. 2024 - Properties of skin collagen from southern catfish (Silurus meridionalis) fed with raw and cooked food.pdf',
      ],
    )

    const database = fakeDatabase()
    const { ingest, filenames } = fakeIngest()

    const first = await seedExampleProjects(
      database as never,
      ingest,
      async () => true,
    )
    const second = await seedExampleProjects(
      database as never,
      ingest,
      async () => true,
    )

    assert.deepEqual(first, {
      projectsCreated: 2,
      documentsCreated: 3,
      representationsCreated: 3,
      representationFailures: [],
    })
    assert.deepEqual(second, {
      projectsCreated: 0,
      documentsCreated: 0,
      representationsCreated: 0,
      representationFailures: [],
    })
    assert.equal(database.created.ProjectContext.length, 2)
    assert.equal(database.created.SourceDocument.length, 3)
    for (const row of database.created.SourceDocument) {
      assert.match(row.contentSha256 as string, /^[a-f0-9]{64}$/)
    }
    // An immutable representation is ingested once, never on a re-seed.
    assert.equal(filenames.length, 3)
  })

  it('pins every seeded Source Document to a reopenable representation', async () => {
    const database = fakeDatabase()
    const { ingest } = fakeIngest()

    await seedExampleProjects(database as never, ingest, async () => true)

    const representations = database.created.SourceRepresentationRevision
    assert.equal(representations.length, 3)
    assert.deepEqual(representations[0], {
      id: '51000000-0000-4000-8002-000000000001',
      sourceDocumentId: '51000000-0000-4000-8001-000000000001',
      revisionNumber: 1,
      artifactReference: 'task-1',
      artifactSha256: 'a'.repeat(64),
      contractVersion: 'parsed_document.v2',
      preprocessId: `sha256:${'b'.repeat(64)}`,
      parserName: 'docling_pdf',
      parserVersion: '2.0.0',
    })
    assert.deepEqual(
      representations.map((row) => row.sourceDocumentId),
      exampleProjects.flatMap((project) =>
        project.documents.map((document) => document.sourceDocumentId),
      ),
    )
  })

  it('reasserts package retention after publishing its database reference', async () => {
    const database = fakeDatabase()
    const { ingest: baseIngest } = fakeIngest()
    const ingest: Ingest = async (pdf, filename) => {
      const representation = await baseIngest(pdf, filename)
      return {
        ...representation,
        ensureRetained: async () => {
          assert.ok(
            database.created.SourceRepresentationRevision.some(
              (row) =>
                row.artifactReference === representation.artifactReference,
            ),
          )
        },
      }
    }

    await seedExampleProjects(database as never, ingest, async () => true)
  })

  it('removes a new revision when its post-reference retention fails', async () => {
    const database = fakeDatabase()
    const { ingest: baseIngest } = fakeIngest()
    await seedExampleProjects(database as never, baseIngest, async () => true)
    const ingest: Ingest = async (pdf, filename) => {
      const representation = await baseIngest(pdf, filename)
      return {
        ...representation,
        ensureRetained:
          filename === exampleProjects[0].documents[0].filename
            ? async () => Promise.reject(new Error('Package re-publish failed.'))
            : representation.ensureRetained,
      }
    }

    const result = await seedExampleProjects(
      database as never,
      ingest,
      async ({ artifactReference }) => artifactReference !== 'task-1',
    )

    assert.equal(result.representationsCreated, 0)
    assert.deepEqual(result.representationFailures, [
      {
        filename: exampleProjects[0].documents[0].filename,
        reason: 'Package re-publish failed.',
      },
    ])
    assert.equal(
      database.created.SourceRepresentationRevision.some(
        (row) => row.artifactReference === 'task-4',
      ),
      false,
    )
    assert.equal(
      database.created.SourceRepresentationRevision.find(
        (row) =>
          row.id === exampleProjects[0].documents[0].sourceRepresentationId,
      )?.artifactReference,
      'task-1',
    )
    assert.equal(database.created.SourceRepresentationRevision.length, 3)
  })

  it('still seeds navigation when the Parsing Service is unavailable', async () => {
    const database = fakeDatabase()

    const result = await seedExampleProjects(database as never, null)

    assert.deepEqual(result, {
      projectsCreated: 2,
      documentsCreated: 3,
      representationsCreated: 0,
      representationFailures: [],
    })
    assert.equal(database.created.SourceRepresentationRevision.length, 0)
  })

  it('keeps seeding when one example cannot be ingested', async () => {
    const database = fakeDatabase()
    const { ingest } = fakeIngest()
    const unparseable: Ingest = async (pdf, filename) =>
      filename === '1790-06-17-1.pdf'
        ? Promise.reject(new Error('Parsing failed: ocr_fallback_failed.'))
        : ingest(pdf, filename)

    const result = await seedExampleProjects(
      database as never,
      unparseable,
      async () => true,
    )

    assert.equal(result.documentsCreated, 3)
    assert.equal(result.representationsCreated, 2)
    assert.deepEqual(result.representationFailures, [
      {
        filename: '1790-06-17-1.pdf',
        reason: 'Parsing failed: ocr_fallback_failed.',
      },
    ])
    // The failed one keeps its Source Document and can be ingested later.
    assert.equal(database.created.SourceDocument.length, 3)
    assert.deepEqual(
      database.created.SourceRepresentationRevision.map(
        (row) => row.sourceDocumentId,
      ),
      [
        '51000000-0000-4000-8001-000000000001',
        '51000000-0000-4000-8001-000000000003',
      ],
    )
  })

  it('adds the missing representations when the Parsing Service returns', async () => {
    const database = fakeDatabase()
    const { ingest } = fakeIngest()

    await seedExampleProjects(database as never, null)
    const result = await seedExampleProjects(
      database as never,
      ingest,
      async () => true,
    )

    assert.deepEqual(result, {
      projectsCreated: 0,
      documentsCreated: 0,
      representationsCreated: 3,
      representationFailures: [],
    })
  })

  it('advances past a stale task reference only after durable package ingestion succeeds', async () => {
    const database = fakeDatabase()
    const { ingest, filenames } = fakeIngest()

    await seedExampleProjects(database as never, ingest, async () => true)
    const retained = async ({ artifactReference }: { artifactReference: string }) =>
      artifactReference !== 'task-1'
    const failed = await seedExampleProjects(
      database as never,
      async (_pdf, _filename, current) =>
        current ?? Promise.reject(new Error('Package transfer failed.')),
      retained,
    )

    assert.equal(failed.representationsCreated, 0)
    assert.equal(failed.representationFailures.length, 1)
    assert.equal(
      database.created.SourceRepresentationRevision.find(
        (row) =>
          row.id === '51000000-0000-4000-8002-000000000001',
      )?.artifactReference,
      'task-1',
    )

    const repaired = await seedExampleProjects(
      database as never,
      ingest,
      retained,
    )

    assert.equal(repaired.representationsCreated, 1)
    assert.deepEqual(repaired.representationFailures, [])
    assert.equal(database.created.SourceRepresentationRevision.length, 4)
    const repair = database.created.SourceRepresentationRevision.find(
      (row) =>
        row.sourceDocumentId === '51000000-0000-4000-8001-000000000001' &&
        row.revisionNumber === 2,
    )
    assert.notEqual(repair?.id, '51000000-0000-4000-8002-000000000001')
    assert.equal(repair?.artifactReference, 'task-4')
    assert.equal(filenames.length, 4)
  })

  it('appends a representation when the parsing policy changes', async () => {
    const database = fakeDatabase()
    const { ingest } = fakeIngest()

    await seedExampleProjects(database as never, ingest)
    const changedPolicy: Ingest = async (_pdf, filename, current) =>
      filename === 'Beretning_Ellekilde_8_13.pdf'
        ? {
            artifactReference: 'updated-task',
            artifactSha256: 'c'.repeat(64),
            contractVersion: 'parsed_document.v2',
            preprocessId: `sha256:${'d'.repeat(64)}`,
            parserName: 'docling_pdf',
            parserVersion: '2.0.0',
          }
        : current!

    const result = await seedExampleProjects(
      database as never,
      changedPolicy,
      async () => true,
    )

    assert.equal(result.representationsCreated, 1)
    assert.equal(database.created.SourceRepresentationRevision.length, 4)
    assert.equal(
      database.created.SourceRepresentationRevision.find(
        (row) =>
          row.id === '51000000-0000-4000-8002-000000000001',
      )?.artifactReference,
      'task-1',
    )
    assert.equal(
      database.created.SourceRepresentationRevision.find(
        (row) =>
          row.sourceDocumentId ===
            '51000000-0000-4000-8001-000000000001' &&
          row.revisionNumber === 2,
      )?.artifactReference,
      'updated-task',
    )
  })

})
