import { createHash } from 'node:crypto'
import { canonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import {
  ReprocessConflictError,
  type ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { sourceDocumentReprocessRequestSchema } from '../shared/sourceDocumentReprocess.contract.js'
import {
  ApiError,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import { packagePageCount } from './_kei_conversion.js'

type Store = Pick<
  ResearcherProjectStore,
  | 'getDocumentReopenSnapshot'
  | 'findReprocessedSourceDocument'
>

/**
 * Reprocessing between M4 Tasks 10 and 11: a published request key still replays its revision, and a stale head is
 * still refused, but new work has no conversion path until `reprocessSource` runs it on DBOS (Task 11). kei's HTTP
 * run submission that the old path used is gone since M3.
 */
export function createSourceDocumentReprocessing(
  store: Store,
  dependencies: { readPackage?: typeof canonicalPackageStore.read } = {},
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
      const replay = await store.findReprocessedSourceDocument(
        projectId,
        documentId,
        requestKey,
        requestFingerprint,
      )
      if (replay) {
        const { descriptor, ...result } = replay
        const pageCount = await packagePageCount(descriptor, {
          read: dependencies.readPackage ?? canonicalPackageStore.read,
        })
        return json({ ...result, pageCount }, { headers: noStore })
      }
      const snapshot = await store.getDocumentReopenSnapshot(
        projectId,
        documentId,
      )
      if (!snapshot)
        throw new ApiError(404, 'not_found', 'Source Document was not found.')
      if (
        snapshot.sourceRepresentation.sourceRepresentationId !==
        expectedRepresentationId
      )
        throw new ReprocessConflictError()
      throw new ApiError(
        503,
        'source_ingestion_failed',
        'Source Document reprocessing is unavailable.',
      )
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
