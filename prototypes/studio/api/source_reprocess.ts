import { createHash } from 'node:crypto'
import type { DBOSClient } from '@dbos-inc/dbos-sdk'
import { conversionLane } from 'extraction/kei-handoff'
import { canonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import {
  ReprocessConflictError,
  type ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { REPROCESS_TERMINAL_HEADER, sourceDocumentReprocessRequestSchema } from '../shared/sourceDocumentReprocess.contract.js'
import { awaitWorkflowOutcome, STUDIO_QUEUE, studioDbos } from '../server/dbos.js'
import {
  ApiError,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import { packagePageCount } from './_kei_conversion.js'
import { configuredIngestionModels } from './_model_config.js'
import { REPROCESS_SOURCE, type ReprocessInput, type ReprocessOutcome } from './_reprocess_workflow.js'

type Store = Pick<
  ResearcherProjectStore,
  | 'researcherAccountId'
  | 'getDocumentReopenSnapshot'
  | 'getSourceRepresentation'
  | 'findReprocessedSourceDocument'
>

export function createSourceDocumentReprocessing(
  store: Store,
  dependencies: {
    readPackage?: typeof canonicalPackageStore.read
    admission?: Pick<DBOSClient, 'enqueue' | 'listWorkflows'>
    ingestionModels?: (owner: string) => Promise<{ ocr: string | null; layout: string | null }>
    resultTimeoutMs?: number
    resultPollIntervalMs?: number
  } = {},
) {
  return async (request: Request): Promise<Response> => {
    try {
      const match =
        /^\/api\/project-contexts\/([^/]+)\/source-documents\/([^/]+)\/reprocess$/.exec(
          new URL(request.url).pathname,
        )
      if (!match)
        throw new ApiError(
          404,
          'not_found',
          'Source Document route was not found.',
        )
      const [, projectId, documentId] = match
      if (
        ![projectId, documentId].every(
          (id) => canonicalUuidSchema.safeParse(id).success,
        )
      )
        throw new ApiError(
          422,
          'invalid_request',
          'Identities must be canonical lowercase UUIDs.',
        )
      const body = sourceDocumentReprocessRequestSchema.safeParse(
        await parseJsonRequest(request),
      )
      if (!body.success)
        throw new ApiError(
          422,
          'invalid_request',
          'Provide a request key, current representation identity, and page layout.',
        )
      const { requestKey, expectedRepresentationId, layout } = body.data
      const requestFingerprint = createHash('sha256')
        .update(JSON.stringify([documentId, expectedRepresentationId, layout]))
        .digest('hex')
      const publishedResponse = async (revision: NonNullable<Awaited<ReturnType<Store['findReprocessedSourceDocument']>>>) => {
        const { descriptor, ...result } = revision
        const pageCount = await packagePageCount(descriptor, {
          read: dependencies.readPackage ?? canonicalPackageStore.read,
        })
        return json({ ...result, pageCount }, { headers: noStore })
      }
      const replay = await store.findReprocessedSourceDocument(
        projectId,
        documentId,
        requestKey,
        requestFingerprint,
      )
      if (replay) return publishedResponse(replay)
      const workflowId = `reprocess:${documentId}:${requestKey}`
      const admission = dependencies.admission ?? studioDbos().admission
      const recordedFingerprint = async () => {
        const [recorded] = await admission.listWorkflows({ workflowIDs: [workflowId], loadInput: true, loadOutput: false })
        return recorded ? ((recorded.input?.[0] ?? {}) as { requestFingerprint?: string }).requestFingerprint ?? null : undefined
      }
      const snapshot = await store.getDocumentReopenSnapshot(
        projectId,
        documentId,
      )
      if (!snapshot)
        throw new ApiError(404, 'not_found', 'Source Document was not found.')
      const known = await recordedFingerprint()
      if (known !== undefined && known !== requestFingerprint) throw new ReprocessConflictError()
      if (known === undefined &&
        snapshot.sourceRepresentation.sourceRepresentationId !==
        expectedRepresentationId
      )
        throw new ReprocessConflictError()
      if (known === undefined) {
        const descriptor = await store.getSourceRepresentation(projectId, expectedRepresentationId)
        if (!descriptor) throw new ApiError(404, 'not_found', 'Source Document was not found.')
        const owner = store.researcherAccountId
        const pageCount = await packagePageCount(descriptor, { read: dependencies.readPackage ?? canonicalPackageStore.read })
        const input: ReprocessInput = {
          projectContextId: projectId, sourceDocumentId: documentId, requestKey, requestFingerprint,
          expectedRepresentationId, owner, originalName: snapshot.sourceDocument.name,
          pageSource: layout === 'pages' ? 'pdf' : 'ingest', pageCount, lane: conversionLane(pageCount),
          models: await (dependencies.ingestionModels ?? configuredIngestionModels)(owner),
        }
        try {
          await admission.enqueue({
            workflowName: REPROCESS_SOURCE, queueName: STUDIO_QUEUE, workflowID: workflowId,
            authenticatedUser: owner,
            attributes: { projectContextId: projectId, sourceDocumentId: documentId,
              sourceRepresentationRevisionId: expectedRepresentationId },
          }, input)
        } catch (error) {
          // A concurrent first request may have admitted this key. Its stored input decides whether this is a join.
          if (await recordedFingerprint() === undefined) throw error
        }
        if ((await recordedFingerprint()) !== requestFingerprint) throw new ReprocessConflictError()
      }
      const awaited = await awaitWorkflowOutcome<ReprocessOutcome>(admission, workflowId, {
        timeoutMs: dependencies.resultTimeoutMs ?? 30 * 60 * 1000,
        intervalMs: dependencies.resultPollIntervalMs,
        signal: request.signal,
      })
      if (awaited.state === 'timed-out')
        throw new ApiError(504, 'source_ingestion_timeout', 'Source Document parsing did not finish within thirty minutes.')
      const terminalFailure = (status: number, code: string, message: string) => {
        const response = noStoreError(new ApiError(status, code, message))
        response.headers.set(REPROCESS_TERMINAL_HEADER, '1')
        return response
      }
      if (awaited.state === 'stopped') {
        const published = await store.findReprocessedSourceDocument(projectId, documentId, requestKey, requestFingerprint)
        if (published) return publishedResponse(published)
        return terminalFailure(502, 'source_ingestion_failed', 'Source Document parsing stopped before it finished.')
      }
      if (!awaited.output.ok)
        return terminalFailure(awaited.output.status, awaited.output.code, awaited.output.message)
      return json({ ...awaited.output.revision, pageCount: awaited.output.pageCount }, { status: 201, headers: noStore })
    } catch (error) {
      return noStoreError(
        error instanceof ReprocessConflictError
          ? new ApiError(409, 'invalid_request', error.message)
          : error instanceof ApiError
            ? error
            : persistenceUnavailable(error),
      )
    }
  }
}
export function createResearcherApiHandlers(store: ResearcherProjectStore) {
  return { POST: createSourceDocumentReprocessing(store) }
}
