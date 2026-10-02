import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { TerminalExtraction } from './dependencies.js'
import { ExtractionError } from './errors.js'
import type { KeiExtractInput } from './kei-handoff.js'
import type { ParsedDocument } from './parsed-document.js'
import { refuseRecordCardinality } from './record-scope.js'
import { recordScopeSchema } from './schema.js'
import type { ExtractionStrategy } from './types.js'

const path = z.array(z.union([z.string(), z.number().int().nonnegative()]))
/** One model call, as the Parsing Service's `kie/extract/calls.py` `Call` is written into the artifact. */
const callSchema = z.object({
  stage: z.string(),
  record: z.number().int().nullable(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  seconds: z.number().nonnegative(),
  finish: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
})
/** One grounded value's evidence: kei-exp's `Link`, with `path` and `bbox_pt` as lists. */
const evidenceSchema = z.object({
  path,
  segment: z.string().regex(/^p\d+_s\d+$/),
  page: z.number().int().positive(),
  bbox_pt: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  verbatim: z.boolean(),
  hits: z.number().int().nonnegative(),
  linked_by: z.enum(['lexical', 'model']),
  cell: z
    .string()
    .regex(/^r\d+_c\d+$/)
    .nullable()
    .optional(),
  precision: z.enum(['cell', 'segment', 'input']).optional(),
})
/** The dict kei-exp's `kie/extract/run.py` `extract()` returns, field by field. */
const artifactSchema = z.object({
  extraction_version: z.number().int().positive(),
  run_id: z.string().min(1),
  // The parse manifest's generation is a minted string, not a counter (kei-exp `pagefile.Result`).
  generation: z.string().min(1),
  digest: z.string(),
  fingerprint: z.string(),
  strategy: z.enum(['catalog', 'article']),
  // The fields model's repo id: the model that read the values, and the one attribution names.
  model: z.string().min(1),
  // The repo id each role ran on (`kie/extract/models.py` `Router.models`): the run's choice over the deployment defaults.
  models: z.object({ fields: z.string().min(1), reasoning: z.string().min(1) }),
  // kei-exp writes its `PROMPT_VERSION`: a number, not a label.
  prompt_version: z.number().int(),
  // The schema kei-exp ran: the request's, echoed with its record scope (absent only in an artifact of an older run).
  schema: z.object({ recordDescription: z.string(), recordScope: recordScopeSchema.optional(), schemaNodes: z.array(z.unknown()) }),
  options: z.record(z.string(), z.unknown()),
  started: z.string(),
  seconds: z.number().nonnegative(),
  complete: z.boolean(),
  records: z.array(z.record(z.string(), z.unknown())),
  evidence: z.array(evidenceSchema),
  ungrounded: z.array(path),
  // The names of the document-level fields (`valueSource: document`): extracted into every
  // record, never grounded and never listed under `ungrounded`.
  unverified: z.array(z.string()),
  issues: z.array(z.object({ code: z.string(), detail: z.string(), record: z.number().int().nullable(), path: path.nullable() })),
  // One object per model call, not a count.
  calls: z.array(callSchema),
  // Null when no call reported usage (kei-exp's `_total()`).
  tokens: z.object({ input: z.number().int().nullable(), output: z.number().int().nullable() }),
  // An explicit Article method records its method and protocol versions and its evidence accounting; the reference
  // artifact (no `options.article`) carries none of them.
  method_version: z.number().int().optional(),
  span_grounding_version: z.number().int().optional(),
  grounding_routing_version: z.number().int().optional(),
  rendering_version: z.number().int().optional(),
  grouping_version: z.number().int().optional(),
  selection_version: z.number().int().optional(),
  completion: z.object({ eligible_grounding: z.enum(['complete', 'partial', 'not_applicable']).optional() }).optional(),
  grounding_eligibility: z.object({
    all_record_leaves: z.number().int().nonnegative(),
    eligible_record_leaves: z.number().int().nonnegative(),
    skipped: z.array(z.object({ path, policy: z.enum(['derived', 'unverified']) })),
  }).optional(),
  // The quote or offered source span each accepted link was verified with; code-point offsets into its segment.
  quoted_support: z.array(z.object({
    path, segment: z.string(), cell: z.string().nullable(), quote: z.string(), attribution: z.string(),
    span: z.string().optional(), start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(),
  })).optional(),
})
const span = z.object({ segment: z.string().regex(/^p\d+_s\d+$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })
/** Version 2 evidence (`kie/extract/grounded.py` `_link`): the version 1 link plus the raw code-point spans of the value,
 *  its key, its provenance and alternatives, and the precision its box can claim. */
const groundedEvidenceSchema = evidenceSchema.extend({
  linked_by: z.enum(['key', 'structure']),
  spans: z.array(span).min(1),
  alternatives: z.array(z.array(span)),
  provenance: z.enum(['token', 'positional', 'inherited']),
  key_spans: z.array(span),
  heading: z.string().nullable(),
  precision: z.enum(['cell', 'segment', 'input']),
  raw: z.string(),
  // The document's own glossary expansion of the raw value, which the record keeps unchanged.
  normalized: z.object({ value: z.string(), rule: z.literal('glossary'), key_span: span, expansion_span: span }).nullable(),
})
/** A proposed or rejected candidate kept for review: never part of the accepted record. */
const candidateSchema = z.object({
  path: z.array(z.union([z.string(), z.number().int().nonnegative(), z.null()])),
  value: z.unknown(),
  quote: z.string().nullable(),
  key: z.string().nullable(),
  provenance: z.string().nullable(),
  spans: z.array(span),
  alternatives: z.array(z.array(span)),
  window: z.number().int().nonnegative(),
  reason: z.string().optional(),
  raw: z.string().optional(),
})
const coverageSchema = z.object({
  complete: z.boolean(), lines: z.number().int().nonnegative(), entries: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(), roles: z.record(z.string(), z.number().int()),
  excluded: z.record(z.string(), z.number().int()), potential_duplicates: z.number().int().nonnegative(),
  reading_order_issues: z.number().int().nonnegative(),
  withheld_intentional: z.array(z.string()), withheld_failures: z.array(z.string()),
})
/** The dict kei-exp's recipe path returns: version 2, discriminated from version 1 by `extraction_version`. */
export const groundedArtifactSchema = artifactSchema.extend({
  extraction_version: z.literal(2),
  strategy: z.literal('catalog'),
  evidence: z.array(groundedEvidenceSchema),
  segmentation: z.object({
    fingerprint: z.string(), digest: z.string(),
    recipe: z.object({ id: z.string().min(1), version: z.number().int().positive(), structure_sha256: z.string(), bindings_sha256: z.string() }),
    bindings: z.record(z.string(), z.string()),
    bindings_unmatched: z.array(z.string()),
    diagnostics: z.array(z.object({ code: z.string(), detail: z.string(), block: z.string().nullable(), spans: z.array(span) })),
  }),
  budget: z.object({
    version: z.number().int().positive(), input_tokens: z.number().int().positive(), output_tokens: z.number().int().positive(),
    tokenizer: z.object({ source: z.string(), model: z.string(), model_digest: z.string().nullable(), template_tokens: z.number().int().nullable() }),
    // One tokenizer identity per role, since the roles may be served apart; `tokenizer` is the fields role's.
    tokenizers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }),
  normalization: z.object({ version: z.number().int().positive(), rules: z.array(z.literal('glossary')) }),
  record_blocks: z.array(z.object({ block: z.string(), entry_label: z.string() })),
  proposed: z.array(candidateSchema),
  rejected: z.array(candidateSchema),
  competitors: z.array(z.object({ path: z.array(z.union([z.string(), z.number().int()])), candidates: z.array(z.object({ value: z.unknown(), spans: z.array(span), window: z.number().int() })), outcome: z.enum(['arbitrated', 'unresolved']) })),
  coverage: coverageSchema,
  completeness: z.object({ processing: z.boolean(), coverage: z.boolean(), grounding: z.boolean(), recall: z.literal('unmeasured') }),
})
export const versionOneSchema = artifactSchema.extend({ extraction_version: z.literal(1) })

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative()
const candidatePath = z.array(z.union([z.string(), z.number().int().nonnegative(), z.null()]))
/** Version 3 evidence (`kie/extract/unified.py` `_link`): a verified value, its literal span or the passage that
 *  supports a yes/no, a label or a derived value, and the occurrence of the list item it belongs to. */
const unifiedEvidenceSchema = evidenceSchema.extend({
  linked_by: z.literal('verification'),
  support: z.enum(['literal', 'supporting']),
  spans: z.array(span).min(1),
  alternatives: z.array(z.array(span)),
  precision: z.enum(['cell', 'segment', 'input']),
  raw: z.string(),
  item: z.array(span).nullable(),
})
/** A version 3 candidate kept for review: proposed (unverified, a partial list item, a competing value...) or rejected. */
const unifiedCandidateSchema = z.object({
  path: candidatePath, value: z.unknown(), quote: z.string().nullable(), support: z.enum(['literal', 'supporting']).nullable(),
  spans: z.array(span), alternatives: z.array(z.array(span)), window: count, reason: z.string().nullable(),
  raw: z.string().nullable(), item: z.object({ window: count, index: count }).nullable(),
})
/** The execution record (`catalog-execution.json`): read for its pins; its digest is taken over the raw record. */
const executionRecordSchema = z.object({
  version: z.literal(1), extraction_id: z.string().nullable(),
  source: z.object({ run_id: z.string(), generation: z.string(), digest: z.string() }),
  schema_sha256: sha256Hex, method: z.record(z.string(), z.unknown()),
  effective: z.object({
    overlap: count, headings: z.boolean(), verification: z.boolean(), splits: count,
    stages: z.record(z.string(), z.object({ role: z.enum(['fields', 'reasoning']), input_tokens: count, output_tokens: count })),
  }),
  models: z.object({ fields: z.string(), reasoning: z.string() }),
})
/** The discovery record (`catalog-discovery.json`): entries, the source ledger and the windows that produced them. */
const discoveryRecordSchema = z.object({
  // Version 2 ends a record cut by the end of the supplied source as `source_end`; version 1 called it `beyond_scope`.
  // Version 3 leaves that end `unresolved` when nonblank withheld text follows the record.
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]), execution_sha256: sha256Hex,
  entries: z.array(z.object({
    id: z.string(), label: z.string().nullable(), ranges: z.array(span), context: z.array(span),
    end: z.enum(['validated', 'unresolved', 'beyond_scope', 'source_end']),
  })),
  ledger: z.array(span.extend({ disposition: z.enum(['entry', 'other', 'unresolved', 'withheld']), entry: z.string().nullable() })),
  windows: z.array(z.object({ ok: z.boolean() })),
})
/** The dict the unified Catalog returns (`unified.extract`): version 3, with its records embedded and digested. */
export const unifiedArtifactSchema = artifactSchema.extend({
  extraction_version: z.literal(3),
  strategy: z.literal('catalog'),
  evidence: z.array(unifiedEvidenceSchema),
  execution: executionRecordSchema, execution_sha256: sha256Hex,
  discovery: discoveryRecordSchema, discovery_sha256: sha256Hex,
  proposed: z.array(unifiedCandidateSchema),
  rejected: z.array(unifiedCandidateSchema),
  competitors: z.array(z.object({
    path, outcome: z.enum(['arbitrated', 'unresolved']), chosen: count.nullable(),
    candidates: z.array(z.object({ value: z.unknown(), spans: z.array(span), window: count })),
  })),
  items: z.array(z.object({ path, observed: count, resolved: count, partial: count })),
  document: z.object({
    status: z.literal('unverified'), applicable: z.boolean(), candidates: z.array(unifiedCandidateSchema),
    conflicts: z.array(z.object({ path, candidates: z.array(z.unknown()) })),
  }),
  context_omitted: z.array(span.extend({ stage: z.string(), record: z.number().int().nullable(), kind: z.enum(['heading', 'before', 'after']) })),
  processing: z.object({
    discovery: z.object({ windows: count, failed: count }),
    entries: z.object({ entries: count, windows: count, failed: count }),
    verification: z.object({ enabled: z.boolean(), undecided: count }),
    document: z.object({ applicable: z.boolean(), windows: count, failed: count }),
  }),
  completeness: z.object({
    accounting: z.boolean(), boundaries: z.boolean(), processing: z.boolean(), evidence: z.boolean(), recall: z.literal('unmeasured'),
  }),
})
export const anyArtifactSchema = z.discriminatedUnion('extraction_version', [versionOneSchema, groundedArtifactSchema, unifiedArtifactSchema])

