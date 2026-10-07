/**
 * Accepting a kei conversion: read the manifest and page files kei published for a run, prove them, translate them into
 * `parsed_document.v2`, package them with FREE's own upload and save the package. Ingestion and reprocessing share it;
 * each publishes the package through its own store transaction.
 */
import { createHash } from 'node:crypto'
import type { KeiOutcome } from 'extraction/kei-handoff'
import {
  canonicalPackageStore,
  packCanonicalPackage,
  type CanonicalPackageDescriptor,
  type CanonicalPackageStore,
} from '../../../packages/db/src/artifact-store.js'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { ApiError } from './_http.js'
import {
  keiExpManifestSchema,
  listedPages,
  parsedDocumentFromKeiExp,
  verifiedPage,
  type KeiExpManifest,
  type KeiExpPage,
  type TranslatedDocument,
} from './_kei_exp.js'

const CONTRACT_VERSION = 'parsed_document.v2'

/** Where a conversion's package goes and where replays read a package's page count from. */
export type PackageStore = Pick<CanonicalPackageStore, 'save' | 'available' | 'read'>

export type ConvertedPackage = Readonly<{
  descriptor: CanonicalPackageDescriptor
  provenance: { contractVersion: string; preprocessId: string; parserName: string; parserVersion: string }
  pageCount: number
  /** This conversion wrote the package: nothing else references it until a publication does. */
  published: boolean
}>

type Reader = { fetcher: typeof fetch; base: string; signal?: AbortSignal }

/** A failed read the next attempt may get through: kei's API unreachable or restarting (ARTIFACT_READ_RETRY). */
function transient(error: ApiError): ApiError {
  return Object.assign(error, { transient: true })
}

async function read<T>(reader: Reader, path: string, consume: (response: Response) => Promise<T>): Promise<T> {
  let response: Response
  try {
    response = await reader.fetcher(`${reader.base.replace(/\/$/, '')}${path}`, { signal: reader.signal })
  } catch (cause) {
    if (reader.signal?.aborted) throw reader.signal.reason
    throw transient(new ApiError(502, 'source_ingestion_failed', 'The Parsing Service is unavailable.', { cause }))
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    const refused = new ApiError(502, 'source_ingestion_failed', 'The parsed Source Document could not be retrieved.')
    throw response.status >= 500 ? transient(refused) : refused
  }
  try {
    return await consume(response)
  } catch (cause) {
    if (reader.signal?.aborted) throw reader.signal.reason
    const failure = new ApiError(502, 'source_ingestion_failed', 'The Parsing Service returned an invalid result.', { cause })
    throw cause instanceof SyntaxError ? failure : transient(failure)
  }
}

/** The manifest of the generation kei reported and every page file it lists, each proven to belong to it. */
async function acceptedResult(
  reader: Reader,
  runId: string,
  generation: string,
): Promise<{ manifest: KeiExpManifest; pages: KeiExpPage[] }> {
  const invalid = (cause: unknown) =>
    new ApiError(502, 'source_ingestion_failed', 'The Parsing Service returned an invalid result.', { cause })
  const manifest = keiExpManifestSchema.safeParse(await read(reader, `/api/runs/${runId}/result`, (response) => response.json()))
  if (!manifest.success) throw invalid(manifest.error)
  // kei's convert output names the generation it published; a manifest of any other parse is not this conversion's.
  if (manifest.data.generation !== generation)
    throw new ApiError(502, 'source_ingestion_failed', 'The Parsing Service published another parse than the one it reported.')
  if (manifest.data.status !== 'success')
    throw new ApiError(422, 'source_ingestion_failed', 'The Source Document was only partially parsed.')
  const pages: KeiExpPage[] = []
  for (const number of listedPages(manifest.data)) {
    const bytes = new Uint8Array(
      await read(reader, `/api/runs/${runId}/pages/${number}`, (response) => response.arrayBuffer()),
    )
    try {
      pages.push(verifiedPage(manifest.data, number, bytes))
    } catch (cause) {
      throw invalid(cause)
    }
  }
  return { manifest: manifest.data, pages }
}

