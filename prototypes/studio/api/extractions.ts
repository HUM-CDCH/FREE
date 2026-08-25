/// <reference types="vite/client" />

import {
  ExtractionError,
  type ExtractionDiagnostics,
  type ExtractionModule,
  type ExtractionSnapshot,
} from 'extraction'
import {
  extractionAttemptSchema,
  extractionReadResponseSchema,
  extractionRequestSchema,
  finalizeExtractionReviewSchema,
} from '../shared/extraction.contract.js'
import {
  ApiError,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
} from './_http.js'
import { extractions } from './_extraction_runtime.js'

const COLLECTION_ROUTE = '/api/extractions'
const ITEM_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)$/
const REVIEW_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)\/review$/

const GROUNDING_ISSUE_CODES: Readonly<Record<string, true>> = {
  missing_claim: true,
  unknown_claim_label: true,
  unknown_anchor_label: true,
  malformed_selection: true,
  grounding_failed: true,
}

function transportDiagnostics(
  extraction: ExtractionSnapshot,
): {
  phase: ExtractionDiagnostics['phase']
  durationMs: number
  modelCalls: number
  finishReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  grounding: {
    groundedPaths: readonly (readonly (string | number)[])[]
    ungroundedPaths: readonly (readonly (string | number)[])[]
    issueCodes: string[]
    batches: ExtractionDiagnostics['groundingBatches']
  } | null
} {
  const diagnostics = extraction.diagnostics
  const phase = extraction.failure?.phase ?? diagnostics.phase
  const groundingReached =
    extraction.result !== null ||
    diagnostics.ungroundedPaths.length > 0 ||
    diagnostics.groundingIssues.length > 0 ||
    phase === 'grounding'
  return {
    phase,
    durationMs: diagnostics.durationMs,
    modelCalls: diagnostics.modelCalls,
    finishReason: diagnostics.finishReason,
    inputTokens: diagnostics.inputTokens,
    outputTokens: diagnostics.outputTokens,
    grounding: groundingReached
      ? {
          groundedPaths: extraction.evidence?.map((link) => link.resultPath) ?? [],
          ungroundedPaths: diagnostics.ungroundedPaths,
          issueCodes: diagnostics.groundingIssues.flatMap((issue) => {
            const code = issue.code
            return typeof code === 'string' && GROUNDING_ISSUE_CODES[code]
              ? [code]
              : []
          }),
          batches: diagnostics.groundingBatches,
        }
      : null,
  }
}

export function extractionAttemptDto(extraction: ExtractionSnapshot) {
  return extractionAttemptSchema.parse({
    extractionId: extraction.extractionId,
    sourceDocumentId: extraction.sourceDocumentId,
    sourceRepresentationRevisionId:
      extraction.sourceRepresentationRevisionId,
    schemaRevisionId: extraction.schemaRevisionId,
    strategy: extraction.strategy,
    outcome: extraction.outcome,
    complete: extraction.complete,
    modelAttribution: extraction.modelAttribution,
    diagnostics: transportDiagnostics(extraction),
    failure:
      extraction.outcome === 'FAILED' && extraction.failure
        ? {
            code: extraction.failure.code,
            message: extraction.failure.message.slice(0, 512),
          }
        : null,
    resultPayload: extraction.result,
    evidenceLinks: extraction.evidence,
    reviewable: extraction.reviewable,
    retryOfId: extraction.retryOfId,
    batchExtractionId: extraction.batchExtractionId,
    createdAt: extraction.createdAt.toISOString(),
    reviewedAt: extraction.reviewedAt?.toISOString() ?? null,
    reviewDecisions: extraction.reviewDecisions,
  })
}

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
    case 'invalid_review':
      return new ApiError(422, error.code, error.message, { cause: error })
    default:
      return error
  }
}

export function createExtractionsApi(
  module: ExtractionModule = extractions,
): (request: Request) => Promise<Response> {
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
    const input = {
      kind: 'fresh' as const,
      extractionId: parsed.data.id,
      sourceRepresentationRevisionId:
        parsed.data.sourceRepresentationRevisionId,
      schemaRevisionId: parsed.data.schemaRevisionId,
      strategy: parsed.data.strategy,
    }
    const completed = await module.runSingle(input, request.signal)
    return json(extractionAttemptDto(completed.extraction), {
      status: completed.disposition === 'created' ? 201 : 200,
      headers: noStore,
    })
  }

  async function read(extractionId: string): Promise<Response> {
    const prepared = await module.prepareReview(extractionId)
    return json(
      extractionReadResponseSchema.parse({
        extraction: extractionAttemptDto(prepared.extraction),
        pendingReviewDecisions: prepared.reviewDecisions,
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
    )
    return json(extractionAttemptDto(finalized.extraction), {
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

  return async function extractionsApi(request: Request): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname
      if (request.method === 'POST' && pathname === COLLECTION_ROUTE)
        return await create(request)
      const reviewMatch = REVIEW_ROUTE.exec(pathname)
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
}

const handle = createExtractionsApi()
export const GET = handle
export const POST = handle
export const DELETE = handle
