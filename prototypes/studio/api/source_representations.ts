/// <reference types="vite/client" />

import { ApiError, noStoreError, persistenceUnavailable } from './_http.js'
import {
  createProjectStore,
  type ProjectStore,
  type SourceRepresentationArtifacts,
} from '../../../packages/db/src/project-store.js'
import {
  canonicalUuidSchema,
  parsedDocumentResourceSchema,
} from '../shared/projectContext.contract.js'
import { z } from 'zod'

const ROUTE =
  /^\/api\/source-representations\/([^/]+)\/(pdf|markdown|parsed-document)$/

/**
 * The Parsing Service retains every published artifact and `artifactReference`
 * is its opaque handle. Studio resolves and streams the bytes itself so no
 * reference, path, or upstream URL reaches the browser. The base is the same
 * override the browser uses (see src/api.ts).
 */
const PARSING_SERVICE =
  (import.meta.env.VITE_PARSING_SERVICE_URL as string | undefined) ??
  'http://127.0.0.1:8000'
/** Keyed by the path segment `ROUTE` allows, so no artifact name is unchecked. */
const ARTIFACTS: Record<string, { upstream: string; mediaType: string }> = {
  pdf: { upstream: 'source', mediaType: 'application/pdf' },
  markdown: { upstream: 'markdown', mediaType: 'text/markdown; charset=utf-8' },
  'parsed-document': { upstream: 'document', mediaType: 'application/json' },
}
/** Representation-pinned artifacts are immutable, and private to this researcher. */
const IMMUTABLE = { 'Cache-Control': 'private, max-age=31536000, immutable' }
const MIRRORED = ['content-length', 'content-range', 'accept-ranges'] as const

function artifactUnavailable(cause: unknown): ApiError {
  return new ApiError(
    503,
    'source_artifact_unavailable',
    'The retained Source Document artifact is unavailable.',
    { cause },
  )
}

// Unknown keys are dropped, not rejected: the canonical parsed document carries
// far more than the browser may read.
const storedParsedDocumentSchema = z.object({
  schema_version: z.string(),
  document: z.object({ page_count: z.number().int() }),
  pages: z.array(z.object({ page: z.number().int(), text: z.string() })),
})

/** Only content crosses into the browser: no refs, hashes, or parser diagnostics. */
function parsedDocumentResource(
  document: unknown,
): z.output<typeof parsedDocumentResourceSchema> {
  const stored = storedParsedDocumentSchema.safeParse(document)
  if (!stored.success) throw artifactUnavailable(stored.error)
  return {
    schemaVersion: stored.data.schema_version,
    pageCount: stored.data.document.page_count,
    pages: stored.data.pages,
  }
}

export function createSourceRepresentationResource(
  store: Pick<ProjectStore, 'getSourceRepresentation'> = createProjectStore(),
  fetchArtifact: typeof fetch = fetch,
) {
  async function upstream(
    descriptor: SourceRepresentationArtifacts,
    artifact: string,
    request: Request,
  ): Promise<Response> {
    const headers = new Headers()
    if (artifact === 'pdf' && !request.headers.has('if-range')) {
      const range = request.headers.get('range')
      if (range !== null) headers.set('range', range)
    }
    const response = await fetchArtifact(
      `${PARSING_SERVICE}/tasks/${descriptor.artifactReference}/${ARTIFACTS[artifact].upstream}`,
      {
        // The projection needs the body, so a parsed-document HEAD still reads it.
        method:
          request.method === 'HEAD' && artifact !== 'parsed-document'
            ? 'HEAD'
            : 'GET',
        headers,
      },
    ).catch((cause: unknown) => {
      throw artifactUnavailable(cause)
    })
    if (!response.ok && response.status !== 206 && response.status !== 416)
      throw artifactUnavailable(response.status)
    return response
  }

  return async function sourceRepresentationResource(
    request: Request,
  ): Promise<Response> {
    try {
      const match = ROUTE.exec(new URL(request.url).pathname)
      if (!match) throw new ApiError(404, 'not_found', 'API route not found.')
      const [, sourceRepresentationId, artifact] = match
      if (!canonicalUuidSchema.safeParse(sourceRepresentationId).success)
        throw new ApiError(
          422,
          'invalid_request',
          'sourceRepresentationId must be a canonical lowercase UUID.',
        )

      const descriptor = await store
        .getSourceRepresentation(sourceRepresentationId)
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!descriptor)
        throw new ApiError(
          404,
          'not_found',
          'That Source Representation was not found.',
        )

      const headers = new Headers(IMMUTABLE)

      const response = await upstream(descriptor, artifact, request)
      headers.set('Content-Type', ARTIFACTS[artifact].mediaType)
      for (const name of MIRRORED) {
        const value = response.headers.get(name)
        if (value !== null) headers.set(name, value)
      }
      // The unsatisfiable-range body is an upstream error page, so it is dropped
      // and must not be announced. `Content-Range` still carries the full length.
      if (response.status === 416) headers.delete('Content-Length')

      if (artifact === 'parsed-document') {
        const body = JSON.stringify(
          parsedDocumentResource(
            await response.json().catch((cause: unknown) => {
              throw artifactUnavailable(cause)
            }),
          ),
        )
        headers.set('Content-Length', String(Buffer.byteLength(body)))
        return new Response(request.method === 'HEAD' ? null : body, { headers })
      }
      return new Response(
        request.method === 'HEAD' || response.status === 416
          ? null
          : response.body,
        { status: response.status, headers },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export const GET = createSourceRepresentationResource()
export const HEAD = GET
