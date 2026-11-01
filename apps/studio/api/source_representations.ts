/// <reference types="vite/client" />

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  ApiError,
  noStoreError,
  persistenceUnavailable,
} from './_http.js'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import {
  canonicalPackageStore,
  createWorkerLane,
  type CanonicalArtifact,
  type CanonicalArtifactRead,
  type CanonicalPackageDescriptor,
} from '../../../packages/db/src/artifact-store.js'
import {
  canonicalUuidSchema,
} from '../shared/projectContext.contract.js'

const ROUTE =
  /^\/api\/project-contexts\/([^/]+)\/source-representations\/([^/]+)\/(pdf|markdown|source)$/

/** Account-private artifacts must never survive a logout in the browser cache. */
const PRIVATE_RESPONSE = { 'Cache-Control': 'no-store' }
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

/**
 * The source decoder's whole program: the strict parsed-document decoder and the response's serialization, which for
 * a large document stall an event loop as long as reading its package does. It is evaluated from this source, like
 * `_pdf_pages.ts`'s counter, so it runs the same under Vitest, the development server and the built server bundle; the
 * decoder is imported from the path this module resolved. It is valid as either CommonJS or an ES module, since a
 * worker inherits the main script's `--input-type`. Each message is a parsed document's bytes, moved here; the answer
 * is the response body's bytes, moved back.
 */
const DECODER = `
import('node:worker_threads').then(({ parentPort, workerData }) => {
  const decoder = import(workerData.parsedDocument)
  parentPort.on('message', async (bytes) => {
    try {
      const { decodeParsedDocument } = await decoder
      const body = new TextEncoder().encode(JSON.stringify(decodeParsedDocument(JSON.parse(new TextDecoder().decode(bytes)))))
      parentPort.postMessage({ value: body }, [body.buffer])
    } catch (error) {
      parentPort.postMessage({ error: { message: error instanceof Error ? error.message : String(error) } })
    }
  })
})
`

/** Waiting documents hold their bytes, so few may wait, and never more than this many bytes between them. */
const SOURCE_DECODER_WAITING = { maxWaiting: 8, maxWaitingBytes: 256 * 1024 * 1024 }

let decoder: ((bytes: Uint8Array, transfer: readonly ArrayBuffer[]) => Promise<Uint8Array<ArrayBuffer>>) | undefined

/** The allow-listed parsed document as the response body, decoded on the source decoder's thread. */
function decodedSource(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  decoder ??= createWorkerLane<Uint8Array, Uint8Array<ArrayBuffer>>(() => new Worker(DECODER, {
    eval: true,
    workerData: {
      parsedDocument: pathToFileURL(createRequire(import.meta.url).resolve('extraction/parsed-document')).href,
    },
  }), SOURCE_DECODER_WAITING)
  // Move a buffer the bytes have to themselves; copy only bytes that share a larger one.
  const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice()
  return decoder(own, [own.buffer as ArrayBuffer]).catch((cause: unknown) => {
    throw artifactUnavailable(cause)
  })
}

/** A body of bytes this response owns, sent as they are: `new Response(bytes)` would first copy them on this thread. */
function ownedBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
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
  store: Pick<ResearcherProjectStore, 'getSourceRepresentation'>,
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
      const [, projectContextId, sourceRepresentationId, artifact] = match
      if (
        !canonicalUuidSchema.safeParse(projectContextId).success ||
        !canonicalUuidSchema.safeParse(sourceRepresentationId).success
      )
        throw new ApiError(
          422,
          'invalid_request',
          'Project Context and Source Representation identities must be canonical lowercase UUIDs.',
        )

      const descriptor = await store
        .getSourceRepresentation(projectContextId, sourceRepresentationId)
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
            ...PRIVATE_RESPONSE,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes */${retainedArtifact.bytes.byteLength}`,
          },
        })

      const headers = new Headers(PRIVATE_RESPONSE)
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
        const body = await decodedSource(retainedArtifact.bytes)
        headers.set('Content-Length', String(body.byteLength))
        return new Response(request.method === 'HEAD' ? null : ownedBody(body), { headers })
      }
      if (request.method === 'HEAD') return new Response(null, { headers })
      const bytes = range
        ? retainedArtifact.bytes.slice(range.start, range.endExclusive)
        : retainedArtifact.bytes
      return new Response(ownedBody(bytes), { status: range ? 206 : 200, headers })
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  const GET = createSourceRepresentationResource(store)
  return { GET, HEAD: GET }
}
