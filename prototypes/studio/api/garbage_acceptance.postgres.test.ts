import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, pool } from 'db'
import { spawnKeiStandIn, type KeiStandInProcess } from 'extraction/kei-stand-in-client'
import { createCanonicalPackageStore, packCanonicalPackage } from '../../../packages/db/src/artifact-store.js'
import { garbagePorts, type GarbageSummary } from './_garbage_workflow.js'
import { listStagedSources, removeStagedSource } from './_source_inbox.js'
import { launchStudioDbos, shutdownStudioDbos } from '../server/dbos.js'
import { applyStudioSchedules, registerStudioWorkflows } from '../server/workflows.js'
import { runWorkflowChild } from '../test/support/crash.js'
import { ageFile } from '../test/support/garbage.js'
import { publishFixtureParse, removeOwner, seedOwner } from '../test/support/ingestion.js'
import { blankPdf } from '../test/support/pdf.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'

const url = disposableDatabaseUrl()
const schemas = testSchemas()
const scratch = mkdtempSync(join(tmpdir(), 'free-gc-acceptance-'))
const pdf = join(scratch, 'source.pdf')
writeFileSync(pdf, blankPdf(1))
let standIn: KeiStandInProcess

beforeAll(async () => {
  standIn = await spawnKeiStandIn({ databaseUrl: url, schema: schemas.keiSchema })
})

afterAll(async () => {
  try {
    await standIn?.stop()
  } finally {
    await dropSchemas(url, schemas.schema, schemas.keiSchema)
    await db.close()
    await pool.end()
    rmSync(scratch, { recursive: true, force: true })
  }
})

