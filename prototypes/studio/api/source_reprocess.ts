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
import {
  discardPublishedPackage,
  parseSourceDocument,
  type Dependencies,
} from './source_documents.js'

type Store = Pick<
  ResearcherProjectStore,
  | 'getDocumentReopenSnapshot'
  | 'getSourceRepresentation'
  | 'findReprocessedSourceDocument'
  | 'reprocessSourceDocument'
  | 'discardCanonicalPackage'
>
export function createSourceDocumentReprocessing(
  store: Store,
  dependencies: Dependencies & {
    readPackage?: typeof canonicalPackageStore.read
  } = {},
) {
  return async (request: Request): Promise<Response> => {
    let saved:
      Awaited<ReturnType<typeof parseSourceDocument>>['saved'] | undefined
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
        const source = await (
          dependencies.readPackage ?? canonicalPackageStore.read
        )(descriptor, 'source')
        return json(
          {
            ...result,
            pageCount: JSON.parse(new TextDecoder().decode(source.bytes))
              .page_count,
          },
          { headers: noStore },
        )
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
      const descriptor = await store.getSourceRepresentation(
        projectId,
        expectedRepresentationId,
      )
      if (!descriptor)
        throw new ApiError(
          404,
          'not_found',
          'Source representation was not found.',
        )
      const pdf = await (
        dependencies.readPackage ?? canonicalPackageStore.read
      )(descriptor, 'pdf')
      const parsed = await parseSourceDocument(
        pdf.bytes,
        snapshot.sourceDocument.name,
        requestKey,
        layout === 'pages' ? 'pdf' : 'ingest',
        store,
        dependencies,
      )
      saved = parsed.saved
      const published = await store.reprocessSourceDocument(
        projectId,
        documentId,
        { ...parsed.input, expectedRepresentationId, requestFingerprint },
      )
      if (!published)
        throw new ApiError(404, 'not_found', 'Source Document was not found.')
      if (
        published.descriptor.artifactReference !== saved.artifactReference ||
        published.descriptor.artifactSha256 !== saved.artifactSha256
      )
        await discardPublishedPackage(saved, store)
      const { descriptor: retained, ...result } = published
      const source = await (
        dependencies.readPackage ?? canonicalPackageStore.read
      )(retained, 'source')
      return json(
        {
          ...result,
          pageCount: JSON.parse(new TextDecoder().decode(source.bytes))
            .page_count,
        },
        { status: 201, headers: noStore },
      )
    } catch (error) {
      if (saved) await discardPublishedPackage(saved, store)
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
