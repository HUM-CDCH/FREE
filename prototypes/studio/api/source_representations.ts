/// <reference types="vite/client" />

import {
  ApiError,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import {
  createProjectStore,
  type ProjectStore,
  type SourceRepresentationArtifacts,
} from '../../../packages/db/src/project-store.js'
import {
  canonicalUuidSchema,
} from '../shared/projectContext.contract.js'
import {
  cleanExtractionResultSchema,
  evidenceLinkSchema,
  evidenceLinksHaveUniqueScalarPaths,
  groundedModelAttributionSchema,
} from '../shared/groundedExtraction.js'
import { decodeParsedDocument } from '../src/parsedDocument.js'
import { z } from 'zod'

const ROUTE =
  /^\/api\/source-representations\/([^/]+)\/(pdf|markdown|source)$/
const REVIEW_ROUTE =
  /^\/api\/source-representations\/([^/]+)\/extraction-reviews$/
const reviewDecisionInputSchema = z
  .object({
    evidenceAnchorId: z.string().min(1),
    reviewedOccurrenceIds: z
      .array(z.string().min(1))
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
  })
  .strict()
const reviewedExtractionSchema = z
  .object({
    schemaRevisionId: canonicalUuidSchema,
    result: cleanExtractionResultSchema,
    evidenceLinks: z.array(evidenceLinkSchema).min(1),
    modelAttribution: groundedModelAttributionSchema,
    reviewDecisions: z.array(reviewDecisionInputSchema).min(1),
  })
  .strict()

/**
 * The Parsing Service retains every published artifact and `artifactReference`
 * is its opaque handle. Studio resolves and streams the bytes itself so no
 * reference, path, or upstream URL reaches the browser. The base is the same
 * override the browser uses (see src/api.ts).
 */
const PARSING_SERVICE =
  (import.meta as ImportMeta & { env?: ImportMetaEnv }).env
    ?.VITE_PARSING_SERVICE_URL ??
  'http://127.0.0.1:8000'
/** Keyed by the path segment `ROUTE` allows, so no artifact name is unchecked. */
const ARTIFACTS: Record<string, { upstream: string; mediaType: string }> = {
  pdf: { upstream: 'pdf', mediaType: 'application/pdf' },
  markdown: { upstream: 'markdown', mediaType: 'text/markdown; charset=utf-8' },
  source: { upstream: 'source', mediaType: 'application/json' },
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
        // Validation needs the body, so a source HEAD still reads it.
        method:
          request.method === 'HEAD' && artifact !== 'source'
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

      if (artifact === 'source') {
        const body = JSON.stringify(
          await response
            .json()
            .then(decodeParsedDocument)
            .catch((cause: unknown) => {
              throw artifactUnavailable(cause)
            }),
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

export function createPersistReviewedExtraction(
  store: Pick<
    ProjectStore,
    'getSourceRepresentation' | 'persistReviewedExtraction'
  > = createProjectStore(),
  fetchArtifact: typeof fetch = fetch,
) {
  return async function persistReviewedExtraction(
    request: Request,
  ): Promise<Response> {
    try {
      const match = REVIEW_ROUTE.exec(new URL(request.url).pathname)
      if (!match) throw new ApiError(404, 'not_found', 'API route not found.')
      const sourceRepresentationId = match[1]
      if (!canonicalUuidSchema.safeParse(sourceRepresentationId).success)
        throw new ApiError(
          422,
          'invalid_request',
          'sourceRepresentationId must be a canonical lowercase UUID.',
        )
      const parsedInput = reviewedExtractionSchema.safeParse(
        await parseJsonRequest(request),
      )
      if (!parsedInput.success)
        throw new ApiError(
          422,
          'invalid_request',
          'The reviewed Extraction payload is invalid.',
        )
      const input = parsedInput.data
      if (!evidenceLinksHaveUniqueScalarPaths(input.result, input.evidenceLinks))
        throw new ApiError(
          422,
          'invalid_request',
          'Every Evidence link requires one unique populated scalar result path.',
        )
      const referencedAnchors = new Set(
        input.evidenceLinks.map((link) => link.evidenceAnchorId),
      )
      if (
        new Set(input.reviewDecisions.map((decision) => decision.evidenceAnchorId))
          .size !== input.reviewDecisions.length
      )
        throw new ApiError(
          422,
          'invalid_request',
          'Each Evidence anchor can have only one ReviewDecision.',
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
      const response = await fetchArtifact(
        `${PARSING_SERVICE}/tasks/${descriptor.artifactReference}/source`,
      ).catch((cause: unknown) => {
        throw artifactUnavailable(cause)
      })
      if (!response.ok) throw artifactUnavailable(response.status)
      const document = await response
        .json()
        .then(decodeParsedDocument)
        .catch((cause: unknown) => {
          throw artifactUnavailable(cause)
        })
      const ownership = new Map(
        document.evidence_index.anchors.map((anchor) => [
          anchor.anchor_id,
          new Set(
            anchor.kind === 'text'
              ? [anchor.occurrence_id]
              : anchor.producer_observations.map(
                  (observation) => observation.occurrence_id,
                ),
          ),
        ]),
      )
      if ([...referencedAnchors].some((anchorId) => !ownership.has(anchorId)))
        throw new ApiError(
          422,
          'invalid_request',
          'The Extraction Result cites Evidence this Source Representation did not publish.',
        )
      for (const decision of input.reviewDecisions) {
        if (!referencedAnchors.has(decision.evidenceAnchorId))
          throw new ApiError(
            422,
            'invalid_request',
            'A ReviewDecision Evidence anchor is not referenced by the Extraction Result.',
          )
        const owned = ownership.get(decision.evidenceAnchorId)
        if (
          !owned ||
          decision.reviewedOccurrenceIds.some(
            (occurrenceId) => !owned.has(occurrenceId),
          )
        )
          throw new ApiError(
            422,
            'invalid_request',
            'A reviewed occurrence does not belong to its Evidence anchor.',
          )
      }
      if (input.reviewDecisions.length !== referencedAnchors.size)
        throw new ApiError(
          422,
          'invalid_request',
          'Every published Evidence anchor the Extraction Result cites requires one ReviewDecision.',
        )

      const persisted = await store
        .persistReviewedExtraction(sourceRepresentationId, {
          schemaRevisionId: input.schemaRevisionId,
          resultPayload: {
            result: input.result,
            evidenceLinks: input.evidenceLinks,
          },
          modelAttribution: input.modelAttribution,
          reviewDecisions: input.reviewDecisions,
        })
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!persisted)
        throw new ApiError(
          409,
          'invalid_request',
          'That Schema Revision does not belong to this Source Representation’s Project Context.',
        )
      return json(
        {
          extractionId: persisted.extractionId,
          createdAt: persisted.createdAt.toISOString(),
        },
        { status: 201, headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export const POST = createPersistReviewedExtraction()