/** Python's `canonical_json` for the records' shape (no floats; ASCII keys): keys sorted, no whitespace, text as text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const digestOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex')

/** A version 1 artifact: Article, and Catalog without a recipe. */
export type KeiExpArtifact = z.infer<typeof versionOneSchema>
export type KeiExpGroundedArtifact = z.infer<typeof groundedArtifactSchema>
export type KeiExpGroundedEvidence = z.infer<typeof groundedEvidenceSchema>
export type KeiExpUnifiedArtifact = z.infer<typeof unifiedArtifactSchema>
export type KeiExpAnyArtifact = z.infer<typeof anyArtifactSchema>
export type KeiExpCall = z.infer<typeof callSchema>
export type KeiExpEvidence = z.infer<typeof evidenceSchema>

/** kei-exp records the options it ran under (`Options.dumped()`): every method option Studio sent must be there with
 *  the same value, and an explicit Article method on one side only is another Extraction's artifact. Options Studio
 *  left to the service may be recorded with their defaults. */
function honorsRequestedOptions(recorded: Readonly<Record<string, unknown>>, requested: Readonly<Record<string, unknown>>): boolean {
  if (!isDeepStrictEqual(recorded.article ?? null, requested.article ?? null) ||
      !isDeepStrictEqual(recorded.pages ?? null, requested.pages ?? null)) return false
  const { strategy: _strategy, models: _models, article: _article, catalog, ...limits } = requested
  if (!Object.entries(limits).every(([key, value]) => isDeepStrictEqual(recorded[key], value))) return false
  if (catalog === null || typeof catalog !== 'object') return true
  const recordedCatalog = (recorded.catalog ?? {}) as Record<string, unknown>
  return Object.entries(catalog).every(([key, value]) => key === 'recipe' || isDeepStrictEqual(recordedCatalog[key], value))
}

