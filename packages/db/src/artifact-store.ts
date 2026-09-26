import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import envPaths from 'env-paths'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const PACKAGE_VERSION = 'canonical-ingestion-package.v1'
const DOCUMENT_VERSION = 'parsed_document.v2'
const REFERENCE = /^[a-f0-9]{64}$/
const ENTRIES = {
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
export type CanonicalPackageDescriptor = {
  artifactReference: string
  artifactSha256: string
}
type ManifestEntry = {
  path: string
  media_type: string
  size: number
  sha256: string
}
type Manifest = {
  package_version: string
  parsed_document_schema_version: string
  source_sha256: string
  preprocess_id: string
  entries: ManifestEntry[]
}
export type CanonicalArtifactRead = {
  bytes: Uint8Array
  mediaType: string
}

export type CanonicalPackageStore = {
  save(packageBytes: Uint8Array): Promise<
    CanonicalPackageDescriptor & {
      document: Record<string, unknown>
      manifest: Manifest
      published: boolean
    }
  >
  read(
    descriptor: CanonicalPackageDescriptor,
    artifact: CanonicalArtifact,
  ): Promise<CanonicalArtifactRead>
  available(descriptor: CanonicalPackageDescriptor): Promise<boolean>
  remove(
    descriptor: CanonicalPackageDescriptor,
    isReferenced: () => Promise<boolean>,
  ): Promise<boolean>
}

function sha256(value: Uint8Array): string {
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

function validateEntries(
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

/**
 * Packs a parsed document, its Markdown and the Source Document bytes into the
 * fixed uncompressed layout `validateEntries` accepts. Entries carry one fixed
 * timestamp so identical inputs pack to identical, content-addressable bytes.
 */
export function packCanonicalPackage(parts: {
  pdf: Uint8Array
  document: { preprocessing: { preprocess_id: string }; [key: string]: unknown }
  markdown: Uint8Array | string
}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    [ENTRIES.pdf.path]: parts.pdf,
    [ENTRIES.source.path]: strToU8(JSON.stringify(parts.document)),
    [ENTRIES.markdown.path]:
      typeof parts.markdown === 'string'
        ? strToU8(parts.markdown)
        : parts.markdown,
  }
  const manifest: Manifest = {
    package_version: PACKAGE_VERSION,
    parsed_document_schema_version: DOCUMENT_VERSION,
    source_sha256: sha256(parts.pdf),
    preprocess_id: parts.document.preprocessing.preprocess_id,
    entries: Object.values(ENTRIES).map(({ path, mediaType }) => ({
      path,
      media_type: mediaType,
      size: files[path].byteLength,
      sha256: sha256(files[path]),
    })),
  }
  return zipSync(
    { 'manifest.json': strToU8(JSON.stringify(manifest)), ...files },
    { level: 0, mtime: new Date(2000, 0, 1) },
  )
}

/** Studio's per-user data directory: canonical packages and, outside Compose, the source inbox live under it. */
export function studioDataRoot(): string {
  return envPaths('FREE Studio').data
}

function packageRoot(): string {
  return join(studioDataRoot(), 'source-representations')
}

export function createCanonicalPackageStore(
  root: string = packageRoot(),
): CanonicalPackageStore {
  function packagePath(descriptor: CanonicalPackageDescriptor): string {
    if (
      !REFERENCE.test(descriptor.artifactReference) ||
      descriptor.artifactReference !== descriptor.artifactSha256
    )
      throw new Error('Canonical package reference is invalid.')
    return join(root, `${descriptor.artifactReference}.zip`)
  }

  async function load(descriptor: CanonicalPackageDescriptor) {
    const path = packagePath(descriptor)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('Canonical package is unavailable.')
    const packageBytes = await readFile(path)
    if (sha256(packageBytes) !== descriptor.artifactSha256)
      throw new Error('Canonical package integrity check failed.')
    const archive = unzipSync(packageBytes)
    return { archive, ...validateEntries(archive) }
  }

  async function read(
    descriptor: CanonicalPackageDescriptor,
    artifact: CanonicalArtifact,
  ): Promise<CanonicalArtifactRead> {
    // ponytail: decode per read; index ZIP entries only if large-document
    // profiling shows this prototype needs random-access package reads.
    const { archive } = await load(descriptor)
    const expected = ENTRIES[artifact]
    return { bytes: archive[expected.path], mediaType: expected.mediaType }
  }

  async function available(
    descriptor: CanonicalPackageDescriptor,
  ): Promise<boolean> {
    try {
      await load(descriptor)
      return true
    } catch {
      return false
    }
  }

  async function save(packageBytes: Uint8Array) {
    const artifactSha256 = sha256(packageBytes)
    const descriptor = {
      artifactReference: artifactSha256,
      artifactSha256,
    }
    const { manifest, document } = validateEntries(unzipSync(packageBytes))
    if (await available(descriptor))
      return { ...descriptor, document, manifest, published: false }

    await mkdir(root, { recursive: true })
    const destination = packagePath(descriptor)
    const temporary = join(root, `${artifactSha256}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, packageBytes, { flag: 'wx', mode: 0o600 })
      try {
        await link(temporary, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!(await available(descriptor))) throw error
        return { ...descriptor, document, manifest, published: false }
      }
    } finally {
      await rm(temporary, { force: true })
    }
    if (!(await available(descriptor)))
      throw new Error('Canonical package was not published.')
    return { ...descriptor, document, manifest, published: true }
  }

  /**
   * Quarantines a removal candidate, then either deletes it or restores it when
   * a writer published a reference during cleanup.
   */
  async function remove(
    descriptor: CanonicalPackageDescriptor,
    isReferenced: () => Promise<boolean>,
  ): Promise<boolean> {
    const path = packagePath(descriptor)
    const quarantine = join(root, `${descriptor.artifactReference}.${randomUUID()}.deleting`)
    try {
      await rename(path, quarantine)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }

    const restore = async () => {
      try {
        await rename(quarantine, path)
      } catch (error) {
        // A concurrent content-addressed save may already have restored the
        // same valid package. In that case only its quarantined twin is stale.
        if (!(await available(descriptor))) throw error
        await rm(quarantine, { force: true })
      }
    }

    try {
      if (await isReferenced()) {
        await restore()
        return false
      }
      await rm(quarantine, { force: true })
      return true
    } catch (error) {
      await restore()
      throw error
    }
  }

  return { save, read, available, remove }
}

export const canonicalPackageStore = createCanonicalPackageStore()
