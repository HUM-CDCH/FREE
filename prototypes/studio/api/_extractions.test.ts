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
      workflowName: 'runExtraction', workflowID: `extract:${EXTRACTION}`, queueName: 'studio',
      authenticatedUser: 'researcher', attributes: { projectContextId: 'project', keiRunId: 'run-1' },
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

  it('cancel stops the Studio workflow only while it is live, then its kei child', async () => {
    const { extractionExecution } = await import('./_extractions.js')
    dbos.admission.listWorkflows.mockResolvedValue([{ workflowID: `extract:${EXTRACTION}`, status: 'PENDING' }])
    dbos.kei.listWorkflows.mockResolvedValue([{ workflowID: `kei-extract:${EXTRACTION}`, status: 'ENQUEUED' }])
    await extractionExecution().cancel(EXTRACTION)
    expect(dbos.admission.cancelWorkflow).toHaveBeenCalledWith(`extract:${EXTRACTION}`)
    expect(dbos.kei.cancelWorkflow).toHaveBeenCalledWith(`kei-extract:${EXTRACTION}`)
    expect(dbos.admission.cancelWorkflow.mock.invocationCallOrder[0])
      .toBeLessThan(dbos.kei.cancelWorkflow.mock.invocationCallOrder[0]!)

    vi.clearAllMocks()
    // A cancelled or finished workflow is left alone: a repeated cancel would move its updated_at.
    for (const status of ['CANCELLED', 'SUCCESS', 'ERROR']) {
      dbos.admission.listWorkflows.mockResolvedValueOnce([{ workflowID: `extract:${EXTRACTION}`, status }])
      dbos.kei.listWorkflows.mockResolvedValueOnce([{ workflowID: `kei-extract:${EXTRACTION}`, status }])
      await extractionExecution().cancel(EXTRACTION)
    }
    dbos.admission.listWorkflows.mockResolvedValueOnce([])
    dbos.kei.listWorkflows.mockResolvedValueOnce([])
    await extractionExecution().cancel(EXTRACTION)
    expect(dbos.admission.cancelWorkflow).not.toHaveBeenCalled()
    expect(dbos.kei.cancelWorkflow).not.toHaveBeenCalled()
  })

  it('status reads use one listWorkflows call without inputs or outputs', async () => {
    const { extractionExecution } = await import('./_extractions.js')
    dbos.admission.listWorkflows.mockResolvedValue([
      { workflowID: 'extract:a', status: 'PENDING' },
      { workflowID: 'extract:b', status: 'ENQUEUED' },
    ])
    const statuses = await extractionExecution().statuses(['extract:a', 'extract:b', 'extract:c'])
    expect(dbos.admission.listWorkflows).toHaveBeenCalledOnce()
    expect(dbos.admission.listWorkflows).toHaveBeenCalledWith({
      workflowIDs: ['extract:a', 'extract:b', 'extract:c'], loadInput: false, loadOutput: false,
    })
    expect([...statuses]).toEqual([['extract:a', 'PENDING'], ['extract:b', 'ENQUEUED']])
  })

  it('a DBOS outage rejects a status read instead of answering a status', async () => {
    const { extractionExecution } = await import('./_extractions.js')
    const outage = new Error('connect ECONNREFUSED')
    dbos.admission.listWorkflows.mockRejectedValueOnce(outage)
    await expect(extractionExecution().statuses(['extract:a'])).rejects.toBe(outage)
  })

  it('runExtraction reads published artifacts through the kei-exp client on KEI_EXP_URL and the kei handoff', async () => {
    const { extractionWorkflowPorts, keiExpClient } = await import('./_extractions.js')
    const read = vi.spyOn(keiExpClient, 'readExtractionArtifact').mockResolvedValue(new Uint8Array([1]))
    const ports = extractionWorkflowPorts()
    const signal = new AbortController().signal
    expect(await ports.readArtifact('run-1', EXTRACTION, signal)).toEqual(new Uint8Array([1]))
    expect(read).toHaveBeenCalledWith('run-1', EXTRACTION, signal)
    dbos.kei.listWorkflows.mockResolvedValueOnce([{ workflowID: `kei-extract:${EXTRACTION}`, status: 'PENDING' }])
    await ports.kei.cancel(`kei-extract:${EXTRACTION}`)
    expect(dbos.kei.cancelWorkflow).toHaveBeenCalledWith(`kei-extract:${EXTRACTION}`)
    read.mockRestore()
  })
})

