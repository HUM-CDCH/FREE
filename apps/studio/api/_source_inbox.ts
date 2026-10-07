import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative as relativePath, resolve } from 'node:path'
import { studioDataRoot } from 'db'
import { CANONICAL_UUID_PATTERN as UUID } from 'studio-configuration'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'

// The names the builders below write (their UUIDs pass `canonicalUuidSchema`, whose pattern this is). A temporary's
// UUID comes from `randomUUID()`, a lowercase version-4 UUID, which the same pattern matches.
const UPLOAD = new RegExp(`^(${UUID})/(${UUID})\\.pdf$`)
const REPROCESS = new RegExp(`^(${UUID})/reprocess-(${UUID})-(${UUID})\\.pdf$`)
const TEMPORARY = new RegExp(`\\.pdf\\.${UUID}\\.tmp$`)
const PROJECT = new RegExp(`^${UUID}$`)

/** A file in the source inbox, as garbage collection sees it. */
export type StagedSource = Readonly<{
  /** `<projectContextId>/<file name>`, relative to the source inbox. */
  relative: string
  modifiedMs: number
  /** The workflow that owns the file, or null for a temporary or a name Studio never writes. */
  workflowId: string | null
  /** An interrupted `stageSource` write (`<target>.<uuid>.tmp`). */
  temporary: boolean
}>

/** One upload attempt's workflow ID: the handler enqueues it, the workflow names its kei child after it. */
export function ingestWorkflowId(projectContextId: string, attemptId: string): string {
  return `ingest:${projectContextId}:${attemptId}`
}

/** One reprocess request's workflow ID: the handler enqueues it, the workflow names its kei child after it. */
export function reprocessWorkflowId(sourceDocumentId: string, requestKey: string): string {
  return `reprocess:${sourceDocumentId}:${requestKey}`
}

/** Where Studio stages source PDFs for kei's worker, which mounts the same volume read-only (KEI_SOURCE_INBOX). An
 *  empty FREE_SOURCE_INBOX counts as unset: it would otherwise stage files in the working directory. */
export function sourceInboxRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.FREE_SOURCE_INBOX || join(studioDataRoot(), 'source-inbox')
}

/** `relative` resolved under `root`, refused unless it names a file strictly inside it (kei's `_staged` refuses the
 *  same paths on its side). The builders above already produce such paths; this holds for any caller. */
function inside(root: string, relative: string): string {
  const target = resolve(root, relative)
  const within = relativePath(resolve(root), target)
  if (relative === '' || isAbsolute(relative) || within === '' || within.startsWith('..') || isAbsolute(within) ||
      relative.endsWith('/'))
    throw new Error('A staged source must name a file inside the source inbox.')
  return target
}

function uuid(value: string, what: string): string {
  if (!canonicalUuidSchema.safeParse(value).success) throw new Error(`${what} must be a canonical lowercase UUID.`)
  return value
}

/** kei's `source` for an upload attempt. Files are named by project and attempt, never by content alone, so no two
 *  workflows share a file and garbage collection maps a file back to its workflow (spec, *Staged uploads*). */
export function uploadSourcePath(projectContextId: string, attemptId: string): string {
  return `${uuid(projectContextId, 'projectContextId')}/${uuid(attemptId, 'attemptId')}.pdf`
}

/** kei's `source` for a reprocess attempt, staged from the canonical package by the workflow's first step. */
export function reprocessSourcePath(projectContextId: string, sourceDocumentId: string, requestKey: string): string {
  return `${uuid(projectContextId, 'projectContextId')}/reprocess-${uuid(sourceDocumentId, 'sourceDocumentId')}-${uuid(requestKey, 'requestKey')}.pdf`
}

/** Writes `bytes` at `relative` atomically: a temporary sibling, fsync, rename, so kei never reads a partial file.
 *  An existing file of that name is replaced: a re-executed staging step writes the same bytes. */
export async function stageSource(root: string, relative: string, bytes: Uint8Array): Promise<void> {
  const target = inside(root, relative)
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(target), { recursive: true })
    const handle = await open(temporary, 'wx', 0o644)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** The staged bytes at `relative`, read by the workflow that owns them (never carried in its input). */
export async function readStagedSource(root: string, relative: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(inside(root, relative)))
}

export async function removeStagedSource(root: string, relative: string): Promise<void> {
  await rm(inside(root, relative), { force: true })
}

/** The workflow a staged file belongs to, or null for a name Studio never writes. */
export function stagedSourceWorkflowId(relative: string): string | null {
  const upload = UPLOAD.exec(relative)
  if (upload) return ingestWorkflowId(upload[1], upload[2])
  const reprocess = REPROCESS.exec(relative)
  return reprocess ? reprocessWorkflowId(reprocess[2], reprocess[3]) : null
}

/** Every file directly inside a UUID-named project directory, with its age and owning workflow. Lists only: an empty
 *  project directory stays, since removing it could race an upload's `mkdir` and fail that upload's write. */
export async function listStagedSources(root: string): Promise<readonly StagedSource[]> {
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const found: StagedSource[] = []
  for (const project of projects) {
    if (!project.isDirectory() || !PROJECT.test(project.name)) continue
    for (const file of await readdir(join(root, project.name), { withFileTypes: true })) {
      if (!file.isFile()) continue
      const relative = `${project.name}/${file.name}`
      let modifiedMs: number
      try {
        modifiedMs = (await lstat(join(root, relative))).mtimeMs
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // removed meanwhile
        throw error
      }
      const temporary = TEMPORARY.test(file.name)
      found.push({ relative, modifiedMs, workflowId: temporary ? null : stagedSourceWorkflowId(relative), temporary })
    }
  }
  return found
}
