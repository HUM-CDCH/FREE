import { ExtractionError } from './errors.js'
import type { ParsedDocument } from './parsed-document.js'
import { populatedContentPaths, resultPathKey } from './review-paths.js'
import { isRecord, parseExtractionSchema, partitionSchemaNodes, restoreSchemaNodeOrder, schemaNodeAtPath } from './schema.js'
import type {
  EvidenceLink, ExtractionSchemaNode, ExtractionSnapshot, ReviewDecisionInput, ReviewTransfer, TransferEntry, TransferRecord,
} from './types.js'

/*
 * The rules deciding whether submitted Review Decisions may finalize an Extraction's review. They run twice: against
 * the snapshot the module reads (`reviewableExtraction`, then `reviewAuthority`, which fails with the first broken
 * rule's ExtractionError), and again against the Extraction re-read inside the finalization transaction
 * (`reviewAuthorityMatchesExtraction`), before the conditional update atomically claims finalization. Pure: no persistence, DBOS or database import.
 */

/**
 * What the snapshot-side rules grant `finalizeReview` in persistence: the submitted Review Decisions, the occurrence IDs
 * each Evidence Anchor owns in the pinned document, and the Evidence's result path keys.
 */
export type ReviewAuthority = Readonly<{
  expectedDraftVersion?: number
  reviewDecisions: readonly ReviewDecisionInput[]
  occurrenceIdsByAnchor: ReadonlyMap<string, ReadonlySet<string>>
  evidenceResultPathKeys: ReadonlySet<string>
}>

/** An Extraction with a reviewable Extraction Result and its Evidence. */
export type ReviewableExtraction = ExtractionSnapshot & Readonly<{
  result: Readonly<Record<string, unknown>>
  evidence: readonly EvidenceLink[]
}>

/** Review Decisions as finalization stores them and digests them: sorted by result path, occurrence IDs unique and sorted. */
export type NormalizedReviewDecision = ReturnType<typeof normalizeDecisions>[number]

/** The first rule, checked before the pinned Source Representation and Schema Revision are read. */
export function reviewableExtraction(extraction: ExtractionSnapshot): ReviewableExtraction {
  if (extraction.outcome !== 'SUCCEEDED' || !extraction.reviewable || !extraction.result || !extraction.evidence)
    throw new ExtractionError('invalid_review', 'The Extraction has no reviewable Extraction Result.')
  return extraction as ReviewableExtraction
}

/**
 * The authority to finalize `decisions` against the Extraction's pinned document and schema, or the ExtractionError of
 * the first rule they break, in this order: the pinned Schema Revision parses; the Extraction Result's records match
 * it; the grounding coverage holds; the Review Decisions match the Evidence one to one and the schema.
 */
export function reviewAuthority(input: Readonly<{
  extraction: ReviewableExtraction
  document: ParsedDocument
  schemaTree: unknown
  decisions: readonly ReviewDecisionInput[]
  expectedDraftVersion: number
}>): ReviewAuthority {
  const { extraction, decisions } = input
  const definition = parsePinnedSchema(input.schemaTree)
  const reviewRecords = extractionRecords(extraction.result)
  if (!reviewRecords) throw new ExtractionError('invalid_review', 'The Extraction Result does not match its pinned Schema Revision.')
  try {
    for (const record of reviewRecords) restoreSchemaNodeOrder(record, definition.schemaNodes)
  } catch (error) {
    throw new ExtractionError('invalid_review', 'The Extraction Result does not match its pinned Schema Revision.', { cause: error })
  }
  const evidenceResultPathKeys = groundedResultPathKeys(extraction, definition.schemaNodes)
  if (!evidenceResultPathKeys)
    throw new ExtractionError('invalid_review', 'The Extraction grounding coverage does not match its stored Extraction Result.')
  const evidenceByPath = new Map(
    extraction.evidence.map((link) => [resultPathKey(link.resultPath), link]),
  )
  if (
    decisions.length !== evidenceByPath.size ||
    decisions.some((decision) => {
      const link = evidenceByPath.get(resultPathKey(decision.resultPath))
      return (
        !link ||
        link.evidenceAnchorId !== decision.evidenceAnchorId ||
        !reviewDecisionMatchesSchema(definition.schemaNodes, decision)
      )
    })
  )
    throw new ExtractionError(
      'invalid_review',
      'The Review Decisions do not match the pinned Extraction Result.',
    )
  return {
    expectedDraftVersion: input.expectedDraftVersion,
    reviewDecisions: decisions.map((decision) => ({
      resultPath: [...decision.resultPath],
      evidenceAnchorId: decision.evidenceAnchorId,
      reviewedOccurrenceIds: [...decision.reviewedOccurrenceIds],
      action: decision.action,
      reviewedValue: decision.reviewedValue,
      ...(decision.reviewedEvidence ? { reviewedEvidence: decision.reviewedEvidence } : {}),
    })),
    occurrenceIdsByAnchor: occurrenceOwnership(input.document),
    evidenceResultPathKeys,
  }
}

