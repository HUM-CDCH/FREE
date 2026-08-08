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
} from '../../../packages/db/src/project-store.js'
import {
  canonicalPackageStore,
  type CanonicalArtifact,
  type CanonicalArtifactRead,
  type CanonicalPackageDescriptor,
} from '../../../packages/db/src/artifact-store.js'
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

/** Representation-pinned artifacts are immutable, and private to this researcher. */
const IMMUTABLE = { 'Cache-Control': 'private, max-age=31536000, immutable' }
type ArtifactReader = (
  descriptor: CanonicalPackageDescriptor,
  artifact: CanonicalArtifact,
) => Promise<CanonicalArtifactRead>

function artifactUnavailable(cause: unknown): ApiError {
  return new ApiError(
    503,
    'source_artifact_unavailable',
    'The retained Source Document artifact is unavailable.',
    { cause },
  )
}

function decodedSource(bytes: Uint8Array) {
  try {
    return decodeParsedDocument(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    )
  } catch (cause) {
    throw artifactUnavailable(cause)
  }
}

function pdfRange(
  value: string,
  total: number,
): { start: number; endExclusive: number } | false {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) return false
  if (match[1]) {
    const start = Number(match[1])
    const requestedEnd = match[2] ? Number(match[2]) : total - 1
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start >= total ||
      requestedEnd < start
    )
      return false
    return { start, endExclusive: Math.min(requestedEnd + 1, total) }
  }
  const suffix = Number(match[2])
  if (!Number.isSafeInteger(suffix) || suffix <= 0 || total === 0) return false
  return { start: Math.max(total - suffix, 0), endExclusive: total }
}

export function createSourceRepresentationResource(
  store: Pick<ProjectStore, 'getSourceRepresentation'> = createProjectStore(),
  readArtifact: ArtifactReader = canonicalPackageStore.read,
) {
  async function retained(
    descriptor: CanonicalPackageDescriptor,
    artifact: CanonicalArtifact,
  ) {
    return readArtifact(descriptor, artifact).catch((cause: unknown) => {
      throw artifactUnavailable(cause)
    })
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

      const kind = artifact as CanonicalArtifact
      const retainedArtifact = await retained(descriptor, kind)
      const requested =
        kind === 'pdf' && !request.headers.has('if-range')
          ? request.headers.get('range')
          : null
      const range = requested
        ? pdfRange(requested, retainedArtifact.bytes.byteLength)
        : null
      if (range === false)
        return new Response(null, {
          status: 416,
          headers: {
            ...IMMUTABLE,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes */${retainedArtifact.bytes.byteLength}`,
          },
        })

      const headers = new Headers(IMMUTABLE)
      headers.set('Content-Type', retainedArtifact.mediaType)
      if (kind === 'pdf') headers.set('Accept-Ranges', 'bytes')
      const selectedSize = range
        ? range.endExclusive - range.start
        : retainedArtifact.bytes.byteLength
      headers.set('Content-Length', String(selectedSize))
      if (range)
        headers.set(
          'Content-Range',
          `bytes ${range.start}-${range.endExclusive - 1}/${retainedArtifact.bytes.byteLength}`,
        )

      if (kind === 'source') {
        const body = JSON.stringify(decodedSource(retainedArtifact.bytes))
        headers.set('Content-Length', String(Buffer.byteLength(body)))
        return new Response(request.method === 'HEAD' ? null : body, { headers })
      }
      if (request.method === 'HEAD') return new Response(null, { headers })
      const bytes = range
        ? retainedArtifact.bytes.slice(range.start, range.endExclusive)
        : retainedArtifact.bytes
      return new Response(
        Uint8Array.from(bytes),
        { status: range ? 206 : 200, headers },
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
  readArtifact: ArtifactReader = canonicalPackageStore.read,
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
      const source = await readArtifact(descriptor, 'source').catch(
        (cause: unknown) => {
          throw artifactUnavailable(cause)
        },
      )
      const document = decodedSource(source.bytes)
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