describe('garbage collection across Studio processes', () => {
  it('collects a staged orphan after a crash once old, while keeping a young staged source', async () => {
    const env = {
      DATABASE_URL: url, ...{
        FREE_TEST_DBOS_SCHEMA: schemas.schema, FREE_TEST_KEI_SCHEMA: schemas.keiSchema,
        FREE_TEST_EXECUTOR: schemas.executorId,
      },
      FREE_TEST_INBOX: join(scratch, 'inbox'), FREE_TEST_PACKAGE_ROOT: join(scratch, 'packages'),
      FREE_TEST_PROJECT: randomUUID(), FREE_TEST_OLD_ATTEMPT: randomUUID(), FREE_TEST_YOUNG_ATTEMPT: randomUUID(),
      FREE_TEST_PDF: pdf, GC_OBSERVATIONS: join(scratch, 'staged-observations.json'),
      FREE_CRASH_MARKER: join(scratch, 'staged-first-run'),
    }
    const first = await runWorkflowChild('gc-staged-sources', env)
    expect(first.signal).toBe('SIGKILL')
    const second = await runWorkflowChild('gc-staged-sources', env)
    expect(second).toMatchObject({ code: 0, signal: null })
    const observations = JSON.parse(readFileSync(env.GC_OBSERVATIONS, 'utf8')) as {
      summary: { removedStagedSources: number; failedPhases: string[] }
      oldExists: boolean; youngExists: boolean
    }
    expect(observations.summary.failedPhases).toEqual([])
    expect(observations.summary.removedStagedSources).toBe(1)
    expect(observations.oldExists).toBe(false)
    expect(observations.youngExists).toBe(true)
  })

  it('keeps cancelled history from this process and deletes it after the next boot', async () => {
    const names = testSchemas()
    const env = {
      DATABASE_URL: url,
      FREE_TEST_DBOS_SCHEMA: names.schema, FREE_TEST_KEI_SCHEMA: schemas.keiSchema,
      FREE_TEST_EXECUTOR: names.executorId,
      FREE_TEST_INBOX: join(scratch, 'history-inbox'), FREE_TEST_PACKAGE_ROOT: join(scratch, 'history-packages'),
      GC_OBSERVATIONS: join(scratch, 'history-observations.json'),
      GC_ENTERED: join(scratch, 'history-entered'), GC_LATCH: join(scratch, 'history-latch'),
      FREE_CRASH_MARKER: join(scratch, 'history-first-run'),
    }
    try {
      const first = await runWorkflowChild('gc-cancelled-history', env)
      expect(first).toMatchObject({ code: 0, signal: null })
      const second = await runWorkflowChild('gc-cancelled-history', env)
      expect(second).toMatchObject({ code: 0, signal: null })
      const observed = JSON.parse(readFileSync(env.GC_OBSERVATIONS, 'utf8')) as {
        currentDeleted: number; currentStatus: string
        nextDeleted: number; nextStatus: string | null; orphanPayloads: number
      }
      expect(observed.currentDeleted).toBe(0)
      expect(observed.currentStatus).toBe('CANCELLED')
      expect(observed.nextDeleted).toBeGreaterThanOrEqual(1)
      expect(observed.nextStatus).toBeNull()
      expect(observed.orphanPayloads).toBe(0)
    } finally {
      await dropSchemas(url, names.schema)
    }
  })

  it('keeps an old referenced package and removes it after its Project Context is deleted', async () => {
    const names = testSchemas()
    const root = join(scratch, 'reference-packages')
    const inbox = join(scratch, 'reference-inbox')
    const packages = createCanonicalPackageStore(root)
    const { owner, store } = await seedOwner()
    try {
      const project = (await store.createProjectContext(`GC ${randomUUID()}`)).projectContextId
      await publishFixtureParse(packages, store, project, blankPdf(1, randomUUID()))
      const [entry] = await packages.list()
      expect(entry).toBeDefined()
      const freshPdf = blankPdf(1, randomUUID())
      const fresh = await packages.save(packCanonicalPackage({
        pdf: freshPdf,
        document: {
          schema_version: 'parsed_document.v2',
          document: { content_sha256: createHash('sha256').update(freshPdf).digest('hex') },
          preprocessing: { preprocess_id: `fresh-${randomUUID()}` },
        },
        markdown: '# Fresh package',
      }))
      await ageFile(join(root, `${fresh.artifactReference}.zip`), 3600_000)
      await ageFile(join(root, `${entry!.descriptor.artifactReference}.zip`), 25 * 3600_000)
      await launchStudioDbos({
        databaseUrl: url, ...names, keiSchema: schemas.keiSchema,
        register: () => registerStudioWorkflows({ garbagePorts: () => garbagePorts({
          packages, inbox: { root: inbox, list: listStagedSources, remove: removeStagedSource },
        }) }),
        schedule: applyStudioSchedules,
      })
      const first = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
      expect(first.failedPhases).toEqual([])
      expect(first.removedPackages).toBe(0)
      expect(await packages.available(entry!.descriptor)).toBe(true)
      expect(await packages.available(fresh)).toBe(true)

      expect(await store.deleteProjectContext(project)).toBe(true)
      const second = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
      expect(second.failedPhases).toEqual([])
      expect(second.removedPackages).toBe(1)
      expect(await packages.available(entry!.descriptor)).toBe(false)
      expect(await packages.available(fresh)).toBe(true)
    } finally {
      await shutdownStudioDbos()
      await dropSchemas(url, names.schema)
      await removeOwner(owner)
    }
  })

  it('keeps a recovered ingestion\'s old staged source while collecting an orphaned losing upload', async () => {
    const names = testSchemas()
    const { owner, store } = await seedOwner()
    const project = (await store.createProjectContext(`GC ${randomUUID()}`)).projectContextId
    const env = {
      DATABASE_URL: url, FREE_TEST_DBOS_SCHEMA: names.schema, FREE_TEST_KEI_SCHEMA: schemas.keiSchema,
      FREE_TEST_EXECUTOR: names.executorId, FREE_TEST_ACCOUNT: owner, FREE_TEST_PROJECT: project,
      FREE_TEST_PDF: pdf, FREE_SOURCE_INBOX: join(scratch, 'held-inbox'),
      XDG_DATA_HOME: join(scratch, 'held-data'), KEI_EXP_URL: standIn.url,
      GC_OBSERVATIONS: join(scratch, 'held-observations.json'),
      FREE_CRASH_MARKER: join(scratch, 'held-first-run'),
    }
    await standIn.policy({ convert: 'hold' })
    try {
      expect((await runWorkflowChild('gc-held-ingestion', env)).signal).toBe('SIGKILL')
      expect((await runWorkflowChild('gc-held-ingestion', env)).signal).toBe('SIGKILL')
      const deadline = Date.now() + 20_000
      let held = await standIn.held()
      while (held.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        held = await standIn.held()
      }
      expect(held).toHaveLength(1)
      const during = JSON.parse(readFileSync(env.GC_OBSERVATIONS, 'utf8')) as {
        heldStatus: string; keptFile: boolean; removedLoser: boolean; removedStagedSources: number
        keiRequest: { conversions: string[] } | null; failedPhases: string[]
      }
      expect(during.failedPhases).toEqual([])
      expect(during.keptFile).toBe(true)
      expect(during.removedLoser).toBe(true)
      expect(during.removedStagedSources).toBe(1)
      expect(during.keiRequest?.conversions ?? []).toEqual([])
      await standIn.answer(held[0]!.workflowId, { convert: 'auto' })
      const final = await runWorkflowChild('gc-held-ingestion', env)
      expect(final).toMatchObject({ code: 0, signal: null })
      const finished = JSON.parse(readFileSync(env.GC_OBSERVATIONS, 'utf8')) as {
        outcome: string; stagedAfter: boolean; publishedPackages: number
      }
      expect(finished.outcome).toBe('finished')
      expect(finished.stagedAfter).toBe(false)
      expect(finished.publishedPackages).toBe(1)
    } finally {
      for (const work of await standIn.held()) await standIn.answer(work.workflowId, { convert: 'auto' })
      await standIn.policy({ convert: 'auto' })
      await dropSchemas(url, names.schema)
      await removeOwner(owner)
    }
  })

})
