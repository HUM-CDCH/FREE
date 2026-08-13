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
  canonicalPackageStore,
  type CanonicalPackageDescriptor,
} from '../../../packages/db/src/artifact-store.js'
import {
  createProjectStore,
  IngestionKeyConflictError,
  type IngestSourceDocumentInput,
  type IngestedSourceDocument,
  type ProjectStore,
} from '../../../packages/db/src/project-store.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'

const CONTRACT_VERSION = 'parsed_document.v2'
const DEFAULT_PARSING_SERVICE = 'http://127.0.0.1:8000'
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 1000
const MAX_FILENAME_LENGTH = 180
const MAX_PDF_BYTES = 50 * 1024 * 1024

type CanonicalPackage = {
  artifactReference: string
  artifactSha256: string
  document: unknown
  published?: boolean
}

type PackageStore = {
  save(packageBytes: Uint8Array): Promise<CanonicalPackage>
  remove(
    descriptor: CanonicalPackageDescriptor,
    isReferenced: () => Promise<boolean>,
  ): Promise<boolean>
}

type IngestionStore = Pick<
  ProjectStore,
  'ingestSourceDocument' | 'isPackageReferenced'
>

type Dependencies = {
  store?: IngestionStore
  packageStore?: PackageStore
  fetcher?: typeof fetch
  parsingServiceBase?: string
  timeoutMs?: number
  pollIntervalMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}

function projectContextId(pathname: string): string {
  const match =
    /^\/api\/project-contexts\/([^/]+)\/source-documents$/.exec(pathname)
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
  let filename = raw
    .replace(/^.*[\\/]/, '')
    .replaceAll('\0', '')
    .trim()
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
  if (!filename) filename = 'source.pdf'
  if (!filename.toLowerCase().endsWith('.pdf'))
    throw new ApiError(400, 'invalid_request', 'The uploaded file must be a PDF.')
  if (filename.length <= MAX_FILENAME_LENGTH) return filename
  const extension = filename.slice(filename.lastIndexOf('.')).slice(0, 20)
  return `${filename.slice(0, MAX_FILENAME_LENGTH - extension.length)}${extension}`
}

function required(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(`The parsed document is missing ${what}.`)
  return value
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
    contractVersion,
    preprocessId: required(
      preprocessing.preprocess_id,
      'a preprocessing identity',
    ),
    parserName,
    parserVersion: typeof parserVersion === 'string' ? parserVersion : 'unknown',
  }
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  try {
    return record(await response.json(), what)
  } catch (cause) {
    throw new ApiError(502, 'source_ingestion_failed', `The Parsing Service returned invalid ${what}.`, { cause })
  }
}

async function parsingRequest(
  fetcher: typeof fetch,
  base: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    const response = await fetcher(`${base.replace(/\/$/, '')}${path}`, init)
    if (!response.ok)
      throw new ApiError(
        502,
        'source_ingestion_failed',
        `The Parsing Service rejected ${path}.`,
      )
    return response
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (init?.signal?.aborted)
      throw new ApiError(
        504,
        'source_ingestion_timeout',
        'Source Document parsing did not finish within ten minutes.',
        { cause: error },
      )
    throw new ApiError(
      502,
      'source_ingestion_failed',
      'The Parsing Service is unavailable.',
      { cause: error },
    )
  }
}

async function completedTask(
  fetcher: typeof fetch,
  base: string,
  taskId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = now() + timeoutMs
  for (;;) {
    const status = await readJson(
      await parsingRequest(fetcher, base, `/tasks/${taskId}`, { signal }),
      'task status',
    )
    if (status.status === 'completed') return
    if (status.status === 'failed')
      throw new ApiError(
        422,
        'source_ingestion_failed',
        typeof status.error === 'string'
          ? Array.from(status.error).slice(0, 512).join('')
          : 'The Source Document could not be parsed.',
      )
    if (status.status !== 'pending' && status.status !== 'running')
      throw new ApiError(
        502,
        'source_ingestion_failed',
        'The Parsing Service returned an unknown task status.',
      )
    const remaining = deadline - now()
    if (remaining <= 0)
      throw new ApiError(
        504,
        'source_ingestion_timeout',
        'Source Document parsing did not finish within ten minutes.',
      )
    await sleep(Math.min(pollIntervalMs, remaining))
  }
}

