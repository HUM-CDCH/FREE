import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleProjects, seedExampleProjects } from './seed.js'

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

    const projectIds = new Set<string>()
    const documentIds = new Set<string>()
    const createdProjects: unknown[] = []
    const createdDocuments: unknown[] = []
    const database = {
      orm: {
        public: {
          ProjectContext: {
            first: async ({ id }: { id: string }) =>
              projectIds.has(id) ? { id } : null,
            create: async (row: { id: string }) => {
              projectIds.add(row.id)
              createdProjects.push(row)
              return row
            },
          },
          SourceDocument: {
            first: async ({ id }: { id: string }) =>
              documentIds.has(id) ? { id } : null,
            create: async (row: { id: string }) => {
              documentIds.add(row.id)
              createdDocuments.push(row)
              return row
            },
          },
        },
      },
    }

    await seedExampleProjects(database as never)
    await seedExampleProjects(database as never)

    assert.equal(createdProjects.length, 2)
    assert.equal(createdDocuments.length, 3)
    for (const row of createdDocuments) {
      assert.match(
        (row as { contentSha256: string }).contentSha256,
        /^[a-f0-9]{64}$/,
      )
    }
  })
})