/** The admitted identity an accepted artifact is published under. */
export type ArtifactPins = Readonly<{
  extractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  batchExtractionId: string | null
}>

/**
 * kei's extraction artifact as the Extraction it completes, or `ExtractionError` when it is not one: outside kei's
 * schema, produced for other inputs than `request` (another run, generation, strategy, schema and record scope, recipe
 * or model choice), holding another number of root records than its record scope allows (a document scope is exactly
 * one), or naming a table cell the pinned representation does not have. Pure: the caller reads the bytes, the
 * pinned document and the request, and publishes the result.
 */
export function acceptKeiArtifact(pins: ArtifactPins, document: ParsedDocument, raw: unknown, request: KeiExtractInput): TerminalExtraction {
  const parsed = anyArtifactSchema.safeParse(raw)
  if (!parsed.success) throw new ExtractionError('invalid_model_output', 'kei-exp returned an invalid extraction artifact.')
  const artifact = parsed.data
  const { options } = request.request
  const catalog = options.catalog
  const requestedRecipe = catalog !== null && typeof catalog === 'object' && typeof (catalog as { recipe?: unknown }).recipe === 'string'
    ? (catalog as { recipe: string }).recipe
    : null
  const producedRecipe = artifact.extraction_version === 2
    ? `${artifact.segmentation.recipe.id}@${artifact.segmentation.recipe.version}`
    : null
  // kei-exp records the options it ran under; `models` is null or absent in an artifact of a run that chose none.
  if (
    artifact.run_id !== request.run_id || artifact.generation !== request.generation ||
    artifact.strategy !== options.strategy || !isDeepStrictEqual(artifact.schema, request.request.schema) ||
    producedRecipe !== requestedRecipe || !isDeepStrictEqual(artifact.options.models ?? null, options.models ?? null) ||
    !honorsRequestedOptions(artifact.options, options) ||
    // Only a unified request is answered by a version 3 artifact, and a unified request by nothing else.
    (artifact.extraction_version === 3) !== (options.unified !== undefined)
  )
    throw new ExtractionError('invalid_model_output', 'kei-exp returned an artifact for different extraction inputs.')
  // The result envelope is always `{records: [...]}`; a document-scope result holds exactly one root record.
  refuseRecordCardinality(request.request.schema.recordScope, artifact.records.length)
  const grounded = artifact.extraction_version === 2 ? artifact : null
  const unified = artifact.extraction_version === 3 ? artifact : null
  if (unified && !embedsItsRecords(unified, raw as Record<string, unknown>, pins, request))
    throw new ExtractionError('invalid_model_output', 'kei-exp returned execution or discovery records that do not belong to this Extraction.')
  const anchorId = (link: { segment: string; cell?: string | null; page: number }) => {
    const id = `a_${link.segment}${link.cell ? `_${link.cell}` : ''}`
    if (link.cell) {
      const anchor = document.evidence_index.anchors.find((anchor) => anchor.anchor_id === id)
      if (
        anchor?.kind !== 'table_cell' ||
        anchor.cell_id !== link.cell ||
        anchor.logical_table_id !== `t_${link.segment}` ||
        !anchor.producer_observations.some((observation) => observation.page_number === link.page)
      )
        throw new ExtractionError('invalid_model_output', 'Cell Evidence does not belong to the pinned Source Representation.')
    }
    if (unified && !document.evidence_index.anchors.some((anchor) => anchor.anchor_id === id))
      throw new ExtractionError('invalid_model_output', 'Evidence does not belong to the pinned Source Representation.')
    return id
  }
  return {
    extractionId: pins.extractionId,
    sourceDocumentId: pins.sourceDocumentId,
    sourceRepresentationRevisionId: pins.sourceRepresentationRevisionId,
    schemaRevisionId: pins.schemaRevisionId,
    strategy: pins.strategy,
    outcome: 'SUCCEEDED',
    complete: artifact.complete,
    result: { records: artifact.records },
    evidence: unified
      ? unified.evidence.map((link) => ({
          resultPath: link.path,
          evidenceAnchorId: anchorId(link),
          precision: link.precision,
          verbatim: link.verbatim,
          lexicalHits: link.hits,
          grounding: {
            linkedBy: link.linked_by, support: link.support, textSpans: link.spans, alternatives: link.alternatives,
            precision: link.precision, raw: link.raw, itemSpans: link.item,
          },
        }))
      : grounded
      ? grounded.evidence.map((link) => ({
          resultPath: link.path,
          evidenceAnchorId: anchorId(link),
          ...(link.precision ? { precision: link.precision } : {}),
          verbatim: link.verbatim,
          lexicalHits: link.hits,
          grounding: {
            linkedBy: link.linked_by, provenance: link.provenance, textSpans: link.spans, keySpans: link.key_spans,
            alternatives: link.alternatives, heading: link.heading, precision: link.precision, raw: link.raw,
            normalized: link.normalized && {
              value: link.normalized.value, rule: link.normalized.rule,
              keySpan: link.normalized.key_span, expansionSpan: link.normalized.expansion_span,
            },
          },
        }))
      : artifact.evidence.map((link) => ({
          resultPath: link.path,
          evidenceAnchorId: anchorId(link),
          ...(link.precision ? { precision: link.precision } : {}),
          verbatim: link.verbatim,
          lexicalHits: link.hits,
          ...(link.linked_by === 'lexical' ? { linkedBy: 'lexical' as const } : {}),
        })),
    modelAttribution: { provider: 'kei-exp', modelId: artifact.model },
    diagnostics: {
      phase: 'persisting', durationMs: Math.round(artifact.seconds * 1000),
      modelCalls: artifact.calls.length, inputTokens: artifact.tokens.input, outputTokens: artifact.tokens.output,
      finishReason: null, ungroundedPaths: artifact.ungrounded, groundingIssues: artifact.issues,
      // Document-level fields: extracted into every record, grounded in none of them.
      groundingBatches: [], unverifiedFields: artifact.unverified, catalog: null,
      models: { fields: artifact.models.fields, reasoning: artifact.models.reasoning },
      effectiveMethod: {
        options: artifact.options,
        versions: Object.fromEntries(([
          ['prompt', artifact.prompt_version], ['method', artifact.method_version], ['spanGrounding', artifact.span_grounding_version],
          ['groundingRouting', artifact.grounding_routing_version], ['rendering', artifact.rendering_version],
          ['grouping', artifact.grouping_version], ['selection', artifact.selection_version],
        ] satisfies [string, number | undefined][]).filter((entry): entry is [string, number] => entry[1] !== undefined)),
      },
      eligibility: artifact.grounding_eligibility
        ? {
            allRecordLeaves: artifact.grounding_eligibility.all_record_leaves,
            eligibleRecordLeaves: artifact.grounding_eligibility.eligible_record_leaves,
            skipped: artifact.grounding_eligibility.skipped.map(({ path: resultPath, policy }) => ({ resultPath, policy })),
            eligibleGrounding: artifact.completion?.eligible_grounding
              ?? (artifact.grounding_eligibility.eligible_record_leaves === 0 ? 'not_applicable' : 'partial'),
          }
        : null,
      // Kept beside the Evidence, never turned into it: links come from `evidence` alone.
      support: artifact.quoted_support?.map(({ path: resultPath, ...proof }) => ({ resultPath, ...proof })) ?? null,
      ...(unified ? { unified: unifiedDiagnostics(unified) } : {}),
      ...(grounded
        ? {
            grounded: {
              recipe: `${grounded.segmentation.recipe.id}@${grounded.segmentation.recipe.version}`,
              segmentationFingerprint: grounded.segmentation.fingerprint,
              budget: { inputTokens: grounded.budget.input_tokens, outputTokens: grounded.budget.output_tokens, tokenizer: grounded.budget.tokenizer },
              segmentationDiagnostics: grounded.segmentation.diagnostics,
              normalization: grounded.normalization,
              recordBlocks: grounded.record_blocks,
              proposed: grounded.proposed,
              rejected: grounded.rejected,
              competitors: grounded.competitors,
              coverage: grounded.coverage,
              completeness: grounded.completeness,
            },
          }
        : {}),
    },
    failure: null, reviewable: true,
    batchExtractionId: pins.batchExtractionId,
  }
}

