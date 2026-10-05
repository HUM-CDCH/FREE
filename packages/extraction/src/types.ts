import type { ScalarFieldType as SchemaScalarFieldType } from './allowed-values.js'
import type { ActiveSettings, ExtractionMethodIntent } from './extraction-method.js'
import type { SchemaNode } from './schema.js'

export type ExtractionStrategy = 'ARTICLE' | 'CATALOG'
export type ExtractionDisposition = 'created' | 'replayed'
export type BatchDisposition = 'created' | 'replayed'
export type BatchRepetition = 'reuse-equal-selection' | 'create-new'
export type ProjectOperationStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'
export type ExtractionExecutionStatus = ProjectOperationStatus | 'PAUSING' | 'PAUSED' | 'STOPPING' | 'STOPPED'

export type ScalarFieldType = SchemaScalarFieldType
export type ExtractionSchemaNode = SchemaNode

export type ResultPath = readonly (string | number)[]

export type EvidenceLink = Readonly<{
  resultPath: ResultPath
  evidenceAnchorId: string
  precision?: 'cell' | 'segment' | 'input'
  /** The value occurs as a bounded token in the linked anchor. Absent on
   *  boolean values and on links stored before this check existed. */
  verbatim?: boolean
  /** Candidate anchors containing the value; above one, the passage is
   *  ambiguous. A reviewer's doubt, not a probability; never auto-accept. */
  lexicalHits?: number
  /** How the link was made when not by the grounder: the values call cited
   *  the block and code found the value in it, or code found the value in
   *  exactly one candidate. Absent means the grounder chose the anchor. */
  linkedBy?: 'citation_lexical' | 'lexical'
  /** Version 2 (recipe Catalog) evidence: code-point spans of the value in its canonical segment, the key that
   *  introduced it or the heading it was inherited from, and the precision its box can claim. Version 3 (unified
   *  Catalog): the verified value's literal span or supporting passage. Absent on version 1. */
  grounding?: EvidenceGrounding | VerifiedGrounding
}>

export type TextSpan = Readonly<{ segment: string; start: number; end: number }>

export type EvidenceGrounding = Readonly<{
  linkedBy: 'key' | 'structure'
  provenance: 'token' | 'positional' | 'inherited'
  textSpans: readonly TextSpan[]
  keySpans: readonly TextSpan[]
  alternatives: readonly (readonly TextSpan[])[]
  heading: string | null
  precision: 'cell' | 'segment' | 'input'
  raw: string
  /** The document's own glossary expansion of `raw`, with both glossary spans; the record keeps the raw value. */
  normalized: Readonly<{ value: string; rule: 'glossary'; keySpan: TextSpan; expansionSpan: TextSpan }> | null
}>

/** Version 3 evidence: a separate verification request accepted the value; `literal` spans print the value itself,
 *  `supporting` spans are the passage that supports a yes/no, a label or a derived value. `itemSpans` locate the list
 *  item the value belongs to. */
export type VerifiedGrounding = Readonly<{
  linkedBy: 'verification'
  support: 'literal' | 'supporting'
  textSpans: readonly TextSpan[]
  alternatives: readonly (readonly TextSpan[])[]
  precision: 'cell' | 'segment' | 'input'
  raw: string
  itemSpans: readonly TextSpan[] | null
}>

/** The two roles an Extraction's model calls split into: `fields` reads values off the source, `reasoning` decides
 *  over labelled text (record starts, grounding, arbitration). */
export type ExtractionModelRole = 'fields' | 'reasoning'

/** An Extraction Model Choice: per role, a model key of kei-exp's deployment (`instruct`, `nuextract`...), chosen for
 *  one run. A role left out keeps kei-exp's deployment default. Not a Capability Route or a FREE Model Connection. */
export type ExtractionModelChoice = Readonly<Partial<Record<ExtractionModelRole, string>>>

/** A named immutable durable review cut, independent of processing completion. */
export type FinalizedReview = Readonly<{ snapshotVersion: number; feedbackVersion: number; createdAt: Date }>

/** A durable Extraction's pins and lifecycle; its values, decisions and history are read from the durable repository. */
export type ExtractionAttemptSnapshot = Readonly<{
  extractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  sourceRepresentationRevisionNumber: number
  /** The pinned revision's `preprocessId`. */
  preprocessId: string
  schemaRevisionId: string
  extractionSchemaId: string
  schemaRevisionNumber: number
  strategy: ExtractionStrategy
  /** The numbered-catalogue recipe admitted with a Catalog Extraction; null for generic Catalog and Article. */
  catalogRecipe: string | null
  /** The model choice admitted with this Extraction (`Extraction.requestedModels`). */
  requestedModels?: ExtractionModelChoice | null
  /** The method settings admitted with this Extraction (`Extraction.requestedSettings`). */
  requestedSettings?: ActiveSettings | null
  executionStatus: ExtractionExecutionStatus
  /** The latest finalization of any of its result/decision cuts; later work stays separate. */
  finalizedReview: FinalizedReview | null
  batchExtractionId: string | null
  createdAt: Date
}>

