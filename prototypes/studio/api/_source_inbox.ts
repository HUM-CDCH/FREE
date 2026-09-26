import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { studioDataRoot } from 'db'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'

/** Where Studio stages source PDFs for kei's worker, which mounts the same volume read-only (KEI_SOURCE_INBOX). */
export function sourceInboxRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.FREE_SOURCE_INBOX ?? join(studioDataRoot(), 'source-inbox')
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
  const target = join(root, relative)
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

export async function removeStagedSource(root: string, relative: string): Promise<void> {
  await rm(join(root, relative), { force: true })
}
