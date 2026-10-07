import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtractionAttemptSnapshot } from 'extraction'

const dbos = vi.hoisted(() => {
  const admission = {
    enqueueInTransaction: vi.fn(async () => undefined),
    listWorkflows: vi.fn(async (): Promise<Array<{ workflowID: string; status: string }>> => []),
    cancelWorkflow: vi.fn(async () => undefined),
  }
  const kei = {
    listWorkflows: vi.fn(async (): Promise<Array<{ workflowID: string; status: string }>> => []),
    cancelWorkflow: vi.fn(async () => undefined),
    enqueuePortable: vi.fn(async () => undefined),
  }
  return { admission, kei, studioDbos: vi.fn(() => ({ bootTimestampMs: 0, admission, kei })) }
})
vi.mock('../server/dbos.js', () => ({ studioDbos: dbos.studioDbos }))

const EXTRACTION = '51000000-0000-4000-8006-000000000001'

beforeEach(() => {
  vi.clearAllMocks()
  dbos.admission.listWorkflows.mockResolvedValue([])
  dbos.kei.listWorkflows.mockResolvedValue([])
})

describe('Studio\'s Extraction execution', () => {
  it('needs no launched DBOS until it is used', async () => {
    const { extractionExecution, createResearcherExtractions } = await import('./_extractions.js')
    extractionExecution()
    createResearcherExtractions('51000000-0000-4000-8009-000000000001')
    expect(dbos.studioDbos).not.toHaveBeenCalled()
  })

  it('the execution enqueues through the admission client in the caller\'s transaction', async () => {
    const { extractionExecution } = await import('./_extractions.js')
    const client = { query: vi.fn() }
    const workflow = {
      workflowName: 'reconcileDurableExtractions', workflowID: `durable-dispatch:${EXTRACTION}`, queueName: 'studio',
      authenticatedUser: 'researcher', attributes: { projectContextId: 'project' },
    }
    await extractionExecution().enqueue(client as never, workflow, EXTRACTION)
    expect(dbos.admission.enqueueInTransaction).toHaveBeenCalledOnce()
    expect(dbos.admission.enqueueInTransaction).toHaveBeenCalledWith(
      client,
      // A workflow ID already in use names an Extraction that is gone: DBOS refuses it instead of returning it.
      { ...workflow, workflowIDReusePolicy: 'reject' },
      EXTRACTION,
    )
  })

  it('status reads use one listWorkflows call without inputs or outputs', async () => {
    const { extractionExecution } = await import('./_extractions.js')
    dbos.admission.listWorkflows.mockResolvedValue([
      { workflowID: 'suggest:a:1', status: 'PENDING' },
      { workflowID: 'suggest:b:1', status: 'ENQUEUED' },
    ])
    const statuses = await extractionExecution().statuses(['suggest:a:1', 'suggest:b:1', 'suggest:c:1'])
    expect(dbos.admission.listWorkflows).toHaveBeenCalledOnce()
    expect(dbos.admission.listWorkflows).toHaveBeenCalledWith({
      workflowIDs: ['suggest:a:1', 'suggest:b:1', 'suggest:c:1'], loadInput: false, loadOutput: false,
    })
    expect([...statuses]).toEqual([['suggest:a:1', 'PENDING'], ['suggest:b:1', 'ENQUEUED']])
  })

  it('a DBOS outage rejects a status read instead of answering a status', async () => {
    const { extractionExecution } = await import('./_extractions.js')
    const outage = new Error('connect ECONNREFUSED')
    dbos.admission.listWorkflows.mockRejectedValueOnce(outage)
    await expect(extractionExecution().statuses(['suggest:a:1'])).rejects.toBe(outage)
  })
})

describe('the kei-exp client', () => {
  it('wires KEI_EXP_URL and names no deployment-wide model: each run chooses its own, or kei-exp\'s defaults apply', async () => {
    vi.resetModules()
    vi.stubEnv('KEI_EXP_URL', 'http://kei-exp:8001')
    const created = vi.fn(() => ({ listModels: vi.fn(), listIngestionModels: vi.fn() }))
    vi.doMock('extraction', async (importOriginal) => ({
      ...await importOriginal<typeof import('extraction')>(),
      createKeiExpClient: created,
    }))
    try {
      const module = await import('./_extractions.js')
      expect(created).toHaveBeenCalledOnce()
      // Only the endpoint: neither a FREE connection's model id nor any env model reaches kei-exp.
      expect(created.mock.calls[0]).toEqual([{ url: 'http://kei-exp:8001' }])
      expect(module.keiExpClient).toBe(created.mock.results[0]!.value)
    } finally {
      vi.doUnmock('extraction')
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})

const snapshot: ExtractionAttemptSnapshot = {
  extractionId: EXTRACTION,
  sourceDocumentId: '51000000-0000-4000-8001-000000000001',
  sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
  sourceRepresentationRevisionNumber: 2,
  preprocessId: 'kei-exp:run-1:g1',
  schemaRevisionId: '51000000-0000-4000-8004-000000000001',
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  schemaRevisionNumber: 4,
  strategy: 'CATALOG',
  catalogRecipe: 'numbered-catalogue-de@1',
  requestedModels: { fields: 'nuextract' },
  requestedSettings: { recipe: null },
  executionStatus: 'PAUSED',
  finalizedReview: { snapshotVersion: 3, feedbackVersion: 5, createdAt: new Date('2026-10-05T09:00:00.000Z') },
  batchExtractionId: null,
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
}

describe('extractionAttemptDto', () => {
  it('transports a durable Extraction\'s pins, lifecycle and latest finalized cut, and nothing of a result', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    expect(extractionAttemptDto(snapshot)).toEqual({
      extractionId: EXTRACTION,
      sourceDocumentId: snapshot.sourceDocumentId,
      sourceRepresentationRevisionId: snapshot.sourceRepresentationRevisionId,
      schemaRevisionId: snapshot.schemaRevisionId,
      strategy: 'CATALOG',
      catalogRecipe: 'numbered-catalogue-de@1',
      requestedModels: { fields: 'nuextract' },
      requestedSettings: { recipe: null },
      executionStatus: 'PAUSED',
      finalizedReview: { snapshotVersion: 3, feedbackVersion: 5, createdAt: '2026-10-05T09:00:00.000Z' },
      batchExtractionId: null,
      createdAt: '2026-08-20T10:00:00.000Z',
    })
  })

  it('names no finalized cut and no admitted choice when there is none', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const dto = extractionAttemptDto({ ...snapshot, strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, requestedSettings: null, finalizedReview: null })
    expect(dto).toMatchObject({ catalogRecipe: null, requestedModels: null, requestedSettings: null, finalizedReview: null })
  })

  it('refuses a recipe on an Article Extraction', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    expect(() => extractionAttemptDto({ ...snapshot, strategy: 'ARTICLE' })).toThrow()
  })
})
