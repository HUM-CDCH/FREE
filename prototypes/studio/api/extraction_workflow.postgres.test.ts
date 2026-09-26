import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DBOSClient } from '@dbos-inc/dbos-sdk'
import pg from 'pg'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { db, pool } from 'db'
import { keiExpArtifact } from 'extraction/kei-exp-fixture'
import { KEI_APPLICATION, keiExtractWorkflowId, type KeiExtractInput } from 'extraction/kei-handoff'
import { spawnKeiStandIn, type KeiStandInProcess } from 'extraction/kei-stand-in-client'
import { createCanonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import { runWorkflowChild } from '../test/support/crash.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import { removeResearch, seedResearch, type SeededResearch } from '../test/support/research.js'

const url = disposableDatabaseUrl()
const scratch = mkdtempSync(join(tmpdir(), 'free-extraction-workflow-'))
const packageRoot = join(scratch, 'packages')
const packages = createCanonicalPackageStore(packageRoot)
const seeded: SeededResearch[] = []
const schemas: string[] = []
let standIn: KeiStandInProcess | undefined
let kei: DBOSClient | undefined

async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<T[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<T>(text, values)).rows
  } finally {
    await client.end()
  }
}

/** One Studio process's DBOS schemas and its own kei stand-in (a kei schema of its own). */
async function studioWithKei(mode: 'kill-after-settle' | 'kill-while-held') {
  const names = testSchemas()
  schemas.push(names.schema, names.keiSchema)
  standIn = await spawnKeiStandIn({ databaseUrl: url, schema: names.keiSchema })
  kei = await DBOSClient.create({
    systemDatabaseUrl: url, systemDatabaseSchemaName: names.keiSchema, applicationName: KEI_APPLICATION,
  })
  const research = await seedResearch(packages)
  seeded.push(research)
  const extractionId = randomUUID()
  const env = {
    DATABASE_URL: url,
    KEI_EXP_URL: standIn.url,
    FREE_TEST_DBOS_SCHEMA: names.schema,
    FREE_TEST_KEI_SCHEMA: names.keiSchema,
    FREE_TEST_EXECUTOR: names.executorId,
    FREE_TEST_PACKAGE_ROOT: packageRoot,
    FREE_TEST_EXTRACTION_MODE: mode,
    FREE_TEST_EXTRACTION_ID: extractionId,
    FREE_TEST_ACCOUNT: research.researcherAccountId,
    FREE_TEST_REVISION: research.sourceRepresentationRevisionId,
    FREE_TEST_SCHEMA_REVISION: research.schemaRevisionId,
    FREE_CRASH_MARKER: join(scratch, `marker-${extractionId}`),
  }
  return { research, extractionId, env, keiChildren: () => kei!.listWorkflows({ workflow_id_prefix: 'kei-extract:', loadInput: false }) }
}

async function extractionRow(extractionId: string) {
  const [row] = await sql<{ outcome: string | null; resultPayload: unknown; xmin: string }>(
    'SELECT outcome, "resultPayload", xmin::text AS xmin FROM extraction WHERE id = $1', [extractionId])
  return row
}

afterEach(async () => {
  try {
    await standIn?.stop()
  } finally {
    standIn = undefined
    await kei?.destroy()
    kei = undefined
  }
})

afterAll(async () => {
  try {
    for (const research of seeded) await removeResearch(research)
  } finally {
    try {
      await dropSchemas(url, ...schemas)
    } finally {
      await db.close()
      await pool.end()
      rmSync(scratch, { recursive: true, force: true })
    }
  }
})

describe('runExtraction across Studio restarts', () => {
  it('an Extraction published before a kill is not published again after recovery', async () => {
    const { research, extractionId, env, keiChildren } = await studioWithKei('kill-after-settle')

    const killed = await runWorkflowChild('extraction-publish', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    const published = await extractionRow(extractionId)
    expect(published?.outcome).toBe('SUCCEEDED')

    const recovered = await runWorkflowChild('extraction-publish', env)
    expect(recovered.code, recovered.output).toBe(0)

    const artifact = JSON.parse(new TextDecoder().decode(new Uint8Array(await (await fetch(
      `${standIn!.url}/api/runs/${research.runId}/extractions/${extractionId}`,
    )).arrayBuffer()))) as { records: unknown[] }
    const row = await extractionRow(extractionId)
    expect(row?.outcome).toBe('SUCCEEDED')
    expect(row?.resultPayload).toEqual({ records: artifact.records })
    // The replayed publication found the outcome written and updated nothing.
    expect(row?.xmin).toBe(published!.xmin)
    expect((await keiChildren()).map((child) => child.workflowID)).toEqual([keiExtractWorkflowId(extractionId)])
  })

  it('a Studio restart with an Extraction in flight resumes polling the same kei child', async () => {
    const { research, extractionId, env, keiChildren } = await studioWithKei('kill-while-held')
    await standIn!.policy({ extract: 'hold' })

    const killed = await runWorkflowChild('extraction-publish', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    expect((await extractionRow(extractionId))?.outcome).toBeNull()

    const recovering = runWorkflowChild('extraction-publish', env)
    const [held] = await standIn!.held()
    expect(held?.workflowId).toBe(keiExtractWorkflowId(extractionId))
    const request = held!.request as KeiExtractInput
    const records = [{ title: 'Held, then answered' }]
    await standIn!.answer(held!.workflowId, {
      artifact: keiExpArtifact({
        run_id: request.run_id,
        generation: request.generation,
        strategy: 'article',
        schema: request.request.schema as { recordDescription: string; schemaNodes: unknown[] },
        options: { model: null, models: null, ...request.request.options } as never,
        model: 'fixture/nuextract',
        models: { fields: 'fixture/nuextract', reasoning: 'fixture/nuextract' },
        complete: true,
        records,
        evidence: [],
        ungrounded: [['records', 0, 'title']],
      }),
    })
    const recovered = await recovering
    expect(recovered.code, recovered.output).toBe(0)

    expect(request.run_id).toBe(research.runId)
    const row = await extractionRow(extractionId)
    expect(row?.outcome).toBe('SUCCEEDED')
    expect(row?.resultPayload).toEqual({ records })
    expect((await keiChildren()).map((child) => child.workflowID)).toEqual([keiExtractWorkflowId(extractionId)])
  })
})