export type FreshExtractionInput = Readonly<{
  kind: 'fresh'
  extractionId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  /** The numbered-catalogue recipe chosen for this Catalog Extraction; null or absent for generic Catalog. */
  catalogRecipe?: string | null
  /** The saved method the researcher saw at start: admission refuses it unless it is still the account's, then pins it. */
  method: ExtractionMethodIntent
  /** The page the researcher was reading when Run was clicked (one-based): the order kei reads records in, never which
   *  records. Absent or null when none was named (a Batch Extraction, an API client). Not part of the admission identity. */
  startPage?: number | null
}>

export type RunSingleInput = FreshExtractionInput
export type RunSingleResult = Readonly<{
  disposition: ExtractionDisposition
  extraction: ExtractionAttemptSnapshot
}>
export type BatchExtractionMemberSnapshot = Readonly<{
  extractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  executionStatus: ExtractionExecutionStatus
  /** Whether its current result cut holds saved values to review. */
  reviewable: boolean
  /** A finalization of its current result cut, produced by the batch's own Schema Revision; null otherwise. */
  currentReview: (FinalizedReview & Readonly<{ schemaRevisionId: string }>) | null
}>

export type BatchExtractionSnapshot = Readonly<{
  batchExtractionId: string
  projectContextId: string
  schemaRevisionId: string
  extractionSchemaId: string
  extractionSchemaName: string
  schemaRevisionNumber: number
  strategy: ExtractionStrategy
  /** QUEUED while every member is, COMPLETED once every member has settled, RUNNING otherwise; never FAILED. */
  executionStatus: ProjectOperationStatus
  createdAt: Date
  members: readonly BatchExtractionMemberSnapshot[]
}>

export type ScheduleBatchInput = Readonly<{
  projectContextId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  /** The saved method the researcher saw at start; one snapshot for the batch and every member. */
  method: ExtractionMethodIntent
  sourceDocumentIds: readonly string[]
  repetition: BatchRepetition
}>

export type ScheduleSuggestedBatchInput = Readonly<{
  projectContextId: string
  batchSchemaSuggestionId: string
  strategy: ExtractionStrategy
  /** The saved method the researcher saw at start; one snapshot for the batch and every member. */
  method: ExtractionMethodIntent
}>

export type ScheduleBatchResult = Readonly<{
  disposition: BatchDisposition
  batch: BatchExtractionSnapshot
}>

export type StabiliseSchemaRevisionInput = Readonly<{
  projectContextId: string
  schemaRevisionId: string
}>

export type StabiliseSchemaRevisionResult = Readonly<{
  schemaRevisionId: string
  stabilisedAt: string
}>

export type ListBatchesInput = Readonly<{
  projectContextId: string
  limit?: number
}>

export type ReadBatchInput = Readonly<{
  projectContextId: string
  batchExtractionId: string
}>

export type ReadDocumentExtractionsInput = Readonly<{
  sourceDocumentId: string
  extractionId?: string
}>

export type DocumentExtractionsSnapshot = Readonly<{
  sourceRepresentationRevisionId: string
  latestAttempt: ExtractionAttemptSnapshot | null
  latestReviewed: ExtractionAttemptSnapshot | null
}>


export interface ExtractionModule {
  runSingle(input: RunSingleInput): Promise<RunSingleResult>
  readExtractionAttempt(extractionId: string): Promise<ExtractionAttemptSnapshot | null>
  readDocumentExtractions(input: ReadDocumentExtractionsInput): Promise<DocumentExtractionsSnapshot | null>
  scheduleBatch(input: ScheduleBatchInput): Promise<ScheduleBatchResult>
  scheduleSuggestedBatch(input: ScheduleSuggestedBatchInput): Promise<ScheduleBatchResult>
  /** Marks a piloted Schema Revision stabilised, unlocking collection-scale Batch Extraction against it.
   *  Requires a finalized durable pilot review of that revision's current result cut. */
  stabiliseSchemaRevision(input: StabiliseSchemaRevisionInput): Promise<StabiliseSchemaRevisionResult>
  listBatches(input: ListBatchesInput): Promise<readonly BatchExtractionSnapshot[]>
  readBatch(input: ReadBatchInput): Promise<BatchExtractionSnapshot>
}