/** The execution and discovery records the artifact embeds are the ones it digests, made for this Extraction's pins:
 *  its ID, run, generation, schema, requested unified method and the models it reports. */
function embedsItsRecords(artifact: KeiExpUnifiedArtifact, raw: Record<string, unknown>, pins: ArtifactPins, request: KeiExtractInput): boolean {
  const { execution, discovery } = artifact
  return digestOf(raw.execution) === artifact.execution_sha256 && digestOf(raw.discovery) === artifact.discovery_sha256 &&
    discovery.execution_sha256 === artifact.execution_sha256 && execution.extraction_id === pins.extractionId &&
    execution.source.run_id === request.run_id && execution.source.generation === request.generation &&
    execution.source.digest === artifact.digest && execution.schema_sha256 === digestOf(request.request.schema) &&
    isDeepStrictEqual(execution.method, request.request.options.unified) && isDeepStrictEqual(execution.models, artifact.models)
}

export type UnifiedDiagnostics = ReturnType<typeof unifiedDiagnostics>

/** What a researcher reviews of a unified result beside its accepted values: the method it ran under, how the source
 *  was accounted for, what processing failed, and every proposal, rejection, conflict and uncertain list item. */
function unifiedDiagnostics(artifact: KeiExpUnifiedArtifact) {
  const { execution, discovery } = artifact
  const rows = (disposition: string) => discovery.ledger.filter((row) => row.disposition === disposition)
    .map(({ segment, start, end }) => ({ segment, start, end }))
  return {
    method: { requested: execution.method, effective: execution.effective },
    records: { execution: artifact.execution_sha256, discovery: artifact.discovery_sha256 },
    entries: discovery.entries.length,
    unsettledEntries: discovery.entries.filter((entry) => entry.end === 'unresolved' || entry.end === 'beyond_scope')
      .map(({ id, label, end }) => ({ id, label, end: end as 'unresolved' | 'beyond_scope' })),
    sourceEndEntries: discovery.entries.filter((entry) => entry.end === 'source_end').map(({ id, label }) => ({ id, label })),
    unresolved: rows('unresolved'),
    withheld: rows('withheld'),
    processing: artifact.processing,
    completeness: artifact.completeness,
    proposed: artifact.proposed,
    rejected: artifact.rejected,
    competitors: artifact.competitors,
    items: artifact.items,
    document: artifact.document,
    contextOmitted: artifact.context_omitted,
  }
}