async function removePublishedPackage(
  saved: CanonicalPackage,
  store: IngestionStore,
  packageStore: PackageStore,
): Promise<void> {
  if (saved.published !== true) return
  const descriptor = {
    artifactReference: saved.artifactReference,
    artifactSha256: saved.artifactSha256,
  }
  const isReferenced = async () => {
    try {
      return await store.isPackageReferenced(descriptor.artifactReference)
    } catch (cause) {
      console.warn(
        `Could not check whether the failed ingestion package ${descriptor.artifactReference} is referenced; retaining it: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
      return true
    }
  }
  await packageStore.remove(descriptor, isReferenced).catch((cause: unknown) => {
    console.warn(
      `Could not remove the failed ingestion package ${descriptor.artifactReference}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  })
}

export function createSourceDocumentIngestion(
  dependencies: Dependencies = {},
): (request: Request) => Promise<Response> {
  const store =
    dependencies.store ??
    (createProjectStore() as unknown as IngestionStore)
  const packageStore = dependencies.packageStore ?? canonicalPackageStore
  const base =
    dependencies.parsingServiceBase ??
    ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
      ?.VITE_PARSING_SERVICE_URL ?? DEFAULT_PARSING_SERVICE)
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const sleep =
    dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const now = dependencies.now ?? Date.now

  return async function postSourceDocument(request: Request): Promise<Response> {
    let saved: CanonicalPackage | undefined
    try {
      const id = projectContextId(new URL(request.url).pathname)
      const form = await parseFormRequest(request)
      assertFormFields(form, ['file', 'ingestionKey'])
      if (form.getAll('file').length !== 1 || form.getAll('ingestionKey').length !== 1)
        throw new ApiError(400, 'invalid_request', 'Provide exactly one PDF and one ingestionKey.')
      const file = form.get('file')
      const ingestionKey = form.get('ingestionKey')
      if (!(file instanceof File))
        throw new ApiError(400, 'invalid_request', 'A PDF Source Document is required.')
      if (typeof ingestionKey !== 'string' || !canonicalUuidSchema.safeParse(ingestionKey).success)
        throw new ApiError(422, 'invalid_request', 'ingestionKey must be a canonical lowercase UUID.')
      if (file.type.trim().toLowerCase() !== 'application/pdf')
        throw new ApiError(400, 'invalid_request', 'The uploaded file must use application/pdf.')
      if (file.size > MAX_PDF_BYTES)
        throw new ApiError(413, 'invalid_request', 'The uploaded PDF exceeds 50 MiB.')

      const originalName = sanitizedFilename(file.name)
      const pdf = new Uint8Array(await file.arrayBuffer())
      if (new TextDecoder('ascii').decode(pdf.subarray(0, 5)) !== '%PDF-')
        throw new ApiError(400, 'invalid_request', 'The uploaded file must be a PDF.')
      const contentSha256 = createHash('sha256').update(pdf).digest('hex')
      const parsingDeadline = AbortSignal.timeout(timeoutMs)

      const upload = new FormData()
      upload.append('file', new Blob([pdf], { type: 'application/pdf' }), originalName)
      const created = await readJson(
        await parsingRequest(fetcher(dependencies), base, '/tasks', {
          method: 'POST',
          body: upload,
          signal: parsingDeadline,
        }),
        'task creation response',
      )
      let taskId: string
      try {
        taskId = required(created.task_id, 'a task identity')
      } catch (cause) {
        throw new ApiError(
          502,
          'source_ingestion_failed',
          'The Parsing Service returned an invalid task identity.',
          { cause },
        )
      }
      await completedTask(
        fetcher(dependencies),
        base,
        taskId,
        timeoutMs,
        pollIntervalMs,
        sleep,
        now,
        parsingDeadline,
      )
      const packageBytes = new Uint8Array(
        await (
          await parsingRequest(
            fetcher(dependencies),
            base,
            `/tasks/${taskId}/download`,
            { signal: parsingDeadline },
          )
        ).arrayBuffer(),
      )
      try {
        saved = await packageStore.save(packageBytes)
      } catch (cause) {
        throw new ApiError(
          502,
          'source_artifact_unavailable',
          'The Parsing Service returned an invalid canonical package.',
          { cause },
        )
      }
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
        ensureRetained: async () => {
          await packageStore.save(packageBytes)
        },
      }
      const persisted = await store.ingestSourceDocument(id, input).catch((cause) => {
        if (cause instanceof IngestionKeyConflictError)
          throw new ApiError(409, 'invalid_request', cause.message)
        throw persistenceUnavailable(cause, 'Source Document storage is unavailable.')
      })
      if (!persisted)
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      return json(persisted, { status: 201, headers: noStore })
    } catch (error) {
      if (saved) await removePublishedPackage(saved, store, packageStore)
      return noStoreError(error)
    }
  }
}

function fetcher(dependencies: Dependencies): typeof fetch {
  return dependencies.fetcher ?? fetch
}

export const POST = createSourceDocumentIngestion()

export type { IngestedSourceDocument }
