import { createHash, randomUUID } from 'node:crypto'
import {
  createProjectStore,
  type BatchExtractionRecord,
  type ProjectStore,
} from '../../../packages/db/src/project-store.js'
import {
  batchExtractionListResponseSchema,
  batchExtractionRequestSchema,
  batchExtractionResponseSchema,
} from '../shared/batchExtraction.contract.js'
import { extractionAttemptSchema } from '../shared/extraction.contract.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  ApiError,
  boundedLimit,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import { POST as postExtraction } from './extractions.js'

const COLLECTION_ROUTE = '/api/batch-extractions'

type BatchExtractionStore = Pick<
  ProjectStore,
  'createBatchExtraction' | 'listBatchExtractions'
>

type ExtractionPost = (request: Request) => Promise<Response>

function fingerprintId(value: unknown): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${(['8', '9', 'a', 'b'] as const)[parseInt(hash[16], 16) & 3]}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function batchExtractionId(selection: {
  projectContextId: string
  schemaRevisionId: string
  strategy: string
  sourceDocumentIds: readonly string[]
}): string {
  return fingerprintId([
    selection.projectContextId,
    selection.schemaRevisionId,
    selection.strategy,
    [...new Set(selection.sourceDocumentIds)].sort(),
  ])
}

function memberExtractionId(
  batch: BatchExtractionRecord,
  member: BatchExtractionRecord['members'][number],
): string {
  return fingerprintId([
    'batch-member-extraction',
    batch.batchExtractionId,
    member.sourceRepresentationRevisionId,
    member.latestExtraction?.extractionId ?? null,
  ])
}

function disposition(
  status: 'created' | 'replayed',
  batch: BatchExtractionRecord,
) {
  if (status === 'created') return 'created' as const
  if (batch.members.some((member) => !member.latestExtraction))
    return 'running' as const
  if (
    batch.members.some(
      (member) => member.latestExtraction?.outcome === 'FAILED',
    )
  )
    return 'retry' as const
  return 'complete' as const
}

function batchDto(batch: BatchExtractionRecord) {
  return {
    ...batch,
    createdAt: batch.createdAt.toISOString(),
    members: batch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
      latestExtraction: member.latestExtraction && {
        extractionId: member.latestExtraction.extractionId,
        outcome: member.latestExtraction.outcome,
        complete: member.latestExtraction.complete,
        reviewable: member.latestExtraction.reviewable,
        createdAt: member.latestExtraction.createdAt.toISOString(),
        reviewedAt: member.latestExtraction.reviewedAt?.toISOString() ?? null,
        // Only the researcher-facing sentence crosses the boundary; the stored
        // failure shape stays server-side.
        failureMessage: failureMessage(member.latestExtraction.failure),
      },
    })),
  }
}

function failureMessage(failure: unknown): string | null {
  return failure &&
    typeof failure === 'object' &&
    typeof (failure as { message?: unknown }).message === 'string'
    ? (failure as { message: string }).message
    : null
}

export function createBatchExtractionsApi(
  store: BatchExtractionStore = createProjectStore(),
  executeExtraction: ExtractionPost = postExtraction,
) {
  const active = new Map<string, Promise<BatchExtractionRecord>>()

  async function runMember(
    batch: BatchExtractionRecord,
    member: BatchExtractionRecord['members'][number],
  ): Promise<BatchExtractionRecord['members'][number]['latestExtraction']> {
    const response = await executeExtraction(
      new Request('http://studio/api/extractions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: memberExtractionId(batch, member),
          sourceRepresentationRevisionId:
            member.sourceRepresentationRevisionId,
          schemaRevisionId: batch.schemaRevisionId,
          strategy: batch.strategy,
          batchExtractionId: batch.batchExtractionId,
        }),
      }),
    )
    if (!response.ok) throw new Error('The member Extraction did not finish.')
    const attempt = extractionAttemptSchema.parse(await response.json())
    return {
      extractionId: attempt.extractionId,
      outcome: attempt.outcome,
      complete: attempt.complete,
      reviewable: attempt.reviewable,
      createdAt: new Date(attempt.createdAt),
      reviewedAt: attempt.reviewedAt ? new Date(attempt.reviewedAt) : null,
      failure: attempt.failure,
    }
  }

  async function run(batch: BatchExtractionRecord) {
    const members = [...batch.members]
    for (const [index, member] of members.entries()) {
      if (
        member.latestExtraction &&
        member.latestExtraction.outcome !== 'FAILED'
      )
        continue
      try {
        members[index] = {
          ...member,
          latestExtraction: await runMember(batch, member),
        }
      } catch {
        // A member that could not reach its terminal write remains resumable;
        // one failure must not strand the rest of the persisted selection.
      }
    }
    return { ...batch, members }
  }

  function startOrResume(batch: BatchExtractionRecord) {
    const current = active.get(batch.batchExtractionId)
    if (current) return current
    // Deterministic member IDs and Extraction persistence protect correctness
    // across processes. ponytail: this map only joins calls in one Studio
    // process; add a persisted lease when multiple batch workers are introduced.
    const operation = run(batch).finally(() => {
      if (active.get(batch.batchExtractionId) === operation)
        active.delete(batch.batchExtractionId)
    })
    active.set(batch.batchExtractionId, operation)
    return operation
  }

  async function open(request: Request): Promise<Response> {
    const parsed = batchExtractionRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_request',
        'The Batch Extraction request is invalid.',
      )
    const { projectContextId, force, ...selection } = parsed.data
    const opened = await store
      .createBatchExtraction(projectContextId, {
        batchExtractionId: force
          ? randomUUID()
          : batchExtractionId({ projectContextId, ...selection }),
        ...selection,
      })
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!opened)
      throw new ApiError(404, 'not_found', 'Project Context was not found.')
    if (!('batch' in opened)) {
      throw new ApiError(
        422,
        'invalid_batch_selection',
        'Use the Current Schema Revision and Source Documents in this Project Context with a Source Representation.',
      )
    }
    const batch = await startOrResume(opened.batch)
    return json(
      batchExtractionResponseSchema.parse({
        batchExtraction: batchDto(batch),
        disposition: disposition(opened.status, batch),
      }),
      { status: opened.status === 'created' ? 201 : 200, headers: noStore },
    )
  }

  async function list(url: URL): Promise<Response> {
    const projectContextId = url.searchParams.get('projectContextId')
    if (
      !projectContextId ||
      !canonicalUuidSchema.safeParse(projectContextId).success
    )
      throw new ApiError(
        422,
        'invalid_request',
        'projectContextId must be a canonical lowercase UUID.',
      )
    const batches = await store
      .listBatchExtractions(projectContextId, boundedLimit(url))
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!batches)
      throw new ApiError(404, 'not_found', 'Project Context was not found.')
    return json(
      batchExtractionListResponseSchema.parse({
        batchExtractions: batches.map(batchDto),
      }),
      { headers: noStore },
    )
  }

  return async function batchExtractionsApi(
    request: Request,
  ): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.pathname !== COLLECTION_ROUTE)
        throw new ApiError(404, 'not_found', 'API route not found.')
      if (request.method === 'POST') return await open(request)
      return await list(url)
    } catch (error) {
      return noStoreError(error)
    }
  }
}

const handle = createBatchExtractionsApi()
export const GET = handle
export const POST = handle
