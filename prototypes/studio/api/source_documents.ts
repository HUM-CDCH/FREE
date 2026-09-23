import { createHash } from 'node:crypto'
import {
  ApiError,
  assertFormFields,
  json,
  noStore,
  noStoreError,
  parseFormRequest,
  persistenceUnavailable,
} from './_http.js'
import {
  keiExpManifestSchema,
  listedPages,
  parsedDocumentFromKeiExp,
  verifiedPage,
  type KeiExpManifest,
  type KeiExpPage,
  type TranslatedDocument,
} from './_kei_exp.js'
import {
  canonicalPackageStore,
  packCanonicalPackage,
  type CanonicalPackageDescriptor,
} from '../../../packages/db/src/artifact-store.js'
import {
  IngestionKeyConflictError,
  type IngestSourceDocumentInput,
  type IngestedSourceDocument,
  type ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { sourceDocumentFilenameFailure } from '../shared/sourceDocumentFilename.js'

const CONTRACT_VERSION = 'parsed_document.v2'
// kei-exp's API (`uv run uvicorn kei_exp.api:app --port 8001`); its worker
// switches to the native Docling path by itself for born-digital PDFs.
const DEFAULT_KEI_EXP = 'http://127.0.0.1:8001'
const DEFAULT_MODEL = 'surya'
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 1000
const MAX_PDF_BYTES = 100 * 1024 * 1024
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** The researcher's page layout: single PDF pages, or scanned two-page spreads split into book pages. */
const PAGE_SOURCE_OF_LAYOUT: ReadonlyMap<string, 'pdf' | 'ingest'> = new Map([
  ['pages', 'pdf'],
  ['spreads', 'ingest'],
])

type CanonicalPackage = {
  artifactReference: string
  artifactSha256: string
  document: unknown
  published?: boolean
}

type PackageStore = {
  save(packageBytes: Uint8Array): Promise<CanonicalPackage>
  available(descriptor: CanonicalPackageDescriptor): Promise<boolean>
}

type IngestionStore = Pick<
  ResearcherProjectStore,
  | 'getProjectContextWithDocuments'
  | 'ingestSourceDocument'
  | 'discardCanonicalPackage'
>

type Dependencies = {
  packageStore?: PackageStore
  fetcher?: typeof fetch
  parsingServiceBase?: string
  model?: string
  timeoutMs?: number
  pollIntervalMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}

type SourceDocumentDeletionStore = Pick<
  ResearcherProjectStore,
  'deleteSourceDocument'
>

function projectContextId(pathname: string): string {
  const match = /^\/api\/project-contexts\/([^/]+)\/source-documents$/.exec(
    pathname,
  )
  if (!match)
    throw new ApiError(404, 'not_found', 'Source Document route was not found.')
  if (!canonicalUuidSchema.safeParse(match[1]).success)
    throw new ApiError(
      422,
      'invalid_request',
      'projectContextId must be a canonical lowercase UUID.',
    )
  return match[1]
}

function sanitizedFilename(raw: string): string {
  const filenameFailure = sourceDocumentFilenameFailure(raw)
  if (filenameFailure)
    throw new ApiError(400, 'invalid_request', filenameFailure)
  let filename = raw
    .replace(/^.*[\\/]/, '')
    .replaceAll('\0', '')
    .trim()
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
  if (!filename) filename = 'source.pdf'
  if (!filename.toLowerCase().endsWith('.pdf'))
    throw new ApiError(
      400,
      'invalid_request',
      'The uploaded file must be a PDF.',
    )
  return filename
}

function required(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(`The parsed document is missing ${what}.`)
  return value
}

function sourceDocumentIds(pathname: string) {
  const match =
    /^\/api\/project-contexts\/([^/]+)\/source-documents\/([^/]+)$/.exec(
      pathname,
    )
  if (!match)
    throw new ApiError(404, 'not_found', 'Source Document route was not found.')
  if (!canonicalUuidSchema.safeParse(match[1]).success)
    throw new ApiError(
      422,
      'invalid_request',
      'projectContextId must be a canonical lowercase UUID.',
    )
  if (!canonicalUuidSchema.safeParse(match[2]).success)
    throw new ApiError(
      422,
      'invalid_request',
      'sourceDocumentId must be a canonical lowercase UUID.',
    )
  return { projectContextId: match[1], sourceDocumentId: match[2] }
}

function positiveInteger(value: unknown, what: string): number {
  if (!Number.isInteger(value) || Number(value) < 1)
    throw new Error(`The parsed document is missing ${what}.`)
  return Number(value)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`The parsed document is missing ${what}.`)
  return value as Record<string, unknown>
}

