import { createHash, randomUUID } from 'node:crypto'
import type { DBOSClient } from '@dbos-inc/dbos-sdk'
import { conversionLane } from 'extraction/kei-handoff'
import { canonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import type {
  IngestedSourceDocument,
  ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { awaitWorkflowOutcome, STUDIO_QUEUE, studioDbos } from '../server/dbos.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { sourceDocumentFilenameFailure } from '../shared/sourceDocumentFilename.js'
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
  INGEST_SOURCE,
  ingestDeduplicationId,
  ingestedOutput,
  ingestWorkflowId,
  type IngestionInput,
  type IngestionOutcome,
} from './_ingestion_workflow.js'
import { packagePageCount, type PackageStore } from './_kei_conversion.js'
import { configuredIngestionModels } from './_model_config.js'
import { countPdfPages } from './_pdf_pages.js'
import {
  removeStagedSource,
  sourceInboxRoot,
  stageSource,
  uploadSourcePath,
} from './_source_inbox.js'

const MAX_PDF_BYTES = 100 * 1024 * 1024
/** The existing HTTP deadline of an upload; past it the request detaches and the workflow keeps running. */
const RESULT_TIMEOUT_MS = 30 * 60 * 1000
/** The researcher's page layout: single PDF pages, or scanned two-page spreads split into book pages. */
const PAGE_SOURCE_OF_LAYOUT: ReadonlyMap<string, 'pdf' | 'ingest'> = new Map([
  ['pages', 'pdf'],
  ['spreads', 'ingest'],
])

type IngestionStore = Pick<
  ResearcherProjectStore,
  'researcherAccountId' | 'getProjectContextWithDocuments' | 'findSourceDocumentByContent'
>

export type Dependencies = {
  /** Enqueues and reads `ingestSource`; Studio's launched admission client by default. */
  admission?: Pick<DBOSClient, 'enqueue' | 'listWorkflows'>
  inboxRoot?: string
  countPages?: (pdf: Uint8Array) => Promise<number | null>
  ingestionModels?: (owner: string) => Promise<{ ocr: string | null; layout: string | null }>
  /** How long the request waits for its workflow (thirty minutes). */
  resultTimeoutMs?: number
  resultPollIntervalMs?: number
  /** Reads a completed document's page count from its package. */
  packageStore?: Pick<PackageStore, 'read'>
  /** Test seam: runs after the completed-content precheck, right before the enqueue. */
  beforeEnqueue?: () => Promise<void>
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

/** The validated upload: one PDF, its sanitized name and the page layout it asks for. */
async function upload(request: Request): Promise<{ pdf: Uint8Array; originalName: string; pageSource: 'pdf' | 'ingest' }> {
  const form = await parseFormRequest(request)
  // Ingestion has no client key: content identifies an upload (spec, *Client IDs*).
  assertFormFields(form, ['file', 'layout'])
  if (form.getAll('file').length !== 1 || form.getAll('layout').length > 1)
    throw new ApiError(400, 'invalid_request', 'Provide exactly one PDF.')
  const file = form.get('file')
  const layout = form.get('layout') ?? 'pages'
  const pageSource = typeof layout === 'string' ? PAGE_SOURCE_OF_LAYOUT.get(layout) : undefined
  if (pageSource === undefined)
    throw new ApiError(400, 'invalid_request', 'layout must be pages or spreads.')
  if (!(file instanceof File))
    throw new ApiError(400, 'invalid_request', 'A PDF Source Document is required.')
  if (file.type.trim().toLowerCase() !== 'application/pdf')
    throw new ApiError(400, 'invalid_request', 'The uploaded file must use application/pdf.')
  if (file.size > MAX_PDF_BYTES)
    throw new ApiError(413, 'invalid_request', 'The uploaded PDF exceeds 100 MiB.')
  const originalName = sanitizedFilename(file.name)
  const pdf = new Uint8Array(await file.arrayBuffer())
  if (new TextDecoder('ascii').decode(pdf.subarray(0, 5)) !== '%PDF-')
    throw new ApiError(400, 'invalid_request', 'The uploaded file must be a PDF.')
  return { pdf, originalName, pageSource }
}

/**
 * `POST …/source-documents`: completed content replays at once; otherwise the upload is staged under a server-minted
 * attempt and `ingestSource` is enqueued with active deduplication on the project and content, so a same-content
 * upload joins the attempt already running (with that attempt's admitted models). The request then waits for the
 * workflow for thirty minutes; a 504 detaches and cancels nothing.
 */
export function createSourceDocumentIngestion(
  store: IngestionStore,
  dependencies: Dependencies = {},
): (request: Request) => Promise<Response> {
  return async function postSourceDocument(request: Request): Promise<Response> {
    try {
      const projectId = projectContextId(new URL(request.url).pathname)
      const projectContext = await store.getProjectContextWithDocuments(projectId).catch((cause) => {
        throw persistenceUnavailable(cause, 'Source Document storage is unavailable.')
      })
      if (!projectContext) throw new ApiError(404, 'not_found', 'Project Context was not found.')
      const { pdf, originalName, pageSource } = await upload(request)
      const contentSha256 = createHash('sha256').update(pdf).digest('hex')

      // Completed content replays before any parse.
      const existing = await store.findSourceDocumentByContent(projectId, contentSha256).catch((cause) => {
        throw persistenceUnavailable(cause, 'Source Document storage is unavailable.')
      })
      if (existing) {
        const pageCount = await packagePageCount(existing.descriptor, dependencies.packageStore ?? canonicalPackageStore)
          .catch((cause) => {
            throw new ApiError(502, 'source_artifact_unavailable', 'The retained canonical package is unavailable.', { cause })
          })
        return json({ ...ingestedOutput(existing), pageCount }, { status: 201, headers: noStore })
      }

      // Resolved before staging: a Studio that cannot admit leaves no file behind.
      const admission = dependencies.admission ?? studioDbos().admission
      const attemptId = randomUUID()
      const source = uploadSourcePath(projectId, attemptId)
      const root = dependencies.inboxRoot ?? sourceInboxRoot()
      await stageSource(root, source, pdf).catch((cause) => {
        throw persistenceUnavailable(cause, 'Source Document storage is unavailable.')
      })
      // The project check above passed, so this account owns the project.
      const owner = store.researcherAccountId
      const ours = ingestWorkflowId(projectId, attemptId)
      let input: IngestionInput
      try {
        const pageCount = await (dependencies.countPages ?? countPdfPages)(pdf)
        input = {
          projectContextId: projectId, attemptId, owner, source, sourceSha256: contentSha256, originalName,
          byteSize: pdf.byteLength, pageSource, pageCount, lane: conversionLane(pageCount),
          models: await (dependencies.ingestionModels ?? configuredIngestionModels)(owner),
        }
        await dependencies.beforeEnqueue?.()
      } catch (cause) {
        // Nothing was enqueued, so no workflow can read this file.
        await removeStagedSource(root, source).catch(() => undefined)
        throw cause instanceof ApiError ? cause : persistenceUnavailable(cause, 'Source Document ingestion could not be started.')
      }
      let workflowId: string
      try {
        const handle = await admission.enqueue({
          workflowName: INGEST_SOURCE,
          queueName: STUDIO_QUEUE,
          workflowID: ours,
          // Active deduplication: a same-project, same-content attempt that is still running is joined, not repeated.
          deduplicationID: ingestDeduplicationId(projectId, contentSha256),
          duplicationPolicy: 'return-existing',
          authenticatedUser: owner,
          attributes: { projectContextId: projectId },
        }, input)
        workflowId = handle.workflowID
      } catch (cause) {
        // An uncertain enqueue leaves its file for garbage collection rather than risking a live attempt's input.
        throw persistenceUnavailable(cause, 'Source Document ingestion could not be started.')
      }
      // Another attempt won: this request's file was never handed to a workflow.
      if (workflowId !== ours) await removeStagedSource(root, source).catch(() => undefined)
      const awaited = await awaitWorkflowOutcome<IngestionOutcome>(admission, workflowId, {
        timeoutMs: dependencies.resultTimeoutMs ?? RESULT_TIMEOUT_MS,
        intervalMs: dependencies.resultPollIntervalMs,
        signal: request.signal,
      })
      // Detaches: nothing is cancelled, and a re-upload of the same bytes joins the attempt or replays its document.
      if (awaited.state === 'timed-out')
        throw new ApiError(504, 'source_ingestion_timeout', 'Source Document parsing did not finish within thirty minutes.')
      if (awaited.state === 'stopped')
        throw new ApiError(502, 'source_ingestion_failed', 'Source Document parsing stopped before it finished.')
      if (!awaited.output.ok)
        throw new ApiError(awaited.output.status, awaited.output.code, awaited.output.message)
      return json(
        { ...awaited.output.sourceDocument, pageCount: awaited.output.pageCount },
        { status: 201, headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
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
