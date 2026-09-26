import { beforeEach, describe, expect, it, vi } from 'vitest'

const registerWorkflow = vi.hoisted(() =>
  vi.fn<(workflow: unknown, config?: { name?: string }) => unknown>(
    (workflow) => workflow,
  ),
)

// Only registration is observed: the rest of the SDK (DBOSClient, which server/dbos.ts imports and server/app.ts reaches
// through it) stays real. DBOS's statics are not enumerable, so the stand-in inherits them instead of spreading them.
vi.mock('@dbos-inc/dbos-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dbos-inc/dbos-sdk')>()
  return { ...actual, DBOS: Object.assign(Object.create(actual.DBOS) as typeof actual.DBOS, { registerWorkflow }) }
})

beforeEach(() => {
  vi.resetModules()
  registerWorkflow.mockClear()
})

describe('Studio workflow registration', () => {
  it('registers every Studio workflow once, each under its explicit name', async () => {
    const { registerStudioWorkflows, STUDIO_WORKFLOW_NAMES } = await import(
      './workflows.js'
    )

    registerStudioWorkflows()
    registerStudioWorkflows()

    expect(registerWorkflow).toHaveBeenCalledTimes(STUDIO_WORKFLOW_NAMES.length)
    const names = registerWorkflow.mock.calls.map(([, config]) => config?.name)
    for (const name of names) expect(name).toEqual(expect.any(String))
    expect(names).toEqual([...STUDIO_WORKFLOW_NAMES])
    expect(names).toEqual(['runExtraction', 'suggestSchemaBatch', 'ingestSource', 'reprocessSource', 'suggestSchema', 'proposeSchemaEdit'])
  })

  it('the extraction queue is Studio\'s studio queue', async () => {
    const [{ EXTRACTION_QUEUE }, { STUDIO_QUEUE }] = await Promise.all([
      import('extraction'),
      import('./dbos.js'),
    ])
    expect(EXTRACTION_QUEUE).toBe(STUDIO_QUEUE)
  })

  it('packages/db admits batch suggestion attempts under the registered workflow\'s name, on Studio\'s suggest queue', async () => {
    const [{ SUGGEST_SCHEMA_BATCH_NAME, SUGGEST_QUEUE_NAME }, { SUGGEST_SCHEMA_BATCH }, { SUGGEST_QUEUE }] =
      await Promise.all([import('db'), import('../api/_batch_suggestion_workflow.js'), import('./dbos.js')])
    expect(SUGGEST_SCHEMA_BATCH_NAME).toBe(SUGGEST_SCHEMA_BATCH)
    expect(SUGGEST_QUEUE_NAME).toBe(SUGGEST_QUEUE)
  })

  it('importing the application registers no workflow', async () => {
    await import('./app.js')

    expect(registerWorkflow).not.toHaveBeenCalled()
  })
})
