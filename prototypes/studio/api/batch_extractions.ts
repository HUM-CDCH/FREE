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
import {
  projectOperations,
  type ProjectOperations,
} from './_project_operations.js'

const COLLECTION_ROUTE = '/api/batch-extractions'
const ITEM_ROUTE = /^\/api\/batch-extractions\/([0-9a-f-]+)$/
const RETRY_ROUTE = /^\/api\/batch-extractions\/([0-9a-f-]+)\/retry$/

type BatchExtractionStore = Pick<
  ProjectStore,
  'createBatchExtraction' | 'listBatchExtractions'
>

type ExtractionPost = (request: Request) => Promise<Response>

type RunResult = {
  batch: BatchExtractionRecord
  memberFailures: { sourceDocumentId: string; message: string }[]
}

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
    batchExtractionId: batch.batchExtractionId,
    projectContextId: batch.projectContextId,
    schemaRevisionId: batch.schemaRevisionId,
    extractionSchemaId: batch.extractionSchemaId,
    extractionSchemaName: batch.extractionSchemaName,
    schemaRevisionNumber: batch.schemaRevisionNumber,
    strategy: batch.strategy,
    executionStatus: batch.executionStatus ?? 'COMPLETED',
    executionFailureMessage: failureMessage(batch.executionFailure ?? null),
    startedAt: batch.startedAt?.toISOString() ?? null,
    finishedAt: batch.finishedAt?.toISOString() ?? null,
    createdAt: batch.createdAt.toISOString(),
    members: batch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
      executionStatus:
        member.executionStatus ??
        (member.latestExtraction ? 'COMPLETED' : 'QUEUED'),
      executionFailureMessage: failureMessage(member.executionFailure ?? null),
      startedAt: member.startedAt?.toISOString() ?? null,
      finishedAt: member.finishedAt?.toISOString() ?? null,
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
  if (!failure || typeof failure !== 'object') return null
  const stored = failure as { code?: unknown; message?: unknown }
  if (stored.code === 'unexpected_failure')
    return 'The operation failed unexpectedly.'
  return typeof stored.message === 'string' ? stored.message : null
}

const MEMBER_NOT_RUN = 'The member Extraction did not finish.'

/** The Extraction route's own sentence, so the researcher reads a real reason. */
async function refusalMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null)
  const error =
    body && typeof body === 'object'
      ? (body as { error?: unknown }).error
      : null
  const message =
    error && typeof error === 'object'
      ? (error as { message?: unknown }).message
      : null
  return typeof message === 'string' && message ? message : MEMBER_NOT_RUN
}

