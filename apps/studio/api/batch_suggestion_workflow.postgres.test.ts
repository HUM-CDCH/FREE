import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, pool } from 'db'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../server/dbos.js'
import { awaitWorkflowOutcome } from '../server/workflowOutcome.js'
import { runWorkflowChild } from '../test/support/crash.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import {
  longSourceMarkdown,
  readModelCalls,
  removeSuggestionSources,
  scriptedGenerate,
  seedSuggestionSources,
  suggestionPorts,
  suggestionResearcherStore,
  type SeededSuggestionSources,
} from '../test/support/suggestionWorkflow.js'
import { databaseHolds } from '../test/support/interactive.js'
import { registerBatchSuggestionWorkflow } from './_batch_suggestion_workflow.js'

const url = disposableDatabaseUrl()
const scratch = mkdtempSync(join(tmpdir(), 'free-suggestion-workflow-'))
const packageRoot = join(scratch, 'packages')
const packages = createCanonicalPackageStore(packageRoot)
// This process runs suggestSchemaBatch on `schemas`; each crash child gets schemas of its own, so neither queue runner
// dequeues the other's attempts.
const schemas = testSchemas()
const dropped: string[] = [schemas.schema, schemas.keiSchema]
const seeded: SeededSuggestionSources[] = []
const inProcessLog = join(scratch, 'in-process-model.log')
/** Decides, before the in-process model answers a call, whether it fails instead. */
let beforeInProcessCall: (call: string) => void = () => {}

async function suggestionRow(projectContextId: string) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{
      id: string
      attempt: number
      outcome: string | null
      failure: { code: string } | null
      phase: string | null
      draftVersion: number
      xmin: string
    }>(
      'SELECT id, attempt, outcome, failure, phase, "draftVersion", xmin::text AS xmin FROM "batchSchemaSuggestion" WHERE "projectContextId" = $1',
      [projectContextId],
    )
    return rows[0]
  } finally {
    await client.end()
  }
}

/** A crash child's environment over `sources`: its own DBOS schemas, executor, marker and model log. */
function childEnv(sources: SeededSuggestionSources, extra: Record<string, string> = {}) {
  const names = testSchemas()
  dropped.push(names.schema, names.keiSchema)
  return {
    DATABASE_URL: url,
    FREE_TEST_DBOS_SCHEMA: names.schema,
    FREE_TEST_KEI_SCHEMA: names.keiSchema,
    FREE_TEST_EXECUTOR: names.executorId,
    FREE_TEST_PACKAGE_ROOT: packageRoot,
    FREE_TEST_ACCOUNT: sources.researcherAccountId,
    FREE_TEST_PROJECT: sources.projectContextId,
    FREE_TEST_SOURCES: sources.sources.map((source) => source.sourceDocumentId).join(','),
    FREE_TEST_MODEL_LOG: join(scratch, `model-${sources.projectContextId}.log`),
    FREE_CRASH_MARKER: join(scratch, `marker-${sources.projectContextId}`),
    ...extra,
  }
}

async function seed(letters: readonly string[]) {
  const sources = await seedSuggestionSources(packages, letters)
  seeded.push(sources)
  return sources
}

beforeAll(async () => {
  await launchStudioDbos({
    databaseUrl: url,
    ...schemas,
    register: () =>
      registerBatchSuggestionWorkflow(() =>
        suggestionPorts(packages, scriptedGenerate(inProcessLog, (call) => beforeInProcessCall(call)))),
  })
})

afterAll(async () => {
  try {
    await shutdownStudioDbos()
    for (const sources of seeded) await removeSuggestionSources(sources)
  } finally {
    try {
      await dropSchemas(url, ...dropped)
    } finally {
      await db.close()
      await pool.end()
      rmSync(scratch, { recursive: true, force: true })
    }
  }
})

