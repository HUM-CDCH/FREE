import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { keiExpPageSchema, parsedDocumentFromKeiExp } from '../../../prototypes/studio/api/_kei_exp.js'
import measuredTable from '../../../prototypes/studio/test/fixtures/kei-exp/ellekilde-table-v5.json' with { type: 'json' }
import parsedDocument from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with { type: 'json' }
import { ExtractionError } from './errors.js'
import { acceptKeiArtifact, type ArtifactPins, type KeiExpArtifact } from './kei-artifact.js'
import { keiExpArtifact, keiExpCall, keiExpEvidence, keiExpGroundedArtifact } from './kei-exp-fixture.js'
import type { KeiExtractInput } from './kei-handoff.js'
import { decodeParsedDocument, type ParsedDocument } from './parsed-document.js'
import type { ExtractionModelChoice } from './types.js'

const schema = {
  recordDescription: 'Article records.',
  schemaNodes: [{ id: 'title', name: 'title', type: 'string' as const }, { id: 'year', name: 'year', type: 'integer' as const }],
}
const runId = parsedDocument.document.document_id
const issues = [{ code: 'missing_value', detail: 'No year', record: 0, path: ['records', 0, 'year'] }]
function artifact(overrides: Partial<KeiExpArtifact> = {}): KeiExpArtifact {
  return keiExpArtifact({
    run_id: runId, strategy: 'article', model: 'selected-model', schema,
    options: { strategy: 'article', model: 'selected-model', discovery_chars: 48_000, record_chars: 24_000 },
    records: [{ title: 'Alpha', year: null }],
    evidence: [keiExpEvidence()],
    issues,
    calls: [keiExpCall({ stage: 'document', record: null }), keiExpCall({ stage: 'record' }), keiExpCall({ stage: 'grounding' })],
    tokens: { input: 20, output: 10 },
    ...overrides,
  })
}

type Run = {
  strategy?: 'ARTICLE' | 'CATALOG'
  recipe?: string | null
  models?: ExtractionModelChoice | null
  generation?: string
  document?: ParsedDocument
  batchExtractionId?: string | null
  /** Method options the request adds: an explicit `article`, generic Catalog limits. */
  settings?: Record<string, unknown>
}
/** kei's extract request as runExtraction builds it: `models` and `catalog` only when chosen. */
function request({ strategy = 'ARTICLE', recipe = null, models = null, generation = 'g1', settings = {} }: Run = {}): KeiExtractInput {
  return {
    run_id: runId, generation,
    request: {
      schema,
      options: {
        strategy: strategy === 'CATALOG' ? 'catalog' : 'article',
        ...(models === null ? {} : { models }),
        ...(recipe === null ? {} : { catalog: { recipe } }),
        ...settings,
      },
    },
  }
}
const document = decodeParsedDocument(parsedDocument)
function accept(raw: unknown, run: Run = {}) {
  const pins: ArtifactPins = {
    extractionId: randomUUID(), sourceDocumentId: 'source', sourceRepresentationRevisionId: randomUUID(),
    schemaRevisionId: randomUUID(), strategy: run.strategy ?? 'ARTICLE', batchExtractionId: run.batchExtractionId ?? null,
  }
  return { pins, extraction: acceptKeiArtifact(pins, run.document ?? document, raw, request(run)) }
}
const refused = (run: () => unknown, code = 'invalid_model_output') =>
  assert.throws(run, (error: unknown) => error instanceof ExtractionError && error.code === code)

