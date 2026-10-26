/**
 * The canonical package format and its whole-package validation, which `artifact-store.ts` runs on this module's
 * worker thread so hashing, unpacking and JSON parsing a package never stall Studio's event loop.
 *
 * Node loads this file as a worker's entry (resolved as `db/canonical-package-worker`): with its own type stripping in
 * the built server, the development server and Vitest, and with tsx's loader under tsx. It therefore imports only
 * `node:` builtins and `fflate`, and uses only erasable TypeScript syntax.
 */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { strFromU8, unzipSync } from 'fflate'

export const PACKAGE_VERSION = 'canonical-ingestion-package.v1'
export const DOCUMENT_VERSION = 'parsed_document.v2'
export const ENTRIES = {
  pdf: { path: 'source.pdf', mediaType: 'application/pdf' },
  source: { path: 'parsed_document.json', mediaType: 'application/json' },
  markdown: {
    path: 'artifacts/document.llm.md',
    mediaType: 'text/markdown; charset=utf-8',
  },
} as const
const PACKAGE_NAMES = [
  'manifest.json',
  ...Object.values(ENTRIES).map(({ path }) => path),
].sort()

export type CanonicalArtifact = keyof typeof ENTRIES
type ManifestEntry = {
  path: string
  media_type: string
  size: number
  sha256: string
}
export type Manifest = {
  package_version: string
  parsed_document_schema_version: string
  source_sha256: string
  preprocess_id: string
  entries: ManifestEntry[]
}

export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function jsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(strFromU8(bytes))
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>
  } catch {
    // The bounded error below is the public storage contract.
  }
  throw new Error(`${label} is not a JSON object.`)
}

function manifestFrom(bytes: Uint8Array): Manifest {
  const value = jsonObject(bytes, 'Canonical package manifest')
  if (
    value.package_version !== PACKAGE_VERSION ||
    value.parsed_document_schema_version !== DOCUMENT_VERSION ||
    typeof value.source_sha256 !== 'string' ||
    typeof value.preprocess_id !== 'string' ||
    !Array.isArray(value.entries)
  )
    throw new Error('Canonical package manifest is invalid.')
  return value as Manifest
}

export function validateEntries(
  archive: Record<string, Uint8Array>,
): { manifest: Manifest; document: Record<string, unknown> } {
  const names = Object.keys(archive).sort()
  if (
    names.length !== PACKAGE_NAMES.length ||
    names.some((name, index) => name !== PACKAGE_NAMES[index])
  )
    throw new Error('Canonical package entries do not match the fixed layout.')

  const manifest = manifestFrom(archive['manifest.json'])
  const expected = Object.values(ENTRIES)
  if (manifest.entries.length !== expected.length)
    throw new Error('Canonical package manifest entries are incomplete.')

  for (const [index, { path, mediaType }] of expected.entries()) {
    const bytes = archive[path]
    const record = manifest.entries[index]
    if (
      !bytes ||
      record?.path !== path ||
      record.media_type !== mediaType ||
      record.size !== bytes.byteLength ||
      record.sha256 !== sha256(bytes)
    )
      throw new Error('Canonical package entry integrity check failed.')
  }

  const pdf = archive[ENTRIES.pdf.path]
  if (strFromU8(pdf.subarray(0, 5)) !== '%PDF-')
    throw new Error('Canonical package Source Document is not a PDF.')
  const document = jsonObject(
    archive[ENTRIES.source.path],
    'Canonical parsed document',
  )
  const identity = document.document
  const preprocessing = document.preprocessing
  const sourceSha256 = sha256(pdf)
  if (
    document.schema_version !== DOCUMENT_VERSION ||
    !identity ||
    typeof identity !== 'object' ||
    (identity as Record<string, unknown>).content_sha256 !== sourceSha256 ||
    manifest.source_sha256 !== sourceSha256 ||
    !preprocessing ||
    typeof preprocessing !== 'object' ||
    (preprocessing as Record<string, unknown>).preprocess_id !==
      manifest.preprocess_id
  )
    throw new Error('Canonical package identity is inconsistent.')
  return { manifest, document }
}

/** What the store asks this worker: validate the whole file at `path`, then return one entry (or nothing). */
export type PackageReadRequest = {
  path: string
  artifactSha256: string
  artifact: CanonicalArtifact | null
}

/** Validates the whole package at `path`, a regular file whose bytes hash to `artifactSha256`, and returns one entry. */
async function readValidated({ path, artifactSha256, artifact }: PackageReadRequest): Promise<Uint8Array | null> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Canonical package is unavailable.')
  const packageBytes = await readFile(path)
  if (sha256(packageBytes) !== artifactSha256)
    throw new Error('Canonical package integrity check failed.')
  const archive = unzipSync(packageBytes)
  validateEntries(archive)
  return artifact === null ? null : archive[ENTRIES[artifact].path]
}

export const READER_ROLE = 'canonical-package-reader'

// The worker's whole program: one request at a time (the store's lane sends the next only after this reply), and only
// the selected entry goes back, moved rather than copied. The rest of the package is garbage once this returns.
if (!isMainThread && (workerData as { role?: unknown } | null)?.role === READER_ROLE && parentPort) {
  const port = parentPort
  port.on('message', (request: PackageReadRequest) => {
    readValidated(request).then(
      (selected) => {
        if (selected === null) return port.postMessage({ value: null })
        const bytes = selected.byteOffset === 0 && selected.byteLength === selected.buffer.byteLength
          ? selected
          : selected.slice()
        port.postMessage({ value: bytes }, [bytes.buffer as ArrayBuffer])
      },
      (error: unknown) => port.postMessage({
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: (error as NodeJS.ErrnoException | null)?.code,
        },
      }),
    )
  })
}
