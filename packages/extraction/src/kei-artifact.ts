import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { TerminalExtraction } from './dependencies.js'
import { ExtractionError } from './errors.js'
import type { KeiExtractInput } from './kei-handoff.js'
import type { ParsedDocument } from './parsed-document.js'
import type { ExtractionStrategy } from './types.js'

const path = z.array(z.union([z.string(), z.number().int().nonnegative()]))
/** One model call, as kei-exp's `kie/extract/stages.py` `Call` is written into the artifact. */
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
  schema: z.object({ recordDescription: z.string(), schemaNodes: z.array(z.unknown()) }),
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
export const anyArtifactSchema = z.discriminatedUnion('extraction_version', [versionOneSchema, groundedArtifactSchema])

/** A version 1 artifact: Article, and Catalog without a recipe. */
export type KeiExpArtifact = z.infer<typeof versionOneSchema>
export type KeiExpGroundedArtifact = z.infer<typeof groundedArtifactSchema>
export type KeiExpGroundedEvidence = z.infer<typeof groundedEvidenceSchema>
export type KeiExpAnyArtifact = z.infer<typeof anyArtifactSchema>
export type KeiExpCall = z.infer<typeof callSchema>
export type KeiExpEvidence = z.infer<typeof evidenceSchema>

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
 * schema, produced for other inputs than `request` (another run, generation, strategy, schema, recipe or model
 * choice), or naming a table cell the pinned representation does not have. Pure: the caller reads the bytes, the
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
    producedRecipe !== requestedRecipe || !isDeepStrictEqual(artifact.options.models ?? null, options.models ?? null)
  )
    throw new ExtractionError('invalid_model_output', 'kei-exp returned an artifact for different extraction inputs.')
  const grounded = artifact.extraction_version === 2 ? artifact : null
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
    evidence: grounded
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