describe('suggestSchemaBatch on PostgreSQL', () => {
  it('a manual retry regenerates every surviving pin', async () => {
    const { researcherAccountId, projectContextId, sources } = await seed(['A', 'B'])
    const order = sources.map((source) => `source ${source.letter}`)
    let failB = true
    beforeInProcessCall = (call) => {
      if (call === 'source B' && failB) {
        failB = false
        throw new Error('the model failed on source B')
      }
    }
    const store = suggestionResearcherStore(researcherAccountId)
    const created = await store.createBatchSchemaSuggestion(projectContextId, sources.map((source) => source.sourceDocumentId))
    if (!created || !('suggestion' in created)) throw new Error('The suggestion was not created.')
    const id = created.suggestion.batchSchemaSuggestionId

    expect((await awaitWorkflowOutcome(studioDbos().admission, `suggest:${id}:1`, { timeoutMs: 60_000 })).state).toBe('finished')
    const first = await suggestionRow(projectContextId)
    expect(first).toMatchObject({ attempt: 1, outcome: 'FAILED', failure: { code: 'source_suggestion_failed' }, phase: null, draftVersion: 0 })
    // The attempt ended at source B: a source after it never ran.
    const firstCalls = readModelCalls(inProcessLog)
    expect(firstCalls).toEqual(order.slice(0, order.indexOf('source B') + 1))

    const retried = await store.retryBatchSchemaSuggestion(projectContextId, id, 1)
    expect(retried?.status).toBe('retried')
    expect((await awaitWorkflowOutcome(studioDbos().admission, `suggest:${id}:2`, { timeoutMs: 60_000 })).state).toBe('finished')
    // Attempt 2 reused none of attempt 1's source checkpoints: every pin ran again, then the merge.
    expect(readModelCalls(inProcessLog).slice(firstCalls.length)).toEqual([...order, 'merge'])
    expect(await suggestionRow(projectContextId)).toMatchObject({ attempt: 2, outcome: 'SUCCEEDED', failure: null, phase: 'READY', draftVersion: 1 })
    const read = await store.getBatchSchemaSuggestion(projectContextId, id)
    expect(read).toMatchObject({ attempt: 2, executionStatus: 'COMPLETED' })
    expect(read?.draft).toEqual(read?.proposal)
  })

  it('crash recovery of one attempt skips the sources it checkpointed', async () => {
    const sources = await seed(['A', 'B'])
    const [first, second] = sources.sources.map((source) => `source ${source.letter}`)
    const env = childEnv(sources, { FREE_TEST_KILL_AT: second! })

    const killed = await runWorkflowChild('suggestion-recover', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    expect(readModelCalls(env.FREE_TEST_MODEL_LOG)).toEqual([first, second])
    expect((await suggestionRow(sources.projectContextId))?.outcome).toBeNull()

    const recovered = await runWorkflowChild('suggestion-recover', env)
    expect(recovered.code, recovered.output).toBe(0)
    // The first source's step had checkpointed: the recovered attempt ran only the source it died in, then merged.
    expect(readModelCalls(env.FREE_TEST_MODEL_LOG)).toEqual([first, second, second, 'merge'])
    expect(await suggestionRow(sources.projectContextId)).toMatchObject({ attempt: 1, outcome: 'SUCCEEDED', phase: 'READY', draftVersion: 1 })
  })

  it('crash recovery of a long source skips its checkpointed windows and keeps the source out of DBOS', async () => {
    const sources = await seedSuggestionSources(packages, ['A', 'L'], (letter) => letter === 'L' ? longSourceMarkdown(letter) : `# Source ${letter}`)
    seeded.push(sources)
    const env = childEnv(sources, { FREE_TEST_KILL_AT: 'part 2' })

    const killed = await runWorkflowChild('suggestion-recover', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    const recovered = await runWorkflowChild('suggestion-recover', env)
    expect(recovered.code, recovered.output).toBe(0)

    // Window 1 checkpointed before the kill: only the window the process died in runs again.
    const calls = readModelCalls(env.FREE_TEST_MODEL_LOG)
    const count = (call: string) => calls.filter((made) => made === call).length
    expect([count('source A'), count('source L'), count('part 2'), count('part 3'), count('union'), count('merge')])
      .toEqual([1, 1, 2, 1, 1, 1])
    expect(await suggestionRow(sources.projectContextId)).toMatchObject({ outcome: 'SUCCEEDED', phase: 'READY' })
    expect(await databaseHolds(url, 'b'.repeat(64), [env.FREE_TEST_DBOS_SCHEMA])).toEqual([])
  })

  it('a draft published before a kill is published once', async () => {
    const sources = await seed(['A', 'B'])
    const env = childEnv(sources)

    const killed = await runWorkflowChild('suggestion-publish', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    const published = await suggestionRow(sources.projectContextId)
    expect(published).toMatchObject({ attempt: 1, outcome: 'SUCCEEDED', draftVersion: 1 })

    const recovered = await runWorkflowChild('suggestion-publish', env)
    expect(recovered.code, recovered.output).toBe(0)
    const row = await suggestionRow(sources.projectContextId)
    expect(row).toMatchObject({ attempt: 1, outcome: 'SUCCEEDED', phase: 'READY', draftVersion: 1 })
    // The replayed publication found the outcome written and updated nothing.
    expect(row?.xmin).toBe(published!.xmin)
    // The merge had checkpointed before the kill: recovery called no model.
    expect(readModelCalls(env.FREE_TEST_MODEL_LOG)).toEqual([...sources.sources.map((source) => `source ${source.letter}`), 'merge'])
  })
})
