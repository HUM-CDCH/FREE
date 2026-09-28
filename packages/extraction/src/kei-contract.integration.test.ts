import { DBOSClient } from '@dbos-inc/dbos-sdk'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'
import pg from 'pg'
import { createKeiExpClient } from './kei-exp.js'
import { createKeiHandoff, KEI_APPLICATION, keiExtractWorkflowId } from './kei-handoff.js'
import { fixture } from './testing/extraction-fixture.js'

describe('through kei\'s contract', { skip: !fixture && 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database' }, () => {
  if (!fixture) return
  const {
    kei, scriptedPorts, ports, seedProject, createRuntime,
    freshInput, cleanup, disposableDatabaseUrl, spawnKeiStandIn,
  } = fixture
  const keiSchema = `kei_dbos_t_${randomBytes(4).toString('hex')}`
  let standIn: Awaited<ReturnType<typeof spawnKeiStandIn>> | undefined
  let keiClient: DBOSClient | undefined

  after(async () => {
    try {
      await standIn?.stop()
    } finally {
      try {
        await keiClient?.destroy()
      } finally {
        const admin = new pg.Client({ connectionString: disposableDatabaseUrl })
        await admin.connect()
        try {
          if (!/^kei_dbos_t_[0-9a-f]{8}$/.test(keiSchema)) throw new Error(`Refusing to drop schema ${keiSchema}.`)
          await admin.query(`DROP SCHEMA IF EXISTS "${keiSchema}" CASCADE`)
        } finally {
          await admin.end()
        }
      }
    }
  })

  it('an Extraction runs end to end on the stand-in and publishes the artifact kei published', async (t) => {
    t.after(cleanup)
    standIn = await spawnKeiStandIn({ databaseUrl: disposableDatabaseUrl, schema: keiSchema })
    await standIn.policy({ extract: 'auto' })
    keiClient = await DBOSClient.create({
      systemDatabaseUrl: disposableDatabaseUrl, systemDatabaseSchemaName: keiSchema, applicationName: KEI_APPLICATION,
    })
    const keiExp = createKeiExpClient({ url: standIn.url })
    ports.current = {
      ...scriptedPorts,
      kei: createKeiHandoff(keiClient, { pollWindowMs: 3_000, pollIntervalMs: 100 }),
      readArtifact: (runId, extractionId, signal) => keiExp.readExtractionArtifact(runId, extractionId, signal),
    }
    const project = await seedProject()
    const document = project.documents[0]!
    const { module } = createRuntime(project.researcherAccountId)
    const input = freshInput(project)
    const completed = await module.runSingle(input)
    assert.equal(completed.extraction.executionStatus, 'COMPLETED')
    const published = JSON.parse(new TextDecoder().decode(
      await keiExp.readExtractionArtifact(document.runId, input.extractionId),
    )) as { records: unknown[]; model: string; models: Record<string, string>; complete: boolean }
    assert.deepEqual(completed.extraction.result, { records: published.records })
    assert.equal(completed.extraction.complete, published.complete)
    assert.deepEqual(completed.extraction.modelAttribution, { provider: 'kei-exp', modelId: published.model })
    assert.deepEqual(completed.extraction.diagnostics?.models, published.models)
    const [child] = await keiClient.listWorkflows({ workflowIDs: [keiExtractWorkflowId(input.extractionId)], loadInput: false })
    assert.equal(child?.status, 'SUCCESS')
    assert.equal(child?.queueName, 'kei-extract')
    assert.equal(child?.priority, 1)
    assert.equal(child?.attributes?.keiRunId, document.runId)
    assert.equal(kei.submissions.length, 0)
  })
})

