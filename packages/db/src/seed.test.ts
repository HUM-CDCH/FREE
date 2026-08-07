import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleProjects, seedExampleProjects, type Ingest } from './seed.js'

type Row = Record<string, unknown>

/** An in-memory stand-in for the three tables the seed writes. */
function fakeDatabase() {
  const created: Record<string, Row[]> = {
    ProjectContext: [],
    SourceDocument: [],
    SourceRepresentationRevision: [],
  }
  const table = (name: string) => ({
    first: async ({ id }: { id: string }) =>
      created[name].find((row) => row.id === id) ?? null,
    create: async (row: Row) => {
      created[name].push(row)
      return row
    },
  })
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
  }
}

function fakeIngest() {
  const filenames: string[] = []
  const ingest: Ingest = async (pdf, filename) => {
    assert.ok(pdf.byteLength > 0, 'the example PDF bytes reach ingestion')
    filenames.push(filename)
    return {
      artifactReference: `task-${filenames.length}`,
      artifactSha256: 'a'.repeat(64),
      contractVersion: 'parsed_document.v2',
      preprocessId: `sha256:${'b'.repeat(64)}`,
      parserName: 'docling_pdf',
      parserVersion: '2.0.0',
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

    const first = await seedExampleProjects(database as never, ingest)
    const second = await seedExampleProjects(database as never, ingest)

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

    await seedExampleProjects(database as never, ingest)

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

    const result = await seedExampleProjects(database as never, unparseable)

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
    const result = await seedExampleProjects(database as never, ingest)

    assert.deepEqual(result, {
      projectsCreated: 0,
      documentsCreated: 0,
      representationsCreated: 3,
      representationFailures: [],
    })
  })

})