function provenance(document: unknown) {
  const parsed = record(document, 'metadata')
  const identity = record(parsed.document, 'Source Document identity')
  const contractVersion = required(parsed.schema_version, 'a contract version')
  if (contractVersion !== CONTRACT_VERSION)
    throw new Error(`The parsed document is not ${CONTRACT_VERSION}.`)
  const preprocessing = record(parsed.preprocessing, 'preprocessing metadata')
  const arbitration = record(parsed.arbitration, 'parser arbitration metadata')
  const parserName = required(
    arbitration.primary_document_parser,
    'its primary document parser',
  )
  const parserRuns = Array.isArray(parsed.parser_runs) ? parsed.parser_runs : []
  const selected = parserRuns.find((run) => {
    if (!run || typeof run !== 'object' || Array.isArray(run)) return false
    return (run as Record<string, unknown>).parser === parserName
  })
  const parserVersion =
    selected && typeof selected === 'object' && !Array.isArray(selected)
      ? (selected as Record<string, unknown>).version
      : undefined
  return {
    contentSha256: required(
      identity.content_sha256,
      'a Source Document content hash',
    ),
    pageCount: positiveInteger(parsed.page_count, 'a physical page count'),
    contractVersion,
    preprocessId: required(
      preprocessing.preprocess_id,
      'a preprocessing identity',
    ),
    parserName,
    parserVersion:
      typeof parserVersion === 'string' ? parserVersion : 'unknown',
  }
}

async function readJson(
  response: Response,
  what: string,
): Promise<Record<string, unknown>> {
  try {
    return record(await response.json(), what)
  } catch (cause) {
    throw new ApiError(
      502,
      'source_ingestion_failed',
      `The Parsing Service returned invalid ${what}.`,
      { cause },
    )
  }
}

async function parsingRequest<T>(
  fetcher: typeof fetch,
  base: string,
  path: string,
  rejectedMessage: string,
  consume: (response: Response) => Promise<T>,
  init?: RequestInit,
  accepted: (response: Response) => boolean = (response) => response.ok,
  // What a request that got no usable response at all (ECONNREFUSED, a reset
  // mid-body, an API restart) yields instead of failing; aborts stay a 504.
  unreachable?: (cause: unknown) => T,
): Promise<T> {
  try {
    const response = await fetcher(`${base.replace(/\/$/, '')}${path}`, init)
    if (!accepted(response))
      throw new ApiError(
        502,
        'source_ingestion_failed',
        rejectedMessage,
      )
    return await consume(response)
  } catch (error) {
    if (init?.signal?.aborted)
      throw new ApiError(
        504,
        'source_ingestion_timeout',
        'Source Document parsing did not finish within thirty minutes.',
        { cause: error },
      )
    if (error instanceof ApiError) throw error
    if (unreachable) return unreachable(error)
    throw new ApiError(
      502,
      'source_ingestion_failed',
      'The Parsing Service is unavailable.',
      { cause: error },
    )
  }
}

function sameDescriptor(
  left: CanonicalPackageDescriptor,
  right: CanonicalPackageDescriptor,
): boolean {
  return (
    left.artifactReference === right.artifactReference &&
    left.artifactSha256 === right.artifactSha256
  )
}

type Parser = {
  fetcher: typeof fetch
  base: string
  signal: AbortSignal
}

/**
 * `POST /api/runs`: kei-exp records the upload's hash before the run has a
 * queue position, so a run of other bytes is refused before any waiting.
 */
