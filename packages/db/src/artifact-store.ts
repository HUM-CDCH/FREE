import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import envPaths from 'env-paths'
import { strToU8, unzipSync, zipSync } from 'fflate'
import {
  DOCUMENT_VERSION, ENTRIES, PACKAGE_VERSION, READER_ROLE, sha256, validateEntries,
  type CanonicalArtifact, type Manifest, type PackageReadRequest,
} from './canonical-package-worker.js'

export type { CanonicalArtifact } from './canonical-package-worker.js'

const REFERENCE = /^[a-f0-9]{64}$/
const PACKAGE_FILE = /^([a-f0-9]{64})\.zip$/
/** What `save` (`.tmp`) and `remove` (`.deleting`) leave behind when interrupted: `<sha>.<uuid>.tmp|deleting`. */
const LEFTOVER = /^([a-f0-9]{64})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(tmp|deleting)$/

export type CanonicalPackageDescriptor = {
  artifactReference: string
  artifactSha256: string
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
  /** Recovers the package from an interrupted removal's intact quarantine when its canonical file is missing. */
  read(
    descriptor: CanonicalPackageDescriptor,
    artifact: CanonicalArtifact,
  ): Promise<CanonicalArtifactRead>
  available(descriptor: CanonicalPackageDescriptor): Promise<boolean>
  /** Stored packages and their last modification, which a reuse refreshes. */
  list(): Promise<readonly { descriptor: CanonicalPackageDescriptor; modifiedMs: number }[]>
  /** Interrupted writes and removals (`<sha>.<uuid>.tmp`, `<sha>.<uuid>.deleting`). */
  leftovers(): Promise<readonly { name: string; modifiedMs: number }[]>
  /**
   * Deletes one name `leftovers` lists, true when it is gone; refuses any other name. A `.deleting` quarantine is an
   * interrupted removal's only copy, so it goes through `remove` (with `isReferenced` for its package and the same
   * cutoff) and is kept, intact, whenever that removal cannot settle.
   */
  removeLeftover(
    name: string,
    isReferenced: (artifactReference: string) => Promise<boolean>,
    options?: { modifiedBeforeMs?: number },
  ): Promise<boolean>
  /**
   * With `modifiedBeforeMs`, a package modified at or after that time (a writer reused it after the sweep judged it
   * old) is restored instead of deleted.
   */
  remove(
    descriptor: CanonicalPackageDescriptor,
    isReferenced: () => Promise<boolean>,
    options?: { modifiedBeforeMs?: number },
  ): Promise<boolean>
}

/**
 * Runs requests on one worker thread, one at a time, in arrival order: a request's working set (a whole package, or a
 * whole parsed document) is in memory for at most one request per lane. The thread starts on first use, does not keep
 * the process alive while idle, and is replaced on the next request after it crashes or exits; the request it was
 * running, and only that one, rejects. A worker program answers each message it receives with `{ value }` or
 * `{ error: { message, code? } }`.
 *
 * At most `maxWaiting` requests wait, holding at most `maxWaitingBytes` of transferred input between them (a request
 * arriving at an empty queue always waits, whatever its size); past either bound a request rejects at once.
 */
export function createWorkerLane<Input, Output>(
  spawn: () => Worker,
  bounds: { maxWaiting: number; maxWaitingBytes?: number },
): (input: Input, transfer?: readonly ArrayBuffer[]) => Promise<Output> {
  type Job = {
    input: Input
    transfer: readonly ArrayBuffer[]
    bytes: number
    resolve(value: Output): void
    reject(error: unknown): void
  }
  const waiting: Job[] = []
  let waitingBytes = 0
  let worker: Worker | undefined
  let active: Job | undefined

  function started(): Worker {
    const thread = spawn()
    let failure: unknown
    thread.on('message', (reply: { value?: Output; error?: { message: string; code?: string } } | null) => {
      if (thread !== worker || !active) return
      const job = active
      active = undefined
      if (reply?.error) job.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }))
      else job.resolve(reply?.value as Output)
      next()
    })
    thread.on('messageerror', (error) => { failure = error; void thread.terminate() })
    thread.on('error', (error) => { failure = error })
    thread.on('exit', (code) => {
      if (thread !== worker) return
      worker = undefined
      const job = active
      active = undefined
      job?.reject(failure ?? new Error(`The worker thread exited (code ${code}).`))
      next()
    })
    return thread
  }

  function next(): void {
    if (active) return
    active = waiting.shift()
    if (!active) {
      worker?.unref()
      return
    }
    waitingBytes -= active.bytes
    try {
      worker ??= started()
      worker.ref()
      worker.postMessage(active.input, active.transfer) // the input's buffers leave this thread here
    } catch (error) {
      const job = active
      active = undefined
      job.reject(error)
      next()
    }
  }

  return (input, transfer = []) => new Promise<Output>((resolve, reject) => {
    const bytes = transfer.reduce((total, buffer) => total + buffer.byteLength, 0)
    if (
      waiting.length >= bounds.maxWaiting ||
      (waiting.length > 0 && waitingBytes + bytes > (bounds.maxWaitingBytes ?? Infinity))
    ) {
      reject(new Error('Too many requests are waiting for the worker thread.'))
      return
    }
    waiting.push({ input, transfer, bytes, resolve, reject })
    waitingBytes += bytes
    next()
  })
}