/**
 * The grounding coverage invariant: each populated reviewable value has exactly one Evidence link or one ungrounded
 * mark, never both. Returns the Evidence's result path keys when it holds, `null` when it does not.
 */
function groundedResultPathKeys(
  extraction: ReviewableExtraction,
  nodes: readonly ExtractionSchemaNode[],
): ReadonlySet<string> | null {
  // Neither a source-filename field (filled from the package, never by the model) nor a
  // document-level one (read once for the whole source; kei-exp reports its name under
  // `unverified` and grounds it in no record) carries evidence, so neither is grounded nor
  // ungrounded in the review's sense: both stay outside the coverage invariant.
  const partition = partitionSchemaNodes(nodes)
  const unreviewedFields = new Set([...partition.packageNodes, ...partition.documentNodes].map((node) => node.name))
  const populatedResultPathKeys = new Set(
    populatedContentPaths(extraction.result)
      .filter((path) => {
        const field = path[0] === 'records' && typeof path[1] === 'number' ? path[2] : path[0]
        return typeof field !== 'string' || !unreviewedFields.has(field)
      })
      .map(resultPathKey),
  )
  const evidencePathKeys = extraction.evidence.map((link) => resultPathKey(link.resultPath))
  const ungroundedPathKeys = extraction.diagnostics.ungroundedPaths.map(resultPathKey)
  const evidenceResultPathKeys = new Set(evidencePathKeys)
  const ungroundedResultPathKeys = new Set(ungroundedPathKeys)
  const accountedResultPathKeys = new Set([...evidenceResultPathKeys, ...ungroundedResultPathKeys])
  if (
    evidenceResultPathKeys.size !== evidencePathKeys.length ||
    ungroundedResultPathKeys.size !== ungroundedPathKeys.length ||
    [...evidenceResultPathKeys].some((key) => ungroundedResultPathKeys.has(key)) ||
    accountedResultPathKeys.size !== populatedResultPathKeys.size ||
    [...accountedResultPathKeys].some((key) => !populatedResultPathKeys.has(key))
  )
    return null
  return evidenceResultPathKeys
}

/** The pinned Schema Revision's tree, or the ExtractionError that it is invalid. */
export function parsePinnedSchema(raw: unknown) {
  try { return parseExtractionSchema(raw) }
  catch (error) { throw new ExtractionError('invalid_schema_revision', 'The pinned Schema Revision is invalid.', { cause: error }) }
}

function extractionRecords(result: Readonly<Record<string, unknown>>): Record<string, unknown>[] | null {
  return Object.keys(result).every((key) => key === 'records') && Array.isArray(result.records) && result.records.every(isRecord) ? result.records : null
}

/** Each Evidence Anchor's occurrence IDs in the pinned document: the occurrences a Review Decision on it reviews. */
export function occurrenceOwnership(document: ParsedDocument): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(document.evidence_index.anchors.map((anchor) => [anchor.anchor_id, new Set(anchor.producer_observations.map((observation) => observation.occurrence_id))]))
}

/** The action/value rule: a Review Decision's action is known, and only an EDITED one carries a reviewed value. */
function actionMatchesReviewedValue(decision: Pick<ReviewDecisionInput, 'action' | 'reviewedValue'>): boolean {
  return (
    ['APPROVED', 'EDITED', 'REJECTED'].includes(decision.action) &&
    (decision.action === 'EDITED') === (decision.reviewedValue !== null)
  )
}

/** The action/value rule, and an EDITED value's fit to its schema node's type and allowed values. */
export function reviewDecisionMatchesSchema(
  nodes: readonly ExtractionSchemaNode[],
  decision: ReviewDecisionInput,
): boolean {
  if (!actionMatchesReviewedValue(decision)) return false
  if (decision.action !== 'EDITED') return true
  const node = schemaNodeAtPath(nodes, decision.resultPath)
  if (!node) return false
  const type =
    node.type === 'array' && node.itemType ? node.itemType : node.type
  const value = decision.reviewedValue
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string' && node.allowedValues)
    return typeof value === 'string' && node.allowedValues.includes(value)
  return (
    type === 'string' || type === 'verbatim-string' || type === 'date'
  ) && typeof value === 'string'
}

/** The stored and digested form of submitted Review Decisions; its JSON is the review's decision digest. */
export function normalizeDecisions(decisions: ReviewAuthority['reviewDecisions']) {
  return decisions.map((decision) => ({
    resultPath: [...decision.resultPath],
    resultPathKey: JSON.stringify(decision.resultPath),
    evidenceAnchorId: decision.evidenceAnchorId,
    reviewedOccurrenceIds: [...new Set(decision.reviewedOccurrenceIds)].sort(),
    action: decision.action,
    reviewedValue: decision.reviewedValue,
    // Absent unless recorded, so the digests of reviews without it stay as they were; its occurrences unique and sorted
    // like the model's, so a repeated one cannot stand in for a missing one.
    ...(decision.reviewedEvidence
      ? { reviewedEvidence: decision.reviewedEvidence.map((evidence) => ({
          evidenceAnchorId: evidence.evidenceAnchorId,
          reviewedOccurrenceIds: [...new Set(evidence.reviewedOccurrenceIds)].sort(),
        })) }
      : {}),
  })).sort((left, right) => left.resultPathKey.localeCompare(right.resultPathKey))
}