async function submittedRun(
  parser: Parser,
  pdf: Uint8Array<ArrayBuffer>,
  originalName: string,
  model: string,
  contentSha256: string,
  pageSource: 'pdf' | 'ingest',
): Promise<string> {
  const upload = new FormData()
  upload.append(
    'pdf',
    new Blob([pdf], { type: 'application/pdf' }),
    originalName,
  )
  upload.append('model', model)
  upload.append('debug', 'false')
  upload.append('cut', 'auto')
  upload.append('page_source', pageSource)
  const created = await parsingRequest(
    parser.fetcher,
    parser.base,
    '/api/runs',
    'Source Document parsing could not be started.',
    (response) => readJson(response, 'run submission response'),
    { method: 'POST', body: upload, signal: parser.signal },
  )
  const runId = created.id
  if (typeof runId !== 'string' || !RUN_ID.test(runId))
    throw new ApiError(
      502,
      'source_ingestion_failed',
      'The Parsing Service returned an invalid run identity.',
    )
  const params =
    created.params && typeof created.params === 'object'
      ? (created.params as Record<string, unknown>)
      : {}
  if (params.source_sha256 !== contentSha256)
    throw new ApiError(
      502,
      'source_ingestion_failed',
      'The Parsing Service recorded another Source Document.',
    )
  if (params.page_source !== pageSource)
    throw new ApiError(
      502,
      'source_ingestion_failed',
      'The Parsing Service recorded another page layout.',
    )
  return runId
}

/** A status read kei-exp asks to repeat: its store is briefly unreachable (503) or it is busy (429). */
const NOT_YET = new Set([429, 503])

function retryAfterMs(response: Response, fallbackMs: number): number {
  const header = response.headers.get('retry-after')
  const seconds = header === null ? Number.NaN : Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs
}

type Polled = { status: Record<string, unknown> } | { waitMs: number }

async function completedRun(
  parser: Parser,
  runId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  const deadline = now() + timeoutMs
  for (;;) {
    // A 503 or 429 on the status read, or no answer at all (the API
    // restarting while its worker keeps running), says nothing about the
    // run: keep polling, after Retry-After when given, until the deadline.
    const polled = await parsingRequest<Polled>(
      parser.fetcher,
      parser.base,
      `/api/runs/${runId}`,
      'Source Document parsing status is unavailable.',
      async (response) =>
        NOT_YET.has(response.status)
          ? { waitMs: retryAfterMs(response, pollIntervalMs) }
          : { status: await readJson(response, 'run status') },
      { signal: parser.signal },
      (response) => response.ok || NOT_YET.has(response.status),
      () => ({ waitMs: pollIntervalMs }),
    )
    let waitMs = pollIntervalMs
    if ('waitMs' in polled) waitMs = polled.waitMs
    else {
      const { status } = polled.status
      if (status === 'done') return
      if (status === 'failed' || status === 'cancelled')
        throw new ApiError(
          422,
          'source_ingestion_failed',
          'The Source Document could not be parsed.',
        )
      if (status !== 'queued' && status !== 'running' && status !== 'cancelling')
        throw new ApiError(
          502,
          'source_ingestion_failed',
          'The Parsing Service returned an unknown run status.',
        )
    }
    const remaining = deadline - now()
    if (remaining <= 0)
      throw new ApiError(
        504,
        'source_ingestion_timeout',
        'Source Document parsing did not finish within thirty minutes.',
      )
    await sleep(Math.min(waitMs, remaining))
  }
}

/** The manifest and every page file it lists, each proven to belong to it. */
async function acceptedResult(
  parser: Parser,
  runId: string,
): Promise<{ manifest: KeiExpManifest; pages: KeiExpPage[] }> {
  const rejected = 'The parsed Source Document could not be retrieved.'
  const invalid = (cause: unknown) =>
    new ApiError(
      502,
      'source_ingestion_failed',
      'The Parsing Service returned an invalid result.',
      { cause },
    )
  const rawManifest = await parsingRequest(
    parser.fetcher,
    parser.base,
    `/api/runs/${runId}/result`,
    rejected,
    (response) => readJson(response, 'result manifest'),
    { signal: parser.signal },
  )
  const manifest = keiExpManifestSchema.safeParse(rawManifest)
  if (!manifest.success) throw invalid(manifest.error)
  if (manifest.data.status !== 'success')
    throw new ApiError(
      422,
      'source_ingestion_failed',
      'The Source Document was only partially parsed.',
    )
  const pages: KeiExpPage[] = []
  for (const number of listedPages(manifest.data)) {
    const bytes = new Uint8Array(
      await parsingRequest(
        parser.fetcher,
        parser.base,
        `/api/runs/${runId}/pages/${number}`,
        rejected,
        (response) => response.arrayBuffer(),
        { signal: parser.signal },
      ),
    )
    try {
      pages.push(verifiedPage(manifest.data, number, bytes))
    } catch (cause) {
      throw invalid(cause)
    }
  }
  return { manifest: manifest.data, pages }
}

