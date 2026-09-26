import { beforeEach, describe, expect, it, vi } from 'vitest'

const registerWorkflow = vi.hoisted(() =>
  vi.fn<(workflow: unknown, config?: { name?: string }) => unknown>(
    (workflow) => workflow,
  ),
)

vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { registerWorkflow } }))

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
  })

  it('the extraction queue is Studio\'s studio queue', async () => {
    const [{ EXTRACTION_QUEUE }, { STUDIO_QUEUE }] = await Promise.all([
      import('extraction'),
      import('./dbos.js'),
    ])
    expect(EXTRACTION_QUEUE).toBe(STUDIO_QUEUE)
  })

  it('importing the application registers no workflow', async () => {
    await import('./app.js')

    expect(registerWorkflow).not.toHaveBeenCalled()
  })
})
