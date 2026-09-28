/**
 * Owns Review storage: the saved draft under its version predicate, the reset, and finalization, which claims the
 * Extraction and writes the review revision and its decisions in one transaction after revalidating the submitted
 * decisions against the row it reads there (`review-rules.ts`). A replay compares the stored decision digest.
 */

import { isUniqueViolation, type Database, type DatabaseOrm } from 'db'
import type { PersistedReviewResult } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { encodeReviewedValue } from './postgres-attempts.js'
import {
  loadResearcherExtraction,
  ownsResearcherExtraction,
  readResearcherExtraction,
} from './postgres-ownership.js'
import { normalizeDecisions, reviewAuthorityMatchesExtraction, type ReviewAuthority } from './review-rules.js'
import type { ReviewDraft } from './types.js'

async function reviewDigest(orm: DatabaseOrm, extractionId: string): Promise<string | null> {
  const extraction = await orm.public.Extraction.select('reviewedAt').first({ id: extractionId })
  if (!extraction?.reviewedAt) return null
  return (await orm.public.ExtractionReview.where({ extractionId })
    .select('decisionDigest')
    .orderBy((review) => review.revisionNumber.desc())
    .first())?.decisionDigest ?? null
}

export async function readStoredReviewDraft(database: Database, accountId: string, extractionId: string): Promise<ReviewDraft | null> {
  return database.transaction(async (transaction) => {
    if (!await ownsResearcherExtraction(transaction, accountId, extractionId)) return null
    const row = await transaction.orm.public.Extraction.select('reviewDraft', 'reviewDraftVersion', 'reviewedAt').first({ id: extractionId })
    if (!row) return null
    return { version: row.reviewDraftVersion, decisions: row.reviewedAt ? [] : (row.reviewDraft ?? []) as unknown as ReviewDraft['decisions'] }
  })
}

export async function saveStoredReviewDraft(database: Database, accountId: string, extractionId: string, draft: ReviewDraft): Promise<ReviewDraft> {
  return database.transaction(async (transaction) => {
    if (!await ownsResearcherExtraction(transaction, accountId, extractionId))
      throw new ExtractionError('not_found', 'That Extraction was not found.')
    // updateAll keeps the version predicate in the atomic UPDATE; update first
    // selects an identity, then updates by primary key and loses that guard.
    const updated = await transaction.orm.public.Extraction.where({
      id: extractionId, reviewedAt: null, reviewable: true, reviewDraftVersion: draft.version,
    }).updateAll({ reviewDraft: draft.decisions, reviewDraftVersion: draft.version + 1 })
    if (updated.length !== 1) throw new ExtractionError('review_conflict', 'The review changed elsewhere. Reload before continuing.')
    return { decisions: draft.decisions, version: draft.version + 1 }
  })
}

export async function resetStoredReview(database: Database, accountId: string, extractionId: string, version: number): Promise<ReviewDraft> {
  return database.transaction(async (transaction) => {
    if (!await ownsResearcherExtraction(transaction, accountId, extractionId))
      throw new ExtractionError('not_found', 'That Extraction was not found.')
    const updated = await transaction.orm.public.Extraction.where({
      id: extractionId, reviewable: true, reviewDraftVersion: version,
    }).updateAll({ reviewedAt: null, reviewDraft: [], reviewDraftVersion: version + 1 })
    if (updated.length !== 1) throw new ExtractionError('review_conflict', 'The review changed elsewhere. Reload before continuing.')
    return { decisions: [], version: version + 1 }
  })
}

export async function finalizeStoredReview(
  database: Database,
  researcherAccountId: string,
  extractionId: string,
  authority: ReviewAuthority,
): Promise<PersistedReviewResult> {
  const submitted = normalizeDecisions(authority.reviewDecisions)
  const digest = JSON.stringify(submitted)
  if (submitted.length !== authority.reviewDecisions.length)
    return { status: 'invalid' }
  let status: 'not-found'
    | 'invalid'
    | 'conflict'
    | 'replayed'
    | 'reviewed'
  try {
    status = await database.transaction(async (transaction) => {
      const { orm } = transaction
      const extraction = await loadResearcherExtraction(
        transaction,
        researcherAccountId,
        extractionId,
      )
      if (!extraction) return 'not-found' as const
      if (!reviewAuthorityMatchesExtraction(extraction, submitted, authority))
        return 'invalid' as const
      if (extraction.reviewedAt)
        return (await reviewDigest(orm, extractionId)) === digest
          ? ('replayed' as const)
          : ('conflict' as const)
      const claimed = await orm.public.Extraction.where({
        id: extractionId, reviewedAt: null, reviewDraftVersion: authority.expectedDraftVersion ?? 0,
      }).updateAll({ reviewedAt: new Date(), reviewDraft: null, reviewDraftVersion: (authority.expectedDraftVersion ?? 0) + 1 })
      if (claimed.length !== 1) return (await reviewDigest(orm, extractionId)) === digest ? 'replayed' as const : 'conflict' as const
      const previous = await orm.public.ExtractionReview.where({ extractionId })
        .select('revisionNumber').orderBy((review) => review.revisionNumber.desc()).first()
      const review = await orm.public.ExtractionReview.create({
        extractionId,
        revisionNumber: (previous?.revisionNumber ?? 0) + 1,
        decisionDigest: digest,
      })
      for (const decision of submitted)
        await orm.public.ReviewDecision.create({
          extractionReviewId: review.id,
          ...decision,
          reviewedValue: encodeReviewedValue(decision.reviewedValue),
        })
      return 'reviewed' as const
    })
  } catch (error) {
    // A concurrent finalization committed this review's revision first.
    if (!isUniqueViolation(error)) throw error
    status = await database.transaction(async (transaction) => {
      if (
        !(await ownsResearcherExtraction(
          transaction,
          researcherAccountId,
          extractionId,
        ))
      )
        return 'not-found' as const
      return (await reviewDigest(transaction.orm, extractionId)) === digest
        ? ('replayed' as const)
        : ('conflict' as const)
    })
  }
  if (
    status === 'not-found' ||
    status === 'invalid' ||
    status === 'conflict'
  )
    return { status }
  const extraction = await readResearcherExtraction(database, researcherAccountId, extractionId)
  if (!extraction)
    throw new Error('Reviewed Extraction could not be read.')
  return { status, extraction }
}
