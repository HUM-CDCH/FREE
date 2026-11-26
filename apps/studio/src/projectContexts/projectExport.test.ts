import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportProjectResults } from './projectExport'

vi.mock('../auth/authenticatedFetch', () => ({ authenticatedFetch: (...args: unknown[]) => fetch(...args as Parameters<typeof fetch>) }))
const downloadDurableBatch = vi.fn(async () => true)
vi.mock('../durableExport', () => ({ downloadDurableBatch: (...args: unknown[]) => downloadDurableBatch(...args as []) }))
afterEach(() => { vi.unstubAllGlobals(); downloadDurableBatch.mockClear() })

const PROJECT = '51000000-0000-4000-8000-000000000001', REVISION = '51000000-0000-4000-8004-000000000001'
const ids = ['1', '2', '3'].map((n) => `51000000-0000-4000-8001-00000000000${n}`)
const documents = ids.map((id, index) => ({ id, name: `Letter ${index + 1}.pdf` }))
const extraction = (n: string) => `51000000-0000-4000-8006-00000000000${n}`
const BATCH = '51000000-0000-4000-8007-000000000001'
const member = (index: number, reviewed: boolean) => ({ extractionId: extraction(String(index + 1)), sourceDocumentId: ids[index]!,
  sourceRepresentationRevisionId: ids[index]!.replace('-8001-', '-8002-'), executionStatus: 'COMPLETED', completed: true, reviewable: true, missingCount: 0,
  currentReview: reviewed ? { snapshotVersion: 1, feedbackVersion: 0, createdAt: '2026-11-01T00:00:00.000Z', schemaRevisionId: REVISION } : null })
const round = { batchExtractionId: BATCH, projectContextId: PROJECT, schemaRevisionId: REVISION, extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  extractionSchemaName: 'Letters', schemaRevisionNumber: 1, strategy: 'ARTICLE', executionStatus: 'COMPLETED', createdAt: '2026-11-01T00:00:00.000Z',
  trial: false, members: [member(0, true), member(1, true), member(2, false)] }
const run = (index: number, extractionId: string, createdAt: string, review: { snapshotVersion: number; feedbackVersion: number } | null,
  batchExtractionId: string | null = null, schemaRevisionId = REVISION) => ({
  sourceDocumentId: ids[index]!, extractionId, schemaRevisionId, sourceRepresentationRevisionId: member(index, false).sourceRepresentationRevisionId,
  batchExtractionId, createdAt, completed: true, review })
function answer(reviewed: ReturnType<typeof run>[], latest = reviewed, newest = reviewed.map(({ extractionId }) => extractionId)) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ batchExtractions: [round], latestExtractions: latest, reviewedExtractions: reviewed,
    newestExtractionIds: newest })))
}
const root = { rowsRepresent: '$', otherRepeatedFields: 'preserve' as const }
const exported = () => (downloadDurableBatch.mock.calls[0] as unknown as [unknown, { sourceDocumentId: string; extractionId: string; review?: unknown }[]])[1]
  .map(({ sourceDocumentId, extractionId, review }) => [sourceDocumentId, extractionId, review])

describe('exportProjectResults (ADR 0041)', () => {
  it('exports every document with a reviewed result, at its reviewed cut, in the project\'s order', async () => {
    answer([run(1, extraction('2'), '2026-11-01T00:00:00.000Z', { snapshotVersion: 1, feedbackVersion: 0 }, BATCH),
      run(0, extraction('1'), '2026-11-01T00:00:00.000Z', { snapshotVersion: 1, feedbackVersion: 0 }, BATCH)])
    await expect(exportProjectResults(PROJECT, { summary: { currentSchemaRevisionId: REVISION }, documents }, 'Letters', 'csv', root)).resolves.toBe(true)
    expect(exported()).toEqual([[ids[0], extraction('1'), { snapshotVersion: 1, feedbackVersion: 0 }], [ids[1], extraction('2'), { snapshotVersion: 1, feedbackVersion: 0 }]])
    expect(downloadDurableBatch.mock.calls[0]).toMatchObject([{ batchExtractionId: '', name: 'Letters' }, expect.any(Array), 'csv', root])
  })

  it('exports a document\'s newest review: a run of it alone reviewed since, never a newer run unreviewed, nor its older member', async () => {
    const alone = run(0, extraction('a'), '2026-11-02T00:00:00.000Z', { snapshotVersion: 2, feedbackVersion: 3 })
    const newer = run(0, extraction('b'), '2026-11-03T00:00:00.000Z', null)
    answer([alone, run(1, extraction('2'), '2026-11-01T00:00:00.000Z', { snapshotVersion: 1, feedbackVersion: 0 }, BATCH)], [newer])
    await exportProjectResults(PROJECT, { summary: { currentSchemaRevisionId: REVISION }, documents }, 'Letters', 'xlsx', root)
    expect(exported()).toEqual([[ids[0], extraction('a'), { snapshotVersion: 2, feedbackVersion: 3 }], [ids[1], extraction('2'), { snapshotVersion: 1, feedbackVersion: 0 }]])
  })

  it('exports nothing, and says so, when no document has a reviewed result on the current template', async () => {
    answer([run(0, extraction('1'), '2026-11-01T00:00:00.000Z', { snapshotVersion: 1, feedbackVersion: 0 }, BATCH, '51000000-0000-4000-8004-000000000099')])
    await expect(exportProjectResults(PROJECT, { summary: { currentSchemaRevisionId: REVISION }, documents }, 'Letters', 'json', root)).resolves.toBe(false)
    expect(downloadDurableBatch).not.toHaveBeenCalled()
  })
})
