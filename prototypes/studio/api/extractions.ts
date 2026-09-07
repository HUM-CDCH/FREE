/// <reference types="vite/client" />

import type { ResearcherProjectStore } from 'db'
import { ExtractionError } from 'extraction'
import {
  extractionReadResponseSchema,
  extractionRequestSchema,
  finalizeExtractionReviewSchema,
  extractionReviewDraftSchema,
  resetExtractionReviewSchema,
} from '../shared/extraction.contract.js'
import {
  ApiError,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
} from './_http.js'
import {
  createResearcherExtractions,
  extractionAttemptDto,
} from './_extraction_runtime.js'

const COLLECTION_ROUTE = '/api/extractions'
const ITEM_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)$/
const REVIEW_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)\/review$/
const DRAFT_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)\/review\/draft$/
const RESET_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)\/review\/reset$/


function asTransportError(error: unknown): unknown {
  if (!(error instanceof ExtractionError)) return error
  switch (error.code) {
    case 'not_found':
      return new ApiError(404, 'not_found', error.message, { cause: error })
    case 'invalid_source_representation':
      return new ApiError(
        503,
        'source_artifact_unavailable',
        'The pinned Source Representation is unavailable.',
        { cause: error },
      )
    case 'extraction_id_conflict':
    case 'extraction_in_progress':
    case 'invalid_extraction_pins':
    case 'review_conflict':
      return new ApiError(409, error.code, error.message, { cause: error })
    case 'invalid_schema_revision':
    case 'not_reviewable':
      return new ApiError(422, 'invalid_review', error.message, { cause: error })
    case 'invalid_request':
    case 'invalid_retry':
    case 'invalid_review':
      return new ApiError(422, error.code, error.message, { cause: error })
    default:
      return error
  }
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  const module = createResearcherExtractions(store.researcherAccountId)
  async function create(request: Request): Promise<Response> {
    const parsed = extractionRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_request',
        'The Extraction request is invalid.',
      )
    const input =
      'retryOfId' in parsed.data && parsed.data.retryOfId !== undefined
        ? {
            kind: 'retry' as const,
            extractionId: parsed.data.id,
            retryOfId: parsed.data.retryOfId,
            retryDocument: parsed.data.retryDocument,
            rediscover: parsed.data.rediscover,
            retryRecordStartBlockIds: parsed.data.retryRecordStartBlockIds,
          }
        : {
            kind: 'fresh' as const,
            extractionId: parsed.data.id,
            sourceRepresentationRevisionId:
              parsed.data.sourceRepresentationRevisionId!,
            schemaRevisionId: parsed.data.schemaRevisionId!,
            strategy: parsed.data.strategy!,
          }
    const completed = await module.runSingle(input, request.signal)
    return json(extractionAttemptDto(completed.extraction), {
      status: completed.disposition === 'created' ? 201 : 200,
      headers: noStore,
    })
  }

  async function read(extractionId: string): Promise<Response> {
    const extraction = await module.readExtractionAttempt(extractionId)
    if (!extraction)
      throw new ApiError(404, 'not_found', 'That Extraction was not found.')
    const pendingReviewDecisions = extraction.executionStatus === 'COMPLETED'
      ? (await module.prepareReview(extractionId)).reviewDecisions
      : null
    return json(
      extractionReadResponseSchema.parse({
        extraction: extractionAttemptDto(extraction),
        pendingReviewDecisions,
        reviewDraft: extraction.executionStatus === 'COMPLETED' ? await module.readReviewDraft(extractionId) : undefined,
      }),
      { headers: noStore },
    )
  }

  async function review(
    request: Request,
    extractionId: string,
  ): Promise<Response> {
    const parsed = finalizeExtractionReviewSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_request',
        'The Extraction review is invalid.',
      )
    const finalized = await module.finalizeReview(
      extractionId,
      parsed.data.reviewDecisions,
      parsed.data.expectedDraftVersion,
    )
    return json(extractionAttemptDto({
      ...finalized.extraction,
      executionStatus: 'COMPLETED',
    }), {
      headers: noStore,
    })
  }

  async function cancel(extractionId: string): Promise<Response> {
    const outcome = await module.cancelSingle(extractionId)
    if (outcome !== 'cancellation-requested')
      throw new ApiError(
        404,
        'not_found',
        'That Extraction is not active.',
      )
    return json({ extractionId }, { status: 202, headers: noStore })
  }

  const handle = async (request: Request): Promise<Response> => {
    try {
      const pathname = new URL(request.url).pathname
      if (request.method === 'POST' && pathname === COLLECTION_ROUTE)
        return await create(request)
      const reviewMatch = REVIEW_ROUTE.exec(pathname)
      const draftMatch = DRAFT_ROUTE.exec(pathname)
      const resetMatch = RESET_ROUTE.exec(pathname)
      if (request.method === 'POST' && resetMatch) {
        const parsed = resetExtractionReviewSchema.safeParse(await parseJsonRequest(request))
        if (!parsed.success) throw new ApiError(422, 'invalid_request', 'The review reset is invalid.')
        return json(await module.resetReview(resetMatch[1], parsed.data.expectedDraftVersion), { headers: noStore })
      }
      if (request.method === 'POST' && draftMatch) {
        const parsed = extractionReviewDraftSchema.safeParse(await parseJsonRequest(request))
        if (!parsed.success) throw new ApiError(422, 'invalid_request', 'The review draft is invalid.')
        return json(await module.saveReviewDraft(draftMatch[1], parsed.data), { headers: noStore })
      }
      if (request.method === 'POST' && reviewMatch)
        return await review(request, reviewMatch[1])
      const itemMatch = ITEM_ROUTE.exec(pathname)
      if (request.method === 'GET' && itemMatch)
        return await read(itemMatch[1])
      if (request.method === 'DELETE' && itemMatch)
        return await cancel(itemMatch[1])
      throw new ApiError(404, 'not_found', 'API route not found.')
    } catch (error) {
      return noStoreError(asTransportError(error))
    }
  }

  return { GET: handle, POST: handle, DELETE: handle }
}
