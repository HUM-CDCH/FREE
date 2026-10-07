import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { studioDataRoot } from 'db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listStagedSources,
  removeStagedSource,
  reprocessSourcePath,
  sourceInboxRoot,
  stagedSourceWorkflowId,
  stageSource,
  uploadSourcePath,
} from './_source_inbox'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222'
const ATTEMPT = '33333333-3333-4333-8333-333333333333'
const DOCUMENT = '44444444-4444-4444-8444-444444444444'
const KEY = '55555555-5555-4555-8555-555555555555'
const bytes = new TextEncoder().encode('%PDF-1.4\nstaged\n')

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'free-source-inbox-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

describe('source inbox', () => {
  it('stages an upload atomically under <project>/<attempt>.pdf', async () => {
    const relative = uploadSourcePath(PROJECT, ATTEMPT)
    expect(relative).toBe(`${PROJECT}/${ATTEMPT}.pdf`)
    await stageSource(root, relative, bytes)
    expect(new Uint8Array(await readFile(join(root, relative)))).toEqual(bytes)
    expect(await readdir(join(root, PROJECT))).toEqual([`${ATTEMPT}.pdf`])
  })

  it('identical bytes in two projects stage two independent files', async () => {
    const first = uploadSourcePath(PROJECT, ATTEMPT)
    const second = uploadSourcePath(OTHER_PROJECT, ATTEMPT)
    expect(first).not.toBe(second)
    await stageSource(root, first, bytes)
    await stageSource(root, second, bytes)
    await removeStagedSource(root, first)
    expect(await exists(join(root, first))).toBe(false)
    expect(new Uint8Array(await readFile(join(root, second)))).toEqual(bytes)
  })

  it('a failed write leaves neither the staged file nor its temporary sibling', async () => {
    await writeFile(join(root, PROJECT), 'not a directory')
    await expect(stageSource(root, uploadSourcePath(PROJECT, ATTEMPT), bytes)).rejects.toThrow()
    expect(await readdir(root)).toEqual([PROJECT])
    expect(await readFile(join(root, PROJECT), 'utf8')).toBe('not a directory')
  })

  it('a write that fails after its temporary file exists removes that temporary file', async () => {
    const relative = uploadSourcePath(PROJECT, ATTEMPT)
    // A non-empty directory where the file goes: the temporary file is written, then its rename fails.
    await mkdir(join(root, relative, 'occupied'), { recursive: true })
    await expect(stageSource(root, relative, bytes)).rejects.toThrow()
    expect(await readdir(join(root, PROJECT))).toEqual([`${ATTEMPT}.pdf`])
    expect(await readdir(join(root, relative))).toEqual(['occupied'])
  })

  it('refuses a path that leaves the inbox, before touching the disk', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'free-source-outside-'))
    try {
      const escapes = ['', '.', `../${PROJECT}.pdf`, `${PROJECT}/../../x.pdf`, join(outside, 'x.pdf'), `${PROJECT}/`]
      for (const relative of escapes) {
        await expect(stageSource(root, relative, bytes)).rejects.toThrow(/inside the source inbox/)
        await expect(removeStagedSource(root, relative)).rejects.toThrow(/inside the source inbox/)
      }
      expect(await readdir(root)).toEqual([])
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('staging the same name again replaces the file', async () => {
    const relative = uploadSourcePath(PROJECT, ATTEMPT)
    await stageSource(root, relative, new TextEncoder().encode('first'))
    await stageSource(root, relative, bytes)
    expect(new Uint8Array(await readFile(join(root, relative)))).toEqual(bytes)
    expect(await readdir(join(root, PROJECT))).toEqual([`${ATTEMPT}.pdf`])
  })

  it('refuses identifiers that are not canonical lowercase UUIDs', async () => {
    const uppercase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    for (const bad of ['../x', uppercase, '']) {
      expect(() => uploadSourcePath(bad, ATTEMPT)).toThrow(/canonical lowercase UUID/)
      expect(() => uploadSourcePath(PROJECT, bad)).toThrow(/canonical lowercase UUID/)
      expect(() => reprocessSourcePath(bad, DOCUMENT, KEY)).toThrow(/canonical lowercase UUID/)
      expect(() => reprocessSourcePath(PROJECT, bad, KEY)).toThrow(/canonical lowercase UUID/)
      expect(() => reprocessSourcePath(PROJECT, DOCUMENT, bad)).toThrow(/canonical lowercase UUID/)
    }
    expect(await readdir(root)).toEqual([])
  })

  it('names a reprocess source by its document and request key', () => {
    expect(reprocessSourcePath(PROJECT, DOCUMENT, KEY)).toBe(`${PROJECT}/reprocess-${DOCUMENT}-${KEY}.pdf`)
  })

  it("the inbox is FREE_SOURCE_INBOX, else source-inbox under Studio's data directory", () => {
    expect(sourceInboxRoot({ FREE_SOURCE_INBOX: '/var/lib/free/source-inbox' })).toBe('/var/lib/free/source-inbox')
    expect(sourceInboxRoot({})).toBe(join(studioDataRoot(), 'source-inbox'))
  })

  it('an empty FREE_SOURCE_INBOX is unset, never the working directory', () => {
    expect(sourceInboxRoot({ FREE_SOURCE_INBOX: '' })).toBe(join(studioDataRoot(), 'source-inbox'))
  })

  it('maps an upload file to its ingest workflow and a reprocess file to its reprocess workflow', () => {
    expect(stagedSourceWorkflowId(uploadSourcePath(PROJECT, ATTEMPT))).toBe(`ingest:${PROJECT}:${ATTEMPT}`)
    expect(stagedSourceWorkflowId(reprocessSourcePath(PROJECT, DOCUMENT, KEY))).toBe(`reprocess:${DOCUMENT}:${KEY}`)
    const uppercase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    for (const unknown of ['x/y.pdf', '../a.pdf', `${PROJECT}/${uppercase}.pdf`, `${uppercase}/${ATTEMPT}.pdf`])
      expect(stagedSourceWorkflowId(unknown)).toBeNull()
  })

  it('lists staged files and stale temporaries with their times; an unknown name maps to no workflow', async () => {
    const upload = uploadSourcePath(PROJECT, ATTEMPT)
    const reprocess = reprocessSourcePath(PROJECT, DOCUMENT, KEY)
    await stageSource(root, upload, bytes)
    await stageSource(root, reprocess, bytes)
    const temporary = `${upload}.${randomUUID()}.tmp`
    await writeFile(join(root, temporary), 'interrupted')
    await writeFile(join(root, PROJECT, 'notes.txt'), 'not staged by Studio')
    await writeFile(join(root, `${ATTEMPT}.pdf`), 'outside a project directory')
    await mkdir(join(root, 'not-a-project'))
    await writeFile(join(root, 'not-a-project', `${ATTEMPT}.pdf`), 'outside a project directory')
    await mkdir(join(root, OTHER_PROJECT))

    const modifiedMs = async (relative: string) => (await lstat(join(root, relative))).mtimeMs
    const listed = [...(await listStagedSources(root))].sort((a, b) => a.relative.localeCompare(b.relative))
    expect(listed).toEqual(
      [
        { relative: upload, modifiedMs: await modifiedMs(upload), workflowId: `ingest:${PROJECT}:${ATTEMPT}`, temporary: false },
        { relative: temporary, modifiedMs: await modifiedMs(temporary), workflowId: null, temporary: true },
        { relative: `${PROJECT}/notes.txt`, modifiedMs: await modifiedMs(`${PROJECT}/notes.txt`), workflowId: null, temporary: false },
        { relative: reprocess, modifiedMs: await modifiedMs(reprocess), workflowId: `reprocess:${DOCUMENT}:${KEY}`, temporary: false },
      ].sort((a, b) => a.relative.localeCompare(b.relative)),
    )
    // Listing never removes anything, an empty project directory included.
    expect(await readdir(join(root, OTHER_PROJECT))).toEqual([])
    expect(await listStagedSources(join(root, 'missing'))).toEqual([])
  })
})