describe('kei artifact acceptance', () => {
  it('retains policy-skipped paths and reasons without manufacturing evidence', () => {
    const policySchema = { ...schema, schemaNodes: schema.schemaNodes.map(node => ({
      ...node, evidencePolicy: 'derived',
    })) }
    const skipped = { code: 'evidence_policy_skipped', detail: 'derived: source verification not requested',
      record: 0, path: ['records', 0, 'title'] }
    const raw = artifact({ schema: policySchema, records: [{ title: 'reported' }],
      evidence: [], ungrounded: [skipped.path], issues: [skipped] })
    const input = request()
    input.request.schema = policySchema
    const { pins } = accept(artifact())
    const result = acceptKeiArtifact(pins, document, raw, input)
    assert.equal(result.complete, false)
    assert.deepEqual(result.evidence, [])
    assert.deepEqual(result.diagnostics?.ungroundedPaths, [skipped.path])
    assert.deepEqual(result.diagnostics?.groundingIssues, [skipped])
  })

  it('maps artifact evidence, completeness, diagnostics and attribution onto the pinned Extraction', () => {
    const { pins, extraction: result } = accept(artifact())
    assert.equal(result.extractionId, pins.extractionId)
    assert.equal(result.sourceDocumentId, 'source')
    assert.equal(result.sourceRepresentationRevisionId, pins.sourceRepresentationRevisionId)
    assert.equal(result.schemaRevisionId, pins.schemaRevisionId)
    assert.equal(result.strategy, 'ARTICLE')
    assert.deepEqual(result.result, { records: [{ title: 'Alpha', year: null }] })
    assert.deepEqual(result.evidence, [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_p1_s0', verbatim: true, lexicalHits: 1, linkedBy: 'lexical' }])
    assert.equal(result.complete, false)
    assert.equal(result.reviewable, true)
    assert.equal(result.outcome, 'SUCCEEDED')
    assert.equal(result.failure, null)
    assert.equal(result.batchExtractionId, null)
    assert.deepEqual(result.modelAttribution, { provider: 'kei-exp', modelId: 'selected-model' })
    assert.deepEqual(result.diagnostics, { phase: 'persisting', durationMs: 1250, modelCalls: 3, inputTokens: 20, outputTokens: 10, finishReason: null, ungroundedPaths: [], groundingIssues: issues, groundingBatches: [], unverifiedFields: [], catalog: null, models: { fields: 'selected-model', reasoning: 'selected-model' },
      effectiveMethod: { options: artifact().options, versions: { prompt: 1 } }, eligibility: null, support: null })
  })

  it('maps the version 2 artifact of a Catalog recipe without dropping what review needs', () => {
    const base = keiExpGroundedArtifact({ run_id: runId, model: 'selected-model', schema })
    // A glossary expansion travels beside the raw value, spans renamed to the client's casing.
    const glossary = { value: 'Heidekreis', rule: 'glossary' as const, key_span: { segment: 'p1_s0', start: 0, end: 5 },
                       expansion_span: { segment: 'p1_s0', start: 8, end: 18 } }
    const grounded = { ...base, evidence: base.evidence.map(link =>
      link.path[2] === 'kreis' ? { ...link, normalized: glossary } : link) }
    const { extraction: result } = accept(grounded, { strategy: 'CATALOG', recipe: 'numbered-catalogue-de@1' })
    assert.deepEqual(result.result, { records: grounded.records })
    assert.equal(result.complete, false)
    const sheet = result.evidence!.find((link) => link.resultPath[2] === 'mbl_old')!
    assert.equal(sheet.evidenceAnchorId, 'a_p1_s2')
    assert.deepEqual(sheet.grounding, {
      linkedBy: 'key', provenance: 'token', textSpans: [{ segment: 'p1_s2', start: 28, end: 32 }],
      keySpans: [{ segment: 'p1_s2', start: 23, end: 27 }], alternatives: [], heading: null, precision: 'segment',
      raw: '1827', normalized: null,
    })
    const kreis = result.evidence!.find((link) => link.resultPath[2] === 'kreis')!
    assert.equal(kreis.grounding!.provenance, 'inherited')
    assert.deepEqual(kreis.grounding!.normalized, { value: 'Heidekreis', rule: 'glossary',
      keySpan: { segment: 'p1_s0', start: 0, end: 5 }, expansionSpan: { segment: 'p1_s0', start: 8, end: 18 } })
    assert.equal(kreis.evidenceAnchorId, 'a_p1_s1')
    const report = result.diagnostics.grounded!
    assert.equal(report.recipe, 'numbered-catalogue-de@1')
    assert.deepEqual(report.completeness, grounded.completeness)
    assert.deepEqual(report.normalization, { version: 1, rules: ['glossary'] })
    assert.deepEqual(report.segmentationDiagnostics, grounded.segmentation.diagnostics)
    assert.deepEqual(report.coverage, grounded.coverage)
    assert.deepEqual(report.proposed, grounded.proposed)
    assert.deepEqual(report.rejected, grounded.rejected)
    assert.deepEqual(report.recordBlocks, grounded.record_blocks)
    assert.deepEqual(result.diagnostics.ungroundedPaths, [])
  })

  it('refuses a version 2 artifact produced under another recipe than the one requested', () => {
    const other = keiExpGroundedArtifact({
      run_id: runId, model: 'selected-model', schema,
      segmentation: { ...keiExpGroundedArtifact().segmentation, recipe: { ...keiExpGroundedArtifact().segmentation.recipe, version: 2 } },
    })
    refused(() => accept(other, { strategy: 'CATALOG', recipe: 'numbered-catalogue-de@1' }))
    // A generic Catalog request never accepts a recipe's artifact, and a recipe's request never a generic one.
    refused(() => accept(keiExpGroundedArtifact({ run_id: runId, model: 'selected-model', schema }), { strategy: 'CATALOG' }))
    refused(() => accept(artifact({ strategy: 'catalog' }), { strategy: 'CATALOG', recipe: 'numbered-catalogue-de@1' }))
  })

  it('relays catalog, zero/multiple records, ungrounded paths and model-linked evidence', () => {
    for (const records of [[], [{ title: 'A', year: 1901 }, { title: 'B', year: null }]]) {
      const value = artifact({ strategy: 'catalog', complete: true, records, evidence: [], ungrounded: records.length ? [['records', 0, 'title']] : [] })
      const { extraction: result } = accept(value, { strategy: 'CATALOG' })
      assert.equal(result.strategy, 'CATALOG')
      assert.deepEqual(result.result, { records })
      assert.deepEqual(result.diagnostics.ungroundedPaths, value.ungrounded)
      assert.deepEqual(result.modelAttribution, { provider: 'kei-exp', modelId: 'selected-model' })
      assert.equal(result.complete, true)
    }
    const value = artifact({ evidence: [keiExpEvidence({ linked_by: 'model' })] })
    assert.equal(accept(value).extraction.evidence![0].linkedBy, undefined)
  })

  it('counts model calls and tolerates a model server that reports no token usage', () => {
    const value = artifact({ calls: [keiExpCall({ input_tokens: null, output_tokens: null, finish: null })], tokens: { input: null, output: null } })
    const { diagnostics } = accept(value).extraction
    assert.equal(diagnostics.modelCalls, 1)
    assert.equal(diagnostics.inputTokens, null)
    assert.equal(diagnostics.outputTokens, null)
  })

  it('refuses an artifact outside kei\'s schema', () => {
    for (const value of [{}, null, 'artifact', { nonsense: true }, { ...artifact(), extraction_version: 3 }, { ...artifact(), records: 'none' }])
      refused(() => accept(value))
  })

  it('refuses an artifact produced for other inputs', () => {
    for (const value of [
      artifact({ run_id: 'other' }),
      artifact({ generation: 'other' }),
      artifact({ strategy: 'catalog' }),
      artifact({ schema: { ...schema, recordDescription: 'Other schema' } }),
      artifact({ options: { strategy: 'article', model: null, models: { fields: 'nuextract' } } }),
    ]) refused(() => accept(value))
    // The same artifact against a request for another generation, strategy, recipe or model choice.
    refused(() => accept(artifact(), { generation: 'g2' }))
    refused(() => accept(artifact(), { strategy: 'CATALOG' }))
    refused(() => accept(artifact(), { models: { fields: 'nuextract' } }))
  })

  it('rejects results without model attribution before they can become unreadable saved results', () => {
    for (const model of [null, '', undefined]) refused(() => accept({ ...artifact(), model }))
  })

  it('records the model each role ran on and attributes the result to the fields model', () => {
    const models = { fields: 'selected-model', reasoning: 'reasoning-model' }
    const value = artifact({ models, options: { strategy: 'article', model: null, models: { reasoning: 'instruct' } } })
    const { extraction: result } = accept(value, { models: { reasoning: 'instruct' } })
    // Attribution stays the model that read the values: the fields model.
    assert.deepEqual(result.modelAttribution, { provider: 'kei-exp', modelId: 'selected-model' })
    assert.deepEqual(result.diagnostics.models, models)
  })

  it('accepts a batch member\'s artifact under its model choice or the deployment defaults', () => {
    for (const models of [null, { fields: 'nuextract', reasoning: 'instruct' }, { reasoning: 'instruct' }]) {
      const value = artifact({ options: { strategy: 'article', model: null, models } })
      const { extraction: result } = accept(value, { models, batchExtractionId: 'batch' })
      assert.equal(result.batchExtractionId, 'batch')
    }
    // kei dumps an unchosen run's `models` as null, or leaves it out.
    accept(artifact({ options: { strategy: 'article' } }))
  })

  it('refuses an artifact produced under another Extraction Model Choice than the one requested', () => {
    for (const recorded of [null, { fields: 'instruct' }, { fields: 'nuextract', reasoning: 'instruct' }]) {
      const value = artifact({ options: { strategy: 'article', model: null, models: recorded } })
      refused(() => accept(value, { models: { fields: 'nuextract' } }))
    }
    refused(() => accept(artifact({ options: { strategy: 'article', model: null, models: { fields: 'nuextract' } } })))
  })

  it('refuses an artifact that does not record every requested method option', () => {
    const article = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
    const withArticle = (recorded: unknown) => artifact({ options: { strategy: 'article', model: 'selected-model', discovery_chars: 48_000, record_chars: 24_000, ...(recorded ? { article: recorded } : {}) } })
    assert.doesNotThrow(() => accept(withArticle(article), { settings: { article } }))
    refused(() => accept(withArticle({ ...article, grounding: 'quoted' }), { settings: { article } }))
    refused(() => accept(withArticle(null), { settings: { article } }))
    // An explicit Article the request never asked for is another request's artifact.
    refused(() => accept(withArticle(article)))
    refused(() => accept(artifact({ options: { strategy: 'catalog', model: null, discovery_chars: 48_000, record_chars: 24_000 }, strategy: 'catalog' }),
      { strategy: 'CATALOG', settings: { record_chars: 30_000 } }))
  })

  it('rejects an artifact that does not name the model of each role', () => {
    for (const models of [undefined, null, { fields: 'selected-model' }, { fields: '', reasoning: 'r' }])
      refused(() => accept({ ...artifact(), models }))
  })

  it('relays the document-level field names kei-exp could not verify', () => {
    assert.deepEqual(accept(artifact({ unverified: ['archive'] })).extraction.diagnostics.unverifiedFields, ['archive'])
  })

  it('keeps batch identity', () => {
    assert.equal(accept(artifact(), { batchExtractionId: 'batch' }).extraction.batchExtractionId, 'batch')
  })

  it('resolves cell references in both extraction wire formats and rejects a cell absent from the pinned revision', () => {
    const manifest = { result_version: 5 as const, generation: 'g1', recipe: { source_sha256: 'a'.repeat(64), transcriber: 'native' },
      page_count: 1, started: null, seconds: 0, status: 'success' as const, incomplete: null, pages: { '1': { sha256: 'b'.repeat(64), complete: true } } }
    const page = { generation: 'g1', page: 1, size_pt: measuredTable.size_pt as [number, number],
      segments: [measuredTable.segment], complete: true, warnings: [] }
    const translated = parsedDocumentFromKeiExp(runId, manifest, [keiExpPageSchema.parse(page)],
      { sha256: 'a'.repeat(64), originalFilename: 'table.pdf', byteSize: 1 }, new Date())
    const table = decodeParsedDocument(translated.document)
    const generic = artifact({ generation: 'g1', evidence: [keiExpEvidence({ cell: 'r1_c0', precision: 'cell' })] })
    assert.equal(accept(generic, { document: table }).extraction.evidence?.[0].evidenceAnchorId, 'a_p1_s0_r1_c0')
    const grounded = keiExpGroundedArtifact({ run_id: runId, model: 'selected-model', schema, generation: 'g1' })
    grounded.evidence = grounded.evidence.slice(0, 1).map(link => ({ ...link, segment: 'p1_s0', page: 1, cell: 'r1_c0', precision: 'cell' }))
    const groundedResult = accept(grounded, { strategy: 'CATALOG', recipe: 'numbered-catalogue-de@1', document: table }).extraction
    assert.equal(groundedResult.evidence?.[0].evidenceAnchorId, 'a_p1_s0_r1_c0')
    assert.equal(groundedResult.evidence?.[0].grounding?.precision, 'cell')
    // Table-cell anchors must belong to the pinned representation: another cell, or the right cell on another page.
    refused(() => accept({ ...generic, evidence: [keiExpEvidence({ cell: 'r99_c99', precision: 'cell' })] }, { document: table }))
    refused(() => accept({ ...generic, evidence: [keiExpEvidence({ cell: 'r1_c0', precision: 'cell', page: 2 })] }, { document: table }))
    // A representation with no tables has no cell to name.
    refused(() => accept(generic))
  })
})

describe('what the Parsing Service reports it ran', () => {
  const article = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
    prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
  const options = { strategy: 'article', model: 'selected-model', discovery_chars: 48_000, record_chars: 24_000, article }

  it('keeps the recorded options and every protocol version the artifact reports', () => {
    const raw = { ...artifact({ options, prompt_version: 12 }), method_version: 1, span_grounding_version: 2 }
    const { extraction } = accept(raw, { settings: { article } })
    assert.deepEqual(extraction.diagnostics.effectiveMethod, { options, versions: { prompt: 12, method: 1, spanGrounding: 2 } })
  })

  it('keeps policy-skipped values, their reasons and the separate denominators; nothing eligible is not applicable', () => {
    const skipped = [{ path: ['records', 0, 'title'], policy: 'derived' }, { path: ['records', 0, 'year'], policy: 'unverified' }]
    const raw = { ...artifact({ options, evidence: [], ungrounded: [['records', 0, 'title'], ['records', 0, 'year']] }),
      method_version: 1, grounding_eligibility: { all_record_leaves: 2, eligible_record_leaves: 0, skipped },
      completion: { processing: true, grounding: 'partial', eligible_grounding: 'not_applicable' } }
    const { extraction } = accept(raw, { settings: { article } })
    assert.deepEqual(extraction.diagnostics.eligibility, {
      allRecordLeaves: 2, eligibleRecordLeaves: 0, eligibleGrounding: 'not_applicable',
      skipped: [{ resultPath: ['records', 0, 'title'], policy: 'derived' }, { resultPath: ['records', 0, 'year'], policy: 'unverified' }],
    })
    assert.deepEqual(extraction.evidence, [])
    assert.deepEqual(extraction.diagnostics.ungroundedPaths, [['records', 0, 'title'], ['records', 0, 'year']])
    assert.equal(extraction.complete, false)
  })

  it('keeps exact code-point ranges and never upgrades coarse geometry', () => {
    const proof = { path: ['records', 0, 'title'], segment: 'p1_s0', cell: null, span: 'p1_s0@3:9', start: 3, end: 9,
      quote: 'Ålpha 🜁', attribution: 'model_attested' }
    const raw = { ...artifact({ options, evidence: [keiExpEvidence({ precision: 'segment' })] }), method_version: 1, span_grounding_version: 2,
      quoted_support: [proof] }
    const { extraction } = accept(raw, { settings: { article } })
    assert.deepEqual(extraction.diagnostics.support, [{ resultPath: proof.path, segment: 'p1_s0', cell: null, span: 'p1_s0@3:9',
      start: 3, end: 9, quote: 'Ålpha 🜁', attribution: 'model_attested' }])
    assert.equal(extraction.evidence?.[0]?.precision, 'segment')
  })

  it('a proof without an accepted link creates no Evidence; refusals and NONE stay visible as issues', () => {
    const refusals = [
      { code: 'unknown_label', detail: 'year was linked to "E9", which was not offered', record: 0, path: ['records', 0, 'year'] },
      { code: 'grounding_exceeds_budget', detail: 'one unit does not fit', record: 0, path: ['records', 0, 'title'] },
    ]
    const raw = { ...artifact({ options, evidence: [], issues: refusals, ungrounded: [['records', 0, 'title'], ['records', 0, 'year']] }),
      method_version: 1, quoted_support: [{ path: ['records', 0, 'year'], segment: 'p1_s1', cell: null, quote: '1827', attribution: 'model_attested' }] }
    const { extraction } = accept(raw, { settings: { article } })
    assert.deepEqual(extraction.evidence, [])
    assert.deepEqual(extraction.diagnostics.groundingIssues.map((issue) => issue.code), ['unknown_label', 'grounding_exceeds_budget'])
  })

  it('a reference run reports no Article method; a recipe run with verification off keeps typed proposals, not links', () => {
    assert.deepEqual(accept(artifact({ prompt_version: 12 })).extraction.diagnostics.effectiveMethod?.versions, { prompt: 12 })
    const proposed = [{ path: ['records', 0, 'title'], value: 'Alpha', quote: 'Alpha', key: null, provenance: 'token', spans: [], alternatives: [], window: 0, reason: 'verification_disabled' }]
    const grounded = keiExpGroundedArtifact({ run_id: runId, model: 'selected-model', schema,
      proposed, evidence: [], completeness: { processing: true, coverage: true, grounding: false, recall: 'unmeasured' } })
    const { extraction } = accept(grounded, { strategy: 'CATALOG', recipe: `${grounded.segmentation.recipe.id}@${grounded.segmentation.recipe.version}` })
    assert.deepEqual(extraction.diagnostics.grounded?.proposed, proposed)
    assert.equal(extraction.diagnostics.grounded?.completeness.grounding, false)
    assert.deepEqual(extraction.evidence, [])
  })
})