function required(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`The parsed document is missing ${what}.`)
  return value
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The parsed document is missing ${what}.`)
  return value as Record<string, unknown>
}

/** What a revision records about the parse that made it, read from the document the package carries. */
function provenance(document: unknown, contentSha256: string) {
  const parsed = record(document, 'metadata')
  const identity = record(parsed.document, 'Source Document identity')
  const contractVersion = required(parsed.schema_version, 'a contract version')
  if (contractVersion !== CONTRACT_VERSION) throw new Error(`The parsed document is not ${CONTRACT_VERSION}.`)
  if (identity.content_sha256 !== contentSha256) throw new Error('The parsed document belongs to another Source Document.')
  const pageCount = parsed.page_count
  if (!Number.isInteger(pageCount) || Number(pageCount) < 1) throw new Error('The parsed document is missing a physical page count.')
  const preprocessing = record(parsed.preprocessing, 'preprocessing metadata')
  const arbitration = record(parsed.arbitration, 'parser arbitration metadata')
  const parserName = required(arbitration.primary_document_parser, 'its primary document parser')
  const parserRuns = Array.isArray(parsed.parser_runs) ? parsed.parser_runs : []
  const selected = parserRuns.find(
    (run) => run && typeof run === 'object' && !Array.isArray(run) && (run as Record<string, unknown>).parser === parserName,
  ) as Record<string, unknown> | undefined
  return {
    pageCount: Number(pageCount),
    provenance: {
      contractVersion,
      preprocessId: required(preprocessing.preprocess_id, 'a preprocessing identity'),
      parserName,
      parserVersion: typeof selected?.version === 'string' ? selected.version : 'unknown',
    },
  }
}

/**
 * Reads kei's published result for `runId`, checks it is the `generation` kei's convert output reported and that it
 * parsed these very bytes, translates it and saves the canonical package: the Source Document is FREE's own upload,
 * never bytes kei returned. The output is a descriptor and provenance only, so no bytes enter DBOS history.
 */
export async function packageConversion(options: {
  readBase: string
  runId: string
  generation: string
  pdf: Uint8Array
  originalName: string
  signal?: AbortSignal
  fetcher?: typeof fetch
  packageStore?: PackageStore
  now?: () => Date
}): Promise<ConvertedPackage> {
  const packageStore = options.packageStore ?? canonicalPackageStore
  const contentSha256 = createHash('sha256').update(options.pdf).digest('hex')
  const reader: Reader = { fetcher: options.fetcher ?? fetch, base: options.readBase, signal: options.signal }
  options.signal?.throwIfAborted()
  const { manifest, pages } = await acceptedResult(reader, options.runId, options.generation)
  let translated: TranslatedDocument
  let accepted: ReturnType<typeof provenance>
  try {
    translated = parsedDocumentFromKeiExp(
      options.runId,
      manifest,
      pages,
      { sha256: contentSha256, originalFilename: options.originalName, byteSize: options.pdf.byteLength },
      options.now?.() ?? new Date(),
    )
    accepted = provenance(translated.document, contentSha256)
  } catch (cause) {
    throw new ApiError(502, 'source_ingestion_failed', 'The parsed Source Document could not be translated.', { cause })
  }
  let saved: Awaited<ReturnType<PackageStore['save']>>
  try {
    saved = await packageStore.save(
      packCanonicalPackage({ pdf: options.pdf, document: translated.document, markdown: translated.markdown }),
    )
  } catch (cause) {
    throw transient(new ApiError(502, 'source_artifact_unavailable', 'The parsed Source Document could not be packaged.', { cause }))
  }
  return {
    descriptor: { artifactReference: saved.artifactReference, artifactSha256: saved.artifactSha256 },
    provenance: accepted.provenance,
    pageCount: accepted.pageCount,
    published: saved.published,
  }
}

/** A failed kei conversion as Studio answers it: kei's deadline is a timeout, anything else a parse failure with
 *  kei's own reason. */
export function conversionFailure(outcome: Extract<KeiOutcome<unknown>, { ok: false }>): {
  status: 422 | 504
  code: 'source_ingestion_failed' | 'source_ingestion_timeout'
  message: string
} {
  if (outcome.code === 'deadline_exceeded')
    return { status: 504, code: 'source_ingestion_timeout', message: 'Source Document parsing did not finish within its time limit.' }
  return {
    status: 422,
    code: 'source_ingestion_failed',
    message: `The Source Document could not be parsed: ${outcome.reason}`.slice(0, 512),
  }
}

/** Removes a package this conversion published once no revision references it (reference-safe in the store). */
export async function discardPublishedPackage(
  converted: Pick<ConvertedPackage, 'descriptor' | 'published'>,
  store: Pick<ResearcherProjectStore, 'discardCanonicalPackage'>,
): Promise<void> {
  if (!converted.published) return
  await store.discardCanonicalPackage(converted.descriptor).catch(() => {
    console.warn('Could not discard an unused Source Document ingestion package.')
  })
}

export function sameDescriptor(left: CanonicalPackageDescriptor, right: CanonicalPackageDescriptor): boolean {
  return left.artifactReference === right.artifactReference && left.artifactSha256 === right.artifactSha256
}

/** The physical page count a published package records (its `source` entry), as the upload response reports it. */
export async function packagePageCount(
  descriptor: CanonicalPackageDescriptor,
  store: Pick<PackageStore, 'read'>,
): Promise<number> {
  const source = await store.read(descriptor, 'source')
  const pageCount: unknown = JSON.parse(new TextDecoder().decode(source.bytes)).page_count
  if (!Number.isInteger(pageCount) || Number(pageCount) < 1) throw new Error('The canonical package records no page count.')
  return Number(pageCount)
}
