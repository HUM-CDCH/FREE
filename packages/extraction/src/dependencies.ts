import type {
  BatchExtractionResults,
  BatchExtractionSnapshot,
  DocumentExtractionsSnapshot,
  ExtractionDiagnostics,
  EvidenceLink,
  ExtractionFailure,
  ExtractionModelAttribution,
  ExtractionModule,
  ExtractionSnapshot,
  ExtractionStrategy,
  ModelAttribution,
  ModelGenerationMetadata,
  ReadBatchInput,
  ReadDocumentExtractionsInput,
  ReviewDecisionInput,
  RunSingleResult,
  ScheduleBatchInput,
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
} from './types.js'

export type LoadedExtractionInputs = Readonly<{
  sourceDocumentId: string
  projectContextId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  schemaTree: unknown
  parsedDocument: unknown
}>

export type TerminalExtraction = Readonly<{
  extractionId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  complete: boolean | null
  modelAttribution: ExtractionModelAttribution | null
  diagnostics: ExtractionDiagnostics
  failure: ExtractionFailure | null
  result: Readonly<Record<string, unknown>> | null
  evidence: readonly EvidenceLink[] | null
  reviewable: boolean
  retryOfId: string | null
  batchExtractionId: string | null
}>

export type PersistExtractionResult =
  | Readonly<{ status: 'created' | 'replayed'; extraction: ExtractionSnapshot }>
  | Readonly<{ status: 'conflict'; extraction: ExtractionSnapshot }>
  | Readonly<{ status: 'invalid' }>

export type ReviewAuthority = Readonly<{
  reviewDecisions: readonly ReviewDecisionInput[]
  occurrenceIdsByAnchor: ReadonlyMap<string, ReadonlySet<string>>
  evidenceResultPathKeys: ReadonlySet<string>
}>

export type PersistedReviewResult =
  | Readonly<{ status: 'reviewed' | 'replayed'; extraction: ExtractionSnapshot }>
  | Readonly<{ status: 'conflict' | 'invalid' | 'not-found' }>

export interface ExtractionPersistence {
  loadExtractionInputs(
    sourceRepresentationRevisionId: string,
    schemaRevisionId: string,
  ): Promise<LoadedExtractionInputs | null>
  readCanonicalParsedDocument(sourceRepresentationRevisionId: string): Promise<unknown | null>
  readExtraction(extractionId: string): Promise<ExtractionSnapshot | null>
  isExtractionIdAvailable(extractionId: string): Promise<boolean>
  persistExtraction(extraction: TerminalExtraction): Promise<PersistExtractionResult>
  finalizeReview(extractionId: string, authority: ReviewAuthority): Promise<PersistedReviewResult>
  readDocumentExtractions(input: ReadDocumentExtractionsInput): Promise<DocumentExtractionsSnapshot | null>
  scheduleBatch(input: ScheduleBatchInput): Promise<ScheduleBatchResult | null>
  scheduleSuggestedBatch(input: ScheduleSuggestedBatchInput): Promise<ScheduleBatchResult | null>
  listBatches(projectContextId: string, limit: number): Promise<readonly BatchExtractionSnapshot[] | null>
  readBatch(input: ReadBatchInput): Promise<BatchExtractionSnapshot | null>
  readBatchResults(input: ReadBatchInput): Promise<BatchExtractionResults | null>
}

export type ExtractionModelRequest = Readonly<{
  document: Readonly<{
    markdown: string
    pages: number
  }>
  template: Readonly<Record<string, unknown>>
  instruction?: string
  signal: AbortSignal
}>

export type ExtractionModelResponse = Readonly<{
  result: Readonly<Record<string, unknown>>
  metadata: ModelGenerationMetadata
}>

export interface ExtractionModel {
  extract(request: ExtractionModelRequest): Promise<ExtractionModelResponse>
}

export type GroundingSelection = Readonly<{
  claimLabel: string
  anchorLabel: string | null
}>

export type GroundingModelRequest = Readonly<{
  claims: Readonly<Record<string, string | number | boolean>>
  anchors: Readonly<Record<string, string>>
  signal: AbortSignal
}>

export type GroundingModelResponse = Readonly<{
  selections: readonly GroundingSelection[]
  metadata: ModelGenerationMetadata
}>

export interface GroundingModel {
  ground(request: GroundingModelRequest): Promise<GroundingModelResponse>
}

export type ExtractionModelSession = Readonly<{
  attribution: ModelAttribution
  model: ExtractionModel
  groundingModel: GroundingModel
}>

export interface ExtractionModelSessions {
  open(): Promise<ExtractionModelSession>
}
export type BatchMemberExtractionInput = Readonly<{
  extractionId: string
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: 'ARTICLE'
  batchExtractionId: string
}>

export interface ExtractionExecutionModule extends ExtractionModule {
  runBatchMember(input: BatchMemberExtractionInput, signal: AbortSignal): Promise<RunSingleResult>
}


export type ExtractionModuleDependencies = Readonly<{
  persistence: ExtractionPersistence
  models: ExtractionModelSessions
  now?: () => number
}>

export type ExtractionModuleFactory = (dependencies: ExtractionModuleDependencies) => ExtractionExecutionModule
