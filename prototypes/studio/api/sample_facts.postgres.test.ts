import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createResearcherProjectStore, db, pool } from 'db'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { disposableDatabaseUrl } from '../test/support/postgres.js'
import { seedResearch, removeResearch, type SeededResearch } from '../test/support/research.js'
import { createResearcherApiHandlers } from './sample_facts.js'

disposableDatabaseUrl()
const scratch = await mkdtemp(join(tmpdir(), 'free-sample-facts-'))
const packages = createCanonicalPackageStore(scratch), seeded: SeededResearch[] = []
afterAll(async () => {
  for (const research of seeded) await removeResearch(research)
  await db.close(); await pool.end(); await rm(scratch, { recursive: true, force: true })
})

it('deduplicates pages on selected current pins, excludes historical samples, and enforces ownership and bounds', async () => {
  const research = await seedResearch(packages); seeded.push(research)
  const original = (await db.orm.public.SourceRepresentationRevision.where({ id: research.sourceRepresentationRevisionId })
    .select('artifactReference', 'artifactSha256', 'preprocessId', 'contractVersion', 'parserName', 'parserVersion').first())!
  const others = await Promise.all([1, 2].map(async () => {
    const sourceDocumentId = randomUUID(), pin = randomUUID()
    await db.orm.public.SourceDocument.create({ id: sourceDocumentId, projectContextId: research.projectContextId,
      contentSha256: randomUUID().replaceAll('-', '').repeat(2), mediaType: 'application/pdf', originalName: 'other.pdf' })
    await db.orm.public.SourceRepresentationRevision.create({ ...original, id: pin, sourceDocumentId, revisionNumber: 1 })
    return sourceDocumentId
  }))
  const schemaTree = { recordDescription: 'Records', schemaNodes: [{ id: 'title', name: 'title', type: 'string' }] }
  const selectedRevision = randomUUID()
  await db.orm.public.SchemaRevision.create({ id: selectedRevision, extractionSchemaId: research.extractionSchemaId,
    revisionNumber: 2, origin: 'RESEARCHER_EDIT', schemaTree })
  const extraction = { sourceDocumentId: research.sourceDocumentId, sourceRepresentationRevisionId: research.sourceRepresentationRevisionId,
    schemaRevisionId: selectedRevision, strategy: 'ARTICLE' }
  for (let index = 0; index < 5; index++) await db.orm.public.Extraction.create({ ...extraction, requestedPages: [12, 13],
    ...(index === 0 ? { reviewedAt: new Date() } : index === 1 ? { reviewDraft: [] } : {}) })
  await db.orm.public.Extraction.create({ ...extraction, outcome: 'SUCCEEDED' })
  await db.orm.public.Extraction.create({ ...extraction, schemaRevisionId: research.schemaRevisionId, requestedPages: [40] })
  const sources = [research.sourceDocumentId, ...others]
  const { POST } = createResearcherApiHandlers(createResearcherProjectStore(research.researcherAccountId))
  const request = (sourceDocumentIds = sources) => new Request('http://localhost/api/sample_facts', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectContextId: research.projectContextId, schemaRevisionId: selectedRevision, sourceDocumentIds }) })
  const read = async () => {
    const response = await POST(request()); expect(response.status).toBe(200)
    return (await response.json()).sources as Array<Record<string, unknown>>
  }
  const first = await read()
  expect(first.find((source) => source.sourceDocumentId === research.sourceDocumentId)).toEqual({
    sourceDocumentId: research.sourceDocumentId, sourceRepresentationRevisionId: research.sourceRepresentationRevisionId,
    admitted: 5, savedDrafts: 1, finalized: 1, fullResults: 1, pages: [12, 13], reviewedPages: [12, 13],
  })
  expect(first.filter((source) => source.sourceDocumentId !== research.sourceDocumentId).every((source) => source.admitted === 0)).toBe(true)
  const newPin = randomUUID()
  await db.orm.public.SourceRepresentationRevision.create({ ...original, id: newPin, sourceDocumentId: research.sourceDocumentId, revisionNumber: 2 })
  expect((await read()).find((source) => source.sourceDocumentId === research.sourceDocumentId)).toEqual({
    sourceDocumentId: research.sourceDocumentId, sourceRepresentationRevisionId: newPin,
    admitted: 0, savedDrafts: 0, finalized: 0, fullResults: 0, pages: [], reviewedPages: [],
  })
  expect((await POST(request([sources[0]!, sources[0]!]))).status).toBe(422)
  expect((await POST(request(Array.from({ length: 51 }, () => randomUUID())))).status).toBe(422)
  const otherAccount = await seedResearch(packages); seeded.push(otherAccount)
  expect((await POST(request([...sources, otherAccount.sourceDocumentId]))).status).toBe(404)
  expect((await createResearcherApiHandlers(createResearcherProjectStore(otherAccount.researcherAccountId)).POST(request())).status).toBe(404)
})
