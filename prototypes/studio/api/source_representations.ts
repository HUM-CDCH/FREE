/// <reference types="vite/client" />

import {
  ApiError,
  noStoreError,
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
import { decodeParsedDocument } from 'extraction/parsed-document'

const ROUTE =
  /^\/api\/source-representations\/([^/]+)\/(pdf|markdown|source)$/

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