/**
 * The process's one package-reading thread, shared by every store. Its entry is the `db/canonical-package-worker`
 * export, resolved from this module's location: the workspace source in tests and development, and, from the built
 * Studio server bundle, the same file through Studio's `db` dependency. A worker inherits the main script's
 * `--input-type` (`node --input-type=module -e ...`), which refuses a file entry, so the thread starts from a program
 * that is valid as either CommonJS or an ES module and imports the entry.
 */
let packageReader: ((request: PackageReadRequest) => Promise<Uint8Array | null>) | undefined
const readPackage = (request: PackageReadRequest) => (packageReader ??= createWorkerLane(() => new Worker(
  "import('node:worker_threads').then(({ workerData }) => import(workerData.entry))",
  {
    eval: true,
    workerData: {
      role: READER_ROLE,
      entry: pathToFileURL(createRequire(import.meta.url).resolve('db/canonical-package-worker')).href,
    },
  },
), { maxWaiting: 1024 }))(request) // a waiting read holds only its path and digest

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

  /** Validates the whole package file at `path` on the reader thread; returns `artifact`'s entry, or null without one. */
  function validated(path: string, descriptor: CanonicalPackageDescriptor, artifact: CanonicalArtifact | null) {
    return readPackage({ path, artifactSha256: descriptor.artifactSha256, artifact })
  }

  /** The canonical file, reinstalled from an interrupted removal's quarantine first when it is missing. */
  async function canonical(descriptor: CanonicalPackageDescriptor, artifact: CanonicalArtifact | null) {
    const path = packagePath(descriptor)
    try {
      return await validated(path, descriptor, artifact)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !(await recover(descriptor))) throw error
      return validated(path, descriptor, artifact)
    }
  }

  async function read(
    descriptor: CanonicalPackageDescriptor,
    artifact: CanonicalArtifact,
  ): Promise<CanonicalArtifactRead> {
    // ponytail: validate the whole package per read; index ZIP entries only if large-document
    // profiling shows this prototype needs random-access package reads.
    const bytes = (await canonical(descriptor, artifact)) as Uint8Array
    return { bytes, mediaType: ENTRIES[artifact].mediaType }
  }

  async function available(
    descriptor: CanonicalPackageDescriptor,
  ): Promise<boolean> {
    try {
      await canonical(descriptor, null)
      return true
    } catch {
      return false
    }
  }

  async function quarantined(descriptor: CanonicalPackageDescriptor): Promise<string[]> {
    return (await entries())
      .filter((name) => LEFTOVER.exec(name)?.[1] === descriptor.artifactReference && name.endsWith('.deleting'))
      .sort()
  }

  /**
   * Gives a quarantine `name` back its canonical name when it is the whole, valid package `descriptor` names. The
   * hard link never replaces a canonical file another writer published (that file wins and is validated by whoever
   * reads it next), and the quarantine stays: a removal still running may yet restore or delete it.
   */
  async function install(descriptor: CanonicalPackageDescriptor, name: string): Promise<boolean> {
    const quarantine = join(root, name)
    try {
      await validated(quarantine, descriptor, null)
    } catch {
      return false // corrupt, truncated, not a regular file, or gone: never promoted
    }
    try {
      await link(quarantine, packagePath(descriptor))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return false
      if (code !== 'EEXIST') throw error
    }
    return true
  }

  /** True when a canonical file exists again: a removal interrupted between its quarantine and its decision left one. */
  async function recover(descriptor: CanonicalPackageDescriptor): Promise<boolean> {
    for (const name of await quarantined(descriptor)) if (await install(descriptor, name)) return true
    return false
  }

  /**
   * A reused package is in use again: refresh its age, so a sweep that already judged it old restores it instead of
   * deleting it under a revision that is about to reference it (remove's modifiedBeforeMs). False when it is gone.
   */
  async function touch(descriptor: CanonicalPackageDescriptor): Promise<boolean> {
    try {
      const now = new Date()
      await utimes(packagePath(descriptor), now, now)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async function save(packageBytes: Uint8Array) {
    const artifactSha256 = sha256(packageBytes)
    const descriptor = {
      artifactReference: artifactSha256,
      artifactSha256,
    }
    const { manifest, document } = validateEntries(unzipSync(packageBytes))
    const stored = () => validated(packagePath(descriptor), descriptor, null).then(() => true, () => false)
    // A sweep that quarantined it between the check and the touch leaves nothing to touch: publish it again below.
    if ((await stored()) && (await touch(descriptor)))
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
        if (!(await stored()) || !(await touch(descriptor))) throw error
        return { ...descriptor, document, manifest, published: false }
      }
    } finally {
      await rm(temporary, { force: true })
    }
    if (!(await stored()))
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
    options?: { modifiedBeforeMs?: number },
  ): Promise<boolean> {
    const path = packagePath(descriptor)
    // References are read twice. This first read leaves a package that is still referenced under its canonical name,
    // where its readers find it; the second, after the quarantine, sees a reference published meanwhile (a writer
    // that found the name missing in between published the package again).
    if (await isReferenced()) return false
    const quarantine = join(root, `${descriptor.artifactReference}.${randomUUID()}.deleting`)
    try {
      await rename(path, quarantine)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }

    // Restoring never replaces a canonical file a writer published meanwhile: that file's fresh age is what a later
    // sweep's cutoff reads. When it is a valid package, this quarantine is its stale twin; when it is not, the
    // quarantine stays as the valid copy.
    const restore = async () => {
      try {
        await link(quarantine, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await validated(path, descriptor, null)
      }
      await rm(quarantine, { force: true })
    }

    try {
      const cutoff = options?.modifiedBeforeMs
      if (cutoff !== undefined && (await lstat(quarantine)).mtimeMs >= cutoff) {
        await restore() // touched after the sweep's cutoff: a writer reuses it
        return false
      }
      if (await isReferenced()) { // the second reference read
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

  async function entries(): Promise<string[]> {
    try {
      return await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async function modified(name: string): Promise<number | null> {
    try {
      const info = await lstat(join(root, name))
      return info.isFile() ? info.mtimeMs : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null // removed meanwhile
      throw error
    }
  }

  async function list() {
    const found: { descriptor: CanonicalPackageDescriptor; modifiedMs: number }[] = []
    for (const name of await entries()) {
      const reference = PACKAGE_FILE.exec(name)?.[1]
      const modifiedMs = reference ? await modified(name) : null
      if (reference && modifiedMs !== null)
        found.push({ descriptor: { artifactReference: reference, artifactSha256: reference }, modifiedMs })
    }
    return found
  }

  async function leftovers() {
    const found: { name: string; modifiedMs: number }[] = []
    for (const name of await entries()) {
      const modifiedMs = LEFTOVER.test(name) ? await modified(name) : null
      if (modifiedMs !== null) found.push({ name, modifiedMs })
    }
    return found
  }

  async function removeLeftover(
    name: string,
    isReferenced: (artifactReference: string) => Promise<boolean>,
    options?: { modifiedBeforeMs?: number },
  ): Promise<boolean> {
    const match = LEFTOVER.exec(name)
    if (!match) throw new Error('Not a canonical package leftover.')
    if (match[2] === 'tmp') {
      await rm(join(root, name), { force: true }) // a partial write, never a package anyone references
      return true
    }
    // An interrupted removal: its package goes back under the canonical name, then through the ordinary removal with
    // fresh reference reads and the sweep's cutoff. Only once that settles is this name a redundant copy of whatever
    // remains (nothing, or the canonical file). An invalid quarantine, or one whose canonical name is taken by an
    // invalid file, is kept as it is: it may be the only evidence of the package.
    const reference = match[1]
    const descriptor = { artifactReference: reference, artifactSha256: reference }
    if (!(await install(descriptor, name))) return false
    try {
      await validated(packagePath(descriptor), descriptor, null)
    } catch {
      return false
    }
    await remove(descriptor, () => isReferenced(reference), options)
    await rm(join(root, name), { force: true })
    return true
  }

  return { save, read, available, list, leftovers, removeLeftover, remove }
}

export const canonicalPackageStore = createCanonicalPackageStore()