/**
 * The revalidation of the Extraction re-read inside the finalization transaction (no row lock: the conditional
 * update that follows claims finalization atomically, so a concurrent finalizer loses the claim): the Extraction is still reviewable,
 * its Evidence is well formed and still the one the authority was granted for, and the submitted Review Decisions
 * match it one to one, review every occurrence their Evidence Anchor owns, and obey the action/value rule.
 */
export function reviewAuthorityMatchesExtraction(
  extraction: ExtractionSnapshot,
  submitted: readonly NormalizedReviewDecision[],
  authority: ReviewAuthority,
): boolean {
  if (
    extraction.outcome !== 'SUCCEEDED' ||
    !extraction.reviewable ||
    !Array.isArray(extraction.evidence)
  )
    return false
  const evidenceByPath = new Map<string, string>()
  for (const link of extraction.evidence) {
    if (
      !link ||
      typeof link !== 'object' ||
      typeof link.evidenceAnchorId !== 'string' ||
      !Array.isArray(link.resultPath) ||
      !link.resultPath.every(
        (segment: unknown) =>
          typeof segment === 'string' ||
          (typeof segment === 'number' &&
            Number.isInteger(segment) &&
            segment >= 0),
      )
    )
      return false
    const key = JSON.stringify(link.resultPath)
    if (evidenceByPath.has(key)) return false
    evidenceByPath.set(key, link.evidenceAnchorId)
  }
  return (
    evidenceByPath.size === authority.evidenceResultPathKeys.size &&
    [...authority.evidenceResultPathKeys].every((key) =>
      evidenceByPath.has(key),
    ) &&
    submitted.length === evidenceByPath.size &&
    new Set(submitted.map((decision) => decision.resultPathKey)).size ===
      submitted.length &&
    submitted.every((decision) => {
      // Every occurrence of a published anchor of the pinned document, the model's and a correction's alike.
      const reviewsAnchor = (anchorId: string, occurrenceIds: readonly string[]) => {
        const owned = authority.occurrenceIdsByAnchor.get(anchorId)
        return owned !== undefined && occurrenceIds.length === owned.size && occurrenceIds.every((id) => owned.has(id))
      }
      return (
        evidenceByPath.get(decision.resultPathKey) ===
          decision.evidenceAnchorId &&
        reviewsAnchor(decision.evidenceAnchorId, decision.reviewedOccurrenceIds) &&
        (!decision.reviewedEvidence || (decision.action === 'EDITED' && decision.reviewedEvidence.every(
          (evidence) => reviewsAnchor(evidence.evidenceAnchorId, evidence.reviewedOccurrenceIds)))) &&
        actionMatchesReviewedValue(decision)
      )
    })
  )
}

type TransferSample = ReviewTransfer['samples'][number]

/**
 * Which record of `other` each record of `records` aligns with (design §7.1): by segmentation block when both ran on
 * the same recipe segmentation, otherwise only a one-to-one, mutual overlap of Evidence Anchors. A record in no pair is
 * unmatched; a merge or a split pairs nothing.
 */
export function alignRecords(records: TransferSample, other: TransferSample): ReadonlyMap<number, number> {
  const byBlock = records.segmentation !== null && records.segmentation === other.segmentation
  const meets = (left: TransferRecord, right: TransferRecord) => byBlock
    ? left.block !== null && left.block === right.block
    : left.anchors.some((anchor) => right.anchors.includes(anchor))
  const pairs = new Map<number, number>()
  records.records.forEach((record, index) => {
    const hits = other.records.flatMap((candidate, at) => meets(record, candidate) ? [at] : [])
    if (hits.length === 1 && records.records.filter((each) => meets(each, other.records[hits[0]!]!)).length === 1)
      pairs.set(index, hits[0]!)
  })
  return pairs
}

/**
 * The union of samples' decisions, oldest sample first (design §6): where a newer sample decided a schema node of a
 * record aligned with an older one's, the newer decision wins; every other decision is kept. Null when none is left.
 */
export function unionReviewTransfer(samples: readonly (TransferSample & { entries: readonly TransferEntry[] })[]): ReviewTransfer | null {
  let entries: readonly TransferEntry[] = []
  for (const sample of samples) {
    const decided = new Set(sample.entries.map((entry) => `${entry.record} ${entry.nodeId}`))
    const aligned = new Map(samples.map((older) => [older.extractionId, alignRecords(older, sample)]))
    entries = [...entries.filter((entry) => {
      const record = aligned.get(entry.extractionId)!.get(entry.record)
      return record === undefined || !decided.has(`${record} ${entry.nodeId}`)
    }), ...sample.entries]
  }
  if (entries.length === 0) return null
  return {
    samples: samples.filter((sample) => entries.some((entry) => entry.extractionId === sample.extractionId))
      .map(({ extractionId, segmentation, records }) => ({ extractionId, segmentation, records })),
    entries,
  }
}
