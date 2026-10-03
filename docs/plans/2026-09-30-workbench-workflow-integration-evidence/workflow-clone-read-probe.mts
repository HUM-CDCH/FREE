import assert from 'node:assert/strict'
import { createResearcherExtractionPersistence } from '/tmp/free-workflow-review-ba3e7cc1/packages/extraction/src/postgres-persistence.ts'

async function main() {
  const jobId = '11111111-1111-4111-8111-111111111111'
  const cloneId = '22222222-2222-4222-8222-222222222222'
  const docId = '33333333-3333-4333-8333-333333333333'
  const representationId = '44444444-4444-4444-8444-444444444444'
  const researcherId = '55555555-5555-4555-8555-555555555555'
  const job = {
    id: jobId, kind: 'BATCH_MEMBER', executionStatus: 'COMPLETED',
    sourceDocumentId: docId, sourceRepresentationRevisionId: representationId,
    createdAt: new Date(),
  }
  const clone = { id: cloneId, sourceDocumentId: docId, reviewedAt: new Date() }
  const table = (rows: Record<string, unknown>[]) => {
    const chain: any = {}
    for (const name of ['select', 'where', 'orderBy']) chain[name] = () => chain
    chain.all = async () => rows
    chain.first = async (filter?: Record<string, unknown>) => filter
      ? rows.find(row => Object.entries(filter).every(([key, value]) => row[key] === value)) ?? null
      : rows[0] ?? null
    return chain
  }
  const orm = { public: {
    ExtractionJob: table([job]), Extraction: table([clone]),
  } }
  const query: any = {}
  for (const name of ['innerJoin', 'select', 'where']) query[name] = () => query
  query.build = () => ({})
  const tx = {
    orm,
    sql: { public: { extractionJob: query, sourceDocument: query, projectContext: query } },
    execute: () => ({ first: async () => ({ id: researcherId }) }),
  }
  const database: any = { orm, transaction: async (fn: any) => fn(tx) }
  const persistence = createResearcherExtractionPersistence(researcherId, database, {} as any)
  const cloneRead = await persistence.readExtractionAttempt(cloneId)
  assert.equal(cloneRead, null)
  console.log('readExtractionAttempt(clonedExtractionId): null (API maps to 404)')
  await assert.rejects(persistence.readDocumentExtractions({ sourceDocumentId: docId }), /Completed Extraction Job has no terminal Extraction/)
  console.log('readDocumentExtractions(sourceDocumentId): throws Completed Extraction Job has no terminal Extraction')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
