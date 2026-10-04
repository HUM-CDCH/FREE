/// <reference types="vite/client" />

import type { ResearcherProjectStore } from 'db'
import { ExtractionError, partialFromProgress, type ExtractionAttemptSnapshot } from 'extraction'
import { keiRunOf } from 'extraction/kei-handoff'
import {
  extractionReadResponseSchema,
  extractionRequestSchema,
  finalizeExtractionReviewSchema,
  extractionReviewDraftSchema,
  partialResultSchema,
  resetExtractionReviewSchema,
  type PartialResult,
} from '../shared/extraction.contract.js'
import {
  ApiError,
  boundedValidationDetails,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import {
  createResearcherExtractions,
  extractionAttemptDto,
  keiExpClient,
} from './_extractions.js'
import { methodRefusal } from './_method_refusals.js'
import { randomUUID } from 'node:crypto'
import { createDurableRepository } from 'extraction/durable'
import { requestDurableReconciliation } from '../server/durable-extraction-workflow.js'

const COLLECTION_ROUTE = '/api/extractions'
const ITEM_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)$/
const REVIEW_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)\/review$/
const DRAFT_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)\/review\/draft$/
const RESET_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)\/review\/reset$/


/** Admission and status reads reach PostgreSQL and DBOS: an outage there is 503 with retry semantics, never a
 *  fabricated result (spec, *Status and ownership*). An ApiError or ExtractionError keeps its own answer. */
function unavailableUnlessDomain(error: unknown): never {
  if (error instanceof ApiError || error instanceof ExtractionError) throw error
  throw persistenceUnavailable(error)
}

function asTransportError(error: unknown): unknown {
  if (!(error instanceof ExtractionError)) return error
  const refused = methodRefusal(error)
  if (refused) return refused
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
    case 'invalid_extraction_pins':
    case 'review_conflict':
    case 'source_representation_superseded':
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

/** The partial view of a running Extraction (design §5): kei's progress document, read under PROGRESS_TIMEOUT_MS,
 *  converted with the artifact reader's own code and validated against the wire contract, all inside one best-effort
 *  boundary: no stage file yet, a slow or unreachable kei, or a document outside either contract is null, and the read
 *  answers as it did before. */
async function readPartial(extraction: ExtractionAttemptSnapshot): Promise<PartialResult | null> {
  const run = keiRunOf(extraction.preprocessId)
  if (run === null) return null
  try {
    const progress = await keiExpClient.readExtractionProgress(run.runId, extraction.extractionId)
    if (progress === null) return null
    const partial = partialResultSchema.safeParse(partialFromProgress(progress))
    return partial.success ? partial.data : null
  } catch {
    return null
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
      throw new ApiError(422, 'invalid_request', 'The Extraction request is invalid.', {
        details: boundedValidationDetails('request', parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        }))),
      })
    // Admission compares the submitted method with the account's saved one; this handler never reads the account.
    const input = {
      kind: 'fresh' as const,
      extractionId: parsed.data.id,
      sourceRepresentationRevisionId: parsed.data.sourceRepresentationRevisionId,
      schemaRevisionId: parsed.data.schemaRevisionId,
      strategy: parsed.data.strategy,
      ...(parsed.data.catalogRecipe ? { catalogRecipe: parsed.data.catalogRecipe } : {}),
      method: parsed.data.method,
      startPage: parsed.data.startPage ?? null,
    }
    const completed = await module.runSingle(input).catch(unavailableUnlessDomain)
    return json(extractionAttemptDto(completed.extraction), {
      status: completed.disposition === 'created' ? 201 : 200,
      headers: noStore,
    })
  }

  async function read(extractionId: string): Promise<Response> {
    const extraction = await module.readExtractionAttempt(extractionId).catch(unavailableUnlessDomain)
    if (!extraction)
      throw new ApiError(404, 'not_found', 'That Extraction was not found.')
    const pendingReviewDecisions = !extraction.durable && extraction.executionStatus === 'COMPLETED'
      ? (await module.prepareReview(extractionId)).reviewDecisions
      : null
    const partial = !extraction.durable && extraction.executionStatus === 'RUNNING' ? await readPartial(extraction) : null
    return json(
      extractionReadResponseSchema.parse({
        extraction: extractionAttemptDto(extraction),
        pendingReviewDecisions,
        partial,
        reviewDraft: !extraction.durable && extraction.executionStatus === 'COMPLETED' ? await module.readReviewDraft(extractionId) : undefined,
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
    const durable=createDurableRepository(store.researcherAccountId)
    if((await module.readExtractionAttempt(extractionId))?.durable) {
      const state=await durable.read(extractionId)
      await durable.command(extractionId,{id:randomUUID(),expectedVersion:state.controlVersion,action:'stop'})
      await requestDurableReconciliation(`${extractionId}:stop:${state.controlVersion}`)
      return json({extractionId},{status:202,headers:noStore})
    }
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