async function discardPublishedPackage(
  saved: CanonicalPackage,
  store: IngestionStore,
): Promise<void> {
  if (saved.published !== true) return
  const descriptor = {
    artifactReference: saved.artifactReference,
    artifactSha256: saved.artifactSha256,
  }
  await store.discardCanonicalPackage(descriptor).catch(() => {
    console.warn('Could not discard an unused Source Document ingestion package.')
  })
}

export function createSourceDocumentIngestion(
  store: IngestionStore,
  dependencies: Dependencies = {},
): (request: Request) => Promise<Response> {
  const packageStore = dependencies.packageStore ?? canonicalPackageStore
  const base =
    dependencies.parsingServiceBase ??
    process.env.KEI_EXP_URL ??
    (import.meta as ImportMeta & { env?: Record<string, string | undefined> })
      .env?.VITE_KEI_EXP_URL ??
    DEFAULT_KEI_EXP
  const model =
    dependencies.model ?? process.env.KEI_EXP_MODEL ?? DEFAULT_MODEL
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const now = dependencies.now ?? Date.now

  return async function postSourceDocument(
    request: Request,
  ): Promise<Response> {
    let saved: CanonicalPackage | undefined
    try {
      const id = projectContextId(new URL(request.url).pathname)
      const projectContext = await store
        .getProjectContextWithDocuments(id)
        .catch((cause) => {
          throw persistenceUnavailable(
            cause,
            'Source Document storage is unavailable.',
          )
        })
      if (!projectContext)
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      const form = await parseFormRequest(request)
      assertFormFields(form, ['file', 'ingestionKey', 'layout'])
      if (
        form.getAll('file').length !== 1 ||
        form.getAll('ingestionKey').length !== 1 ||
        form.getAll('layout').length > 1
      )
        throw new ApiError(
          400,
          'invalid_request',
          'Provide exactly one PDF and one ingestionKey.',
        )
      const file = form.get('file')
      const ingestionKey = form.get('ingestionKey')
      const layout = form.get('layout') ?? 'pages'
      const pageSource =
        typeof layout === 'string' ? PAGE_SOURCE_OF_LAYOUT.get(layout) : undefined
      if (pageSource === undefined)
        throw new ApiError(
          400,
          'invalid_request',
          'layout must be pages or spreads.',
        )
      if (!(file instanceof File))
        throw new ApiError(
          400,
          'invalid_request',
          'A PDF Source Document is required.',
        )
      if (
        typeof ingestionKey !== 'string' ||
        !canonicalUuidSchema.safeParse(ingestionKey).success
      )
        throw new ApiError(
          422,
          'invalid_request',
          'ingestionKey must be a canonical lowercase UUID.',
        )
      if (file.type.trim().toLowerCase() !== 'application/pdf')
        throw new ApiError(
          400,
          'invalid_request',
          'The uploaded file must use application/pdf.',
        )
      if (file.size > MAX_PDF_BYTES)
        throw new ApiError(
          413,
          'invalid_request',
          'The uploaded PDF exceeds 100 MiB.',
        )

      const originalName = sanitizedFilename(file.name)
      const pdf = new Uint8Array(await file.arrayBuffer())
      if (new TextDecoder('ascii').decode(pdf.subarray(0, 5)) !== '%PDF-')
        throw new ApiError(
          400,
          'invalid_request',
          'The uploaded file must be a PDF.',
        )
      const contentSha256 = createHash('sha256').update(pdf).digest('hex')
      const parser: Parser = {
        fetcher: fetcher(dependencies),
        base,
        signal: AbortSignal.timeout(timeoutMs),
      }

      const runId = await submittedRun(
        parser,
        pdf,
        originalName,
        model,
        contentSha256,
        pageSource,
      )
      await completedRun(parser, runId, timeoutMs, pollIntervalMs, sleep, now)
      const { manifest, pages } = await acceptedResult(parser, runId)
      let translated: TranslatedDocument
      try {
        translated = parsedDocumentFromKeiExp(
          runId,
          manifest,
          pages,
          {
            sha256: contentSha256,
            originalFilename: originalName,
            byteSize: pdf.byteLength,
          },
          new Date(now()),
        )
      } catch (cause) {
        throw new ApiError(
          502,
          'source_ingestion_failed',
          'The parsed Source Document could not be translated.',
          { cause },
        )
      }
      // The package's Source Document is FREE's own upload: kei-exp's recorded
      // hash was checked against it at submission and in the manifest.
      const packageBytes = packCanonicalPackage({
        pdf,
        document: translated.document,
        markdown: translated.markdown,
      })
      try {
        saved = await packageStore.save(packageBytes)
      } catch (cause) {
        throw new ApiError(
          502,
          'source_artifact_unavailable',
          'The parsed Source Document could not be packaged.',
          { cause },
        )
      }
      const requestPackage = saved
      let parsed: ReturnType<typeof provenance>
      try {
        parsed = provenance(saved.document)
      } catch (cause) {
        throw new ApiError(
          502,
          'source_artifact_unavailable',
          'The retained canonical package has invalid provenance.',
          { cause },
        )
      }
      if (parsed.contentSha256 !== contentSha256)
        throw new ApiError(
          502,
          'source_artifact_unavailable',
          'The retained canonical package belongs to another Source Document.',
        )
      const input: IngestSourceDocumentInput = {
        ingestionKey,
        contentSha256,
        mediaType: 'application/pdf',
        originalName,
        artifactReference: saved.artifactReference,
        artifactSha256: saved.artifactSha256,
        contractVersion: parsed.contractVersion,
        preprocessId: parsed.preprocessId,
        parserName: parsed.parserName,
        parserVersion: parsed.parserVersion,
        ensureRetained: async (descriptor) => {
          if (await packageStore.available(descriptor)) return
          if (!sameDescriptor(descriptor, requestPackage))
            throw new Error('The durable canonical package is unavailable.')
          const retained = await packageStore.save(packageBytes)
          if (!sameDescriptor(descriptor, retained))
            throw new Error('The canonical package could not be retained.')
        },
      }
      const persisted = await store
        .ingestSourceDocument(id, input)
        .catch((cause) => {
          if (cause instanceof IngestionKeyConflictError)
            throw new ApiError(409, 'invalid_request', cause.message)
          throw persistenceUnavailable(
            cause,
            'Source Document storage is unavailable.',
          )
        })
      if (!persisted)
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      const { descriptor, ...sourceDocument } = persisted
      // A replay may select an older package; discard only this request's
      // first-published package when no durable representation references it.
      if (!sameDescriptor(descriptor, saved))
        await discardPublishedPackage(saved, store)
      return json(
        { ...sourceDocument, pageCount: parsed.pageCount },
        { status: 201, headers: noStore },
      )
    } catch (error) {
      if (saved) await discardPublishedPackage(saved, store)
      return noStoreError(error)
    }
  }
}

function fetcher(dependencies: Dependencies): typeof fetch {
  return dependencies.fetcher ?? fetch
}

export function createSourceDocumentDeletion(
  store: SourceDocumentDeletionStore,
) {
  return async function deleteSourceDocument(
    request: Request,
  ): Promise<Response> {
    try {
      const { projectContextId, sourceDocumentId } = sourceDocumentIds(
        new URL(request.url).pathname,
      )
      const deleted = await store
        .deleteSourceDocument(projectContextId, sourceDocumentId)
        .catch((cause) => {
          throw persistenceUnavailable(
            cause,
            'Source Document storage is unavailable.',
          )
        })
      if (!deleted)
        throw new ApiError(404, 'not_found', 'Source Document was not found.')
      return new Response(null, { status: 204, headers: noStore })
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
  return {
    POST: createSourceDocumentIngestion(store),
    DELETE: createSourceDocumentDeletion(store),
  }
}

export type { IngestedSourceDocument }