describe('the kei-exp client', () => {
  it('wires KEI_EXP_URL and names no deployment-wide model: each run chooses its own, or kei-exp\'s defaults apply', async () => {
    vi.resetModules()
    vi.stubEnv('KEI_EXP_URL', 'http://kei-exp:8001')
    const created = vi.fn(() => ({ readExtractionArtifact: vi.fn(), listModels: vi.fn(), listIngestionModels: vi.fn() }))
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
  strategy: 'ARTICLE',
  catalogRecipe: null,
  executionStatus: 'COMPLETED',
  outcome: 'SUCCEEDED',
  complete: true,
  modelAttribution: { provider: 'openai', modelId: 'fixture' },
  diagnostics: {
    phase: 'persisting',
    durationMs: 12,
    modelCalls: 1,
    finishReason: 'stop',
    inputTokens: 10,
    outputTokens: 4,
    ungroundedPaths: [],
    groundingIssues: [],
    groundingBatches: [
      {
        resultPath: ['records', 0],
        candidateCount: 1,
        fallback: true,
        outcome: 'succeeded',
        finishReason: 'stop',
        inputTokens: 3,
        outputTokens: 1,
        durationMs: 4,
      },
    ],
    unverifiedFields: [],
    catalog: null,
  },
  result: { records: [{ title: 'Alpha' }] },
  evidence: [
    { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-alpha' },
  ],
  failure: null,
  reviewable: true,
  batchExtractionId: null,
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
  reviewedAt: null,
  reviewDecisions: [],
}
const attemptSnapshot = snapshot

describe('extractionAttemptDto', () => {
  it('transports the version 2 review material instead of stripping it', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const grounded = {
      recipe: 'numbered-catalogue-de@1', segmentationFingerprint: 'f',
      budget: { inputTokens: 4096, outputTokens: 1024, tokenizer: { source: 'vllm:/tokenize' } },
      segmentationDiagnostics: [],
      normalization: { version: 1, rules: ['glossary' as const] },
      recordBlocks: [], proposed: [], rejected: [], competitors: [],
      coverage: { complete: true }, completeness: { processing: true, coverage: true, grounding: true, recall: 'unmeasured' as const },
    }
    const dto = extractionAttemptDto({ ...attemptSnapshot, diagnostics: { ...snapshot.diagnostics!, grounded } })
    expect(dto.diagnostics?.grounded).toEqual(grounded)
  })

  it('transports a unified Catalog result exactly as acceptance maps the Parsing Service\'s artifact', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const { acceptKeiArtifact } = await import('../../../packages/extraction/src/kei-artifact.js')
    const { decodeParsedDocument } = await import('../../../packages/extraction/src/parsed-document.js')
    const { keiExpManifestSchema, keiExpPageSchema, parsedDocumentFromKeiExp } = await import('./_kei_exp.js')
    const contract = (await import('../../parsing_service/tests/fixtures/contracts/extract.result.v3.json', { with: { type: 'json' } })).default
    const manifest = keiExpManifestSchema.parse(contract.manifest)
    const document = decodeParsedDocument(parsedDocumentFromKeiExp(contract.request.run_id, manifest,
      contract.pages.map((page) => keiExpPageSchema.parse(page)),
      { sha256: manifest.recipe.source_sha256, originalFilename: 'katalog.pdf', byteSize: 1 }, new Date()).document)
    const accepted = acceptKeiArtifact({ extractionId: contract.extraction_id, sourceDocumentId: attemptSnapshot.sourceDocumentId,
      sourceRepresentationRevisionId: attemptSnapshot.sourceRepresentationRevisionId, schemaRevisionId: attemptSnapshot.schemaRevisionId,
      strategy: 'CATALOG', batchExtractionId: null }, document, contract.artifact, contract.request as never)
    const dto = extractionAttemptDto({ ...attemptSnapshot, strategy: 'CATALOG', requestedSettings: { unified: { defaults: 1 } },
      complete: accepted.complete, diagnostics: accepted.diagnostics, result: accepted.result, evidence: accepted.evidence })
    expect(dto.diagnostics?.unified).toEqual(accepted.diagnostics.unified)
    expect(dto.evidenceLinks).toEqual(accepted.evidence)
    expect(dto.requestedSettings).toEqual({ unified: { defaults: 1 } })
  })

  it('carries the Catalog recipe the attempt ran with, or null', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    expect(extractionAttemptDto(attemptSnapshot).catalogRecipe).toBeNull()
    const failedCatalog = extractionAttemptDto({
      ...attemptSnapshot,
      strategy: 'CATALOG',
      catalogRecipe: 'numbered-catalogue-de@1',
      executionStatus: 'FAILED',
      outcome: null,
      complete: null,
      modelAttribution: null,
      diagnostics: null,
      result: null,
      evidence: null,
      failure: { code: 'interrupted', message: 'This work stopped before it finished. Start it again.', phase: 'extracting' },
      reviewable: false,
    })
    expect(failedCatalog).toMatchObject({
      strategy: 'CATALOG',
      catalogRecipe: 'numbered-catalogue-de@1',
      executionStatus: 'FAILED',
      outcome: null,
      failure: { code: 'interrupted', message: 'This work stopped before it finished. Start it again.' },
    })
  })

  it('transports what kei-exp reports it ran, its schema-policy accounting and its support proofs unchanged', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const { extractionAttemptSchema } = await import('../shared/extraction.contract.js')
    const article = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
    const effectiveMethod = { options: { strategy: 'article', model: null, models: null, article }, versions: { prompt: 12, method: 1, spanGrounding: 2 } }
    const eligibility = { allRecordLeaves: 2, eligibleRecordLeaves: 1, eligibleGrounding: 'complete' as const,
      skipped: [{ resultPath: ['records', 0, 'year'], policy: 'derived' as const }] }
    const support = [{ resultPath: ['records', 0, 'title'], segment: 'p1_s0', cell: null, span: 'p1_s0@3:9', start: 3, end: 9,
      quote: 'Ålpha 🜁', attribution: 'model_attested' }]
    const dto = extractionAttemptDto({
      ...attemptSnapshot, requestedSettings: { article: null },
      // The service lists a policy-skipped path among the ungrounded ones.
      diagnostics: { ...snapshot.diagnostics!, ungroundedPaths: [['records', 0, 'year']], effectiveMethod, eligibility, support },
    })
    const wire = extractionAttemptSchema.parse(JSON.parse(JSON.stringify(dto)))
    expect(wire.requestedSettings).toEqual({ article: null })
    expect(wire.diagnostics?.effectiveMethod).toEqual(effectiveMethod)
    expect(wire.diagnostics?.eligibility).toEqual(eligibility)
    expect(wire.diagnostics?.support).toEqual(support)
  })

  it('ignores a policy-skipped path outside the claim set instead of failing the read', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const eligibility = { allRecordLeaves: 2, eligibleRecordLeaves: 1, eligibleGrounding: 'complete' as const,
      skipped: [{ resultPath: ['records', 0, 'year'], policy: 'derived' as const }] }
    const read = () => extractionAttemptDto({ ...attemptSnapshot, diagnostics: { ...snapshot.diagnostics!, eligibility } })
    expect(read).not.toThrow()
    expect(read().diagnostics?.grounding?.claims).toMatchObject({ claims: 1, excluded: 0, eligible: 1, supported: 1, unsupported: 0 })
  })

  it('a failed attempt keeps its admitted settings and has no effective method; a historical one reads Not recorded', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const failed = extractionAttemptDto({
      ...attemptSnapshot,
      requestedSettings: { generic: { record_chars: 30_000 } },
      strategy: 'CATALOG', executionStatus: 'FAILED', outcome: null, complete: null, modelAttribution: null,
      diagnostics: null, result: null, evidence: null, reviewable: false,
      failure: { code: 'interrupted', message: 'This work stopped before it finished. Start it again.', phase: 'extracting' },
    })
    expect(failed.diagnostics).toBeNull()
    expect(failed.requestedSettings).toEqual({ generic: { record_chars: 30_000 } })
    const historical = extractionAttemptDto(attemptSnapshot)
    expect(historical.requestedSettings).toBeNull()
    expect(historical.diagnostics).not.toHaveProperty('effectiveMethod')
  })

  it('echoes no Extraction Model Choice as null and transports no per-role models when kei-exp reported none', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const dto = extractionAttemptDto(attemptSnapshot)
    expect(dto.requestedModels).toBeNull()
    expect(dto.diagnostics).not.toHaveProperty('models')
  })

  it('transports kei-exp attribution and service issue codes without filtering diagnostics', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const dto = extractionAttemptDto({
      ...attemptSnapshot,
      modelAttribution: { provider: 'kei-exp', modelId: 'remote-model' },
      diagnostics: {
        ...snapshot.diagnostics!,
        groundingIssues: [{ code: 'missing_value', detail: 'No source value', record: 0, path: ['records', 0, 'year'] }],
        groundingBatches: [],
      },
    })
    expect(dto.modelAttribution).toEqual({ provider: 'kei-exp', modelId: 'remote-model' })
    expect(dto.diagnostics?.grounding?.issueCodes).toEqual(['missing_value'])
  })

  it('reads the contested values back from the stored diagnostics, apart from an ordinary empty value', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const stored = (groundingIssues: Record<string, unknown>[]) => extractionAttemptDto({
      ...attemptSnapshot,
      result: { records: [{ title: 'Alpha', maker: null, year: null }, { title: 'Beta', maker: null, year: null }] },
      diagnostics: { ...snapshot.diagnostics!, groundingIssues, groundingBatches: [] },
    })
    const dto = stored([
      { code: 'conflicting_values', detail: JSON.stringify({ path: ['maker'], candidates: ['Ada', 'Ida'] }), record: 0, path: null },
      { code: 'conflicting_document_values', detail: JSON.stringify({ path: ['year'], candidates: [1901, 1902] }), record: null, path: null },
    ])
    expect(dto.diagnostics?.contested).toEqual([
      { resultPath: ['records', 0, 'maker'], candidates: ['Ada', 'Ida'] },
      { resultPath: ['records', 0, 'year'], candidates: [1901, 1902] },
      { resultPath: ['records', 1, 'year'], candidates: [1901, 1902] },
    ])
    expect(dto.diagnostics?.grounding?.issueCodes).toEqual(['conflicting_values', 'conflicting_document_values'])
    const malformed = stored([{ code: 'conflicting_values', detail: '{', record: 0, path: null }])
    expect(malformed.diagnostics).not.toHaveProperty('contested')
  })

  it('derives the claim accounting from the stored evidence, ungrounded paths and issues', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const dto = extractionAttemptDto({
      ...attemptSnapshot,
      result: { records: [{ title: 'Alpha', year: 1901, scale: 2 }] },
      evidence: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-alpha' }],
      diagnostics: {
        ...attemptSnapshot.diagnostics!,
        ungroundedPaths: [['records', 0, 'year'], ['records', 0, 'scale']],
        groundingIssues: [
          { code: 'grounding_exceeds_budget', detail: 'too big', record: 0, path: ['records', 0, 'year'] },
          { code: 'grounding_exceeds_budget', detail: 'too big again', record: 0, path: ['records', 0, 'year'] },
        ],
      },
    })
    expect(dto.diagnostics?.grounding?.claims).toEqual({
      claims: 3, excluded: 0, eligible: 3, supported: 1, unsupported: 1, notCompleted: 1,
      reasons: { grounding_exceeds_budget: 1 }, excludedPolicies: {},
      unfinished: [{ resultPath: ['records', 0, 'year'], reasons: ['grounding_exceeds_budget'] }],
    })
  })

  it('a generic Catalog attempt whose record-level call failed without a path reports that record\'s ungrounded claims not completed', async () => {
    const { extractionAttemptDto } = await import('./_extractions.js')
    const dto = extractionAttemptDto({
      ...attemptSnapshot,
      strategy: 'CATALOG',
      result: { records: [{ title: 'Alpha', year: 1901, scale: 2 }] },
      evidence: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-alpha' }],
      diagnostics: {
        ...attemptSnapshot.diagnostics!,
        ungroundedPaths: [['records', 0, 'year'], ['records', 0, 'scale']],
        groundingIssues: [{ code: 'call_failed', detail: 'the grounding call failed', record: 0 }],
        catalog: null,
      },
    })
    const claims = dto.diagnostics?.grounding?.claims
    expect(claims?.notCompleted).toBe(2)
    expect(claims?.unsupported).toBe(0)
    expect(claims?.reasons).toEqual({ call_failed_unattributed: 2 })
  })
})