function createLegacyBatchExtractionsApi(
  store: BatchExtractionStore = createProjectStore(),
  executeExtraction: ExtractionPost = postExtraction,
) {
  const active = new Map<string, Promise<RunResult>>()

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
    if (!response.ok) throw new Error(await refusalMessage(response))
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

  async function run(batch: BatchExtractionRecord): Promise<RunResult> {
    const members = [...batch.members]
    const memberFailures: RunResult['memberFailures'] = []
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
      } catch (error) {
        // A member that could not reach its terminal write remains resumable;
        // one failure must not strand the rest of the persisted selection. It
        // leaves nothing behind to read, so it is reported with this response
        // rather than silently reading as a member that was never attempted.
        memberFailures.push({
          sourceDocumentId: member.sourceDocumentId,
          message: error instanceof Error ? error.message : MEMBER_NOT_RUN,
        })
      }
    }
    return { batch: { ...batch, members }, memberFailures }
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
    const { batch, memberFailures } = await startOrResume(opened.batch)
    return json(
      batchExtractionResponseSchema.parse({
        batchExtraction: batchDto(batch),
        disposition: disposition(opened.status, batch),
        memberFailures,
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

type DurableBatchExtractionStore = Pick<
  ProjectStore,
  | 'createBatchExtraction'
  | 'listBatchExtractions'
  | 'getBatchExtraction'
  | 'retryBatchExtraction'
>

/** The HTTP boundary schedules durable work; it never waits for model execution. */
export function createBatchExtractionsApi(
  store?: BatchExtractionStore,
  executeExtraction?: ExtractionPost,
): (request: Request) => Promise<Response>
export function createBatchExtractionsApi(
  store?: DurableBatchExtractionStore,
  operations?: ProjectOperations,
): (request: Request) => Promise<Response>
export function createBatchExtractionsApi(
  store: BatchExtractionStore | DurableBatchExtractionStore = createProjectStore(),
  operationsOrExecute: ProjectOperations | ExtractionPost = projectOperations,
) {
  if (typeof operationsOrExecute === 'function')
    return createLegacyBatchExtractionsApi(store as BatchExtractionStore, operationsOrExecute)
  const durableStore = store as DurableBatchExtractionStore
  const operations = operationsOrExecute
  const open = async (request: Request) => {
    const parsed = batchExtractionRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_request',
        'The Batch Extraction request is invalid.',
      )
    const selection = parsed.data
    const opened = await durableStore
      .createBatchExtraction(selection.projectContextId, {
        batchExtractionId: batchExtractionId(selection),
        schemaRevisionId: selection.schemaRevisionId,
        strategy: selection.strategy,
        sourceDocumentIds: selection.sourceDocumentIds,
      })
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!opened)
      throw new ApiError(404, 'not_found', 'Project Context was not found.')
    if (!('batch' in opened))
      throw new ApiError(
        422,
        'invalid_batch_selection',
        'Use the Current Schema Revision and Source Documents in this Project Context with a Source Representation.',
      )
    operations.kick()
    return json(
      batchExtractionResponseSchema.parse({
        batchExtraction: batchDto(opened.batch),
      }),
      { status: 202, headers: noStore },
    )
  }

  const list = async (url: URL) => {
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
    operations.kick()
    const batches = await durableStore
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

  const read = async (url: URL, batchExtractionId: string) => {
    const projectContextId = url.searchParams.get('projectContextId')
    if (
      !projectContextId ||
      !canonicalUuidSchema.safeParse(projectContextId).success ||
      !canonicalUuidSchema.safeParse(batchExtractionId).success
    )
      throw new ApiError(422, 'invalid_request', 'The Batch Extraction identity is invalid.')
    operations.kick()
    const batch = await durableStore
      .getBatchExtraction(projectContextId, batchExtractionId)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!batch)
      throw new ApiError(404, 'not_found', 'Batch Extraction was not found.')
    return json(
      batchExtractionResponseSchema.parse({ batchExtraction: batchDto(batch) }),
      { headers: noStore },
    )
  }

  const retry = async (url: URL, batchExtractionId: string) => {
    const projectContextId = url.searchParams.get('projectContextId')
    if (
      !projectContextId ||
      !canonicalUuidSchema.safeParse(projectContextId).success ||
      !canonicalUuidSchema.safeParse(batchExtractionId).success
    )
      throw new ApiError(422, 'invalid_request', 'The Batch Extraction identity is invalid.')
    const batch = await durableStore
      .retryBatchExtraction(projectContextId, batchExtractionId)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!batch)
      throw new ApiError(404, 'not_found', 'Batch Extraction was not found.')
    operations.kick()
    return json(
      batchExtractionResponseSchema.parse({ batchExtraction: batchDto(batch) }),
      { status: 202, headers: noStore },
    )
  }

  return async function batchExtractionsApi(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname === COLLECTION_ROUTE)
        return await open(request)
      if (request.method === 'GET' && url.pathname === COLLECTION_ROUTE)
        return await list(url)
      const retryMatch = RETRY_ROUTE.exec(url.pathname)
      if (request.method === 'POST' && retryMatch)
        return await retry(url, retryMatch[1])
      const itemMatch = ITEM_ROUTE.exec(url.pathname)
      if (request.method === 'GET' && itemMatch)
        return await read(url, itemMatch[1])
      throw new ApiError(404, 'not_found', 'API route not found.')
    } catch (error) {
      return noStoreError(error)
    }
  }
}

const handle = createBatchExtractionsApi()
export const GET = handle
export const POST = handle
