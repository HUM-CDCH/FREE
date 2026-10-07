import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runWorkflowChild } from '../test/support/crash.js'
import { disposableDatabaseUrl, dropSchemas, testSchemas } from '../test/support/postgres.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos, type StudioDbos } from './dbos.js'

const url = disposableDatabaseUrl()
// This process launches DBOS on `schemas`; the crash children get schemas of their own, so this process's queue
// runner never dequeues a workflow only the children register.
const schemas = testSchemas()
const childSchemas = testSchemas()
const scratch = mkdtempSync(join(tmpdir(), 'free-studio-dbos-'))

async function clockMs(): Promise<number> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ ms: string }>(
      'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms',
    )
    return Number(rows[0]!.ms)
  } finally {
    await client.end()
  }
}

let before: number
let launched: StudioDbos
let after: number

beforeAll(async () => {
  before = await clockMs()
  launched = await launchStudioDbos({ databaseUrl: url, ...schemas, register: () => undefined })
  after = await clockMs()
})

afterAll(async () => {
  await shutdownStudioDbos()
  await dropSchemas(url, schemas.schema, schemas.keiSchema, childSchemas.schema, childSchemas.keiSchema)
  rmSync(scratch, { recursive: true, force: true })
})

describe('Studio DBOS on PostgreSQL', () => {
  it('launch creates its own schema and stores the studio queue with a 100 ms polling floor and suggest with one global slot', async () => {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      const { rows } = await client.query<{ schema_name: string }>(
        'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
        [schemas.schema],
      )
      expect(rows).toEqual([{ schema_name: schemas.schema }])
    } finally {
      await client.end()
    }

    const studio = await studioDbos().admission.retrieveQueue('studio')
    expect(studio!.minPollingIntervalMs).toBe(100)
    const suggest = await studioDbos().admission.retrieveQueue('suggest')
    expect(suggest!.concurrency).toBe(1)
  })

  it('the boot timestamp is the database clock taken before launch', () => {
    expect(launched.bootTimestampMs).toBeGreaterThanOrEqual(before)
    expect(launched.bootTimestampMs).toBeLessThanOrEqual(after)
  })

  it('a workflow killed mid-step recovers on the next launch with the same executor and version, without re-running finished steps', async () => {
    const file = join(scratch, 'lifecycle-steps.txt')
    const env = {
      DATABASE_URL: url,
      FREE_TEST_DBOS_SCHEMA: childSchemas.schema,
      FREE_TEST_KEI_SCHEMA: childSchemas.keiSchema,
      FREE_TEST_EXECUTOR: childSchemas.executorId,
      FREE_CRASH_MARKER: join(scratch, 'lifecycle-marker'),
      FREE_TEST_LIFECYCLE_FILE: file,
    }

    const killed = await runWorkflowChild('lifecycle', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    const recovered = await runWorkflowChild('lifecycle', env)
    expect(recovered.code, recovered.output).toBe(0)

    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual([
      'a',
      'b-start',
      'b-start',
      'b-end',
      'c',
    ])
  })
})
