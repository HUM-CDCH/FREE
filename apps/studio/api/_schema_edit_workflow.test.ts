import { describe, expect, it, vi } from 'vitest'
import type { SchemaSource } from 'db'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import { ApiError } from './_http.js'
import { ModelKeyRequiredError } from './_model_keys.js'
import { proposeSchemaEditWorkflow, type SchemaEditInput, type SchemaEditPorts } from './_schema_edit_workflow.js'

const OWNER = '51000000-0000-4000-8009-00000000000a'
const input: SchemaEditInput = {
  operationId: '51000000-0000-4000-8009-0000000000f1',
  owner: OWNER,
  projectContextId: '51000000-0000-4000-8000-000000000001',
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  baseSchemaRevisionId: '51000000-0000-4000-8004-000000000001',
  sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
  instruction: 'Rename title to heading',
  temperature: null,
}
const TREE = { recordDescription: 'One report.', schemaNodes: [{ id: 'n1', name: 'title', type: 'string', description: 'The title' }] }
const SOURCE: SchemaSource = { markdown: '# Source A', pageSpans: [] }
const PROPOSED = { status: 'proposed' as const, fields: {}, additions: [], issues: [] }

function recordingSteps() {
  const names: string[] = []
  const steps: WorkflowSteps = {
    step: async (name, run) => {
      names.push(name)
      return run()
    },
    cancelSignal: () => undefined,
  }
  return { names, steps }
}

function ports(overrides: Partial<SchemaEditPorts> = {}) {
  const { names, steps } = recordingSteps()
  const readSchemaTree = vi.fn(async (): Promise<unknown | null> => TREE)
  const readSource = vi.fn(async (): Promise<SchemaSource | null> => SOURCE)
  const propose = vi.fn(async () => PROPOSED) as unknown as SchemaEditPorts['propose']
  const generate = vi.fn() as unknown as SchemaEditPorts['generate']
  return { names, readSchemaTree, readSource, propose, generate, ports: { steps, readSchemaTree, readSource, propose, generate, ...overrides } as SchemaEditPorts }
}

describe('proposeSchemaEditWorkflow', () => {
  it('reads the base schema and the document outside the step and proposes in one step named proposeSchemaEdit', async () => {
    const { names, readSchemaTree, readSource, propose, generate, ports: p } = ports()
    let namesWhenProposed: string[] = ['unset']
    vi.mocked(propose).mockImplementation((async () => {
      namesWhenProposed = [...names]
      return PROPOSED
    }) as never)

    const result = await proposeSchemaEditWorkflow(input, p)

    expect(readSchemaTree).toHaveBeenCalledExactlyOnceWith(input.extractionSchemaId, input.baseSchemaRevisionId)
    expect(readSource).toHaveBeenCalledExactlyOnceWith(input.sourceRepresentationRevisionId)
    expect(namesWhenProposed).toEqual(['proposeSchemaEdit'])
    expect(names).toEqual(['proposeSchemaEdit'])
    expect(result).toEqual({ ok: true, baseSchemaRevisionId: input.baseSchemaRevisionId, response: PROPOSED })
    const call = vi.mocked(propose).mock.calls[0]! as unknown as [{ schemaNodes: unknown[] }, string, SchemaSource | null, { caller: unknown; generate: unknown }]
    expect(call[0]).toMatchObject({ recordDescription: 'One report.' })
    expect(call[0].schemaNodes).toHaveLength(1)
    expect(call[1]).toBe('Rename title to heading')
    expect(call[2]).toEqual(SOURCE)
    expect(call[3].caller).toEqual({ researcherAccountId: OWNER })
    expect(call[3].generate).toBe(generate)

    // A schema-only edit never reads a document and proposes over null.
    const schemaOnly = ports()
    await proposeSchemaEditWorkflow({ ...input, sourceRepresentationRevisionId: null }, schemaOnly.ports)
    expect(schemaOnly.readSource).not.toHaveBeenCalled()
    const only = vi.mocked(schemaOnly.propose).mock.calls[0]! as unknown as [unknown, string, SchemaSource | null]
    expect(only[2]).toBeNull()
  })

  it('the model call gets a ten-minute limit and the temperature', async () => {
    const { propose, ports: p } = ports()
    const timeout = vi.spyOn(AbortSignal, 'timeout')

    await proposeSchemaEditWorkflow({ ...input, temperature: 0.3 }, p)

    expect(timeout).toHaveBeenCalledExactlyOnceWith(600_000)
    const options = (vi.mocked(propose).mock.calls[0]! as unknown as [unknown, string, unknown, { signal: AbortSignal; temperature?: number }])[3]
    expect(options.signal).toBe(timeout.mock.results[0]!.value)
    expect(options.temperature).toBe(0.3)
  })

  it('a refused or failed proposal is a successful operation carrying that response; an ApiError is a typed failure', async () => {
    const refused = ports()
    vi.mocked(refused.propose).mockResolvedValue({ status: 'refused', message: 'Duplicate field paths: a' } as never)
    await expect(proposeSchemaEditWorkflow(input, refused.ports)).resolves.toEqual({
      ok: true, baseSchemaRevisionId: input.baseSchemaRevisionId, response: { status: 'refused', message: 'Duplicate field paths: a' },
    })
    const failed = ports()
    vi.mocked(failed.propose).mockResolvedValue({ status: 'failed', message: 'Schema edit generation failed.' } as never)
    await expect(proposeSchemaEditWorkflow(input, failed.ports)).resolves.toMatchObject({ ok: true, response: { status: 'failed' } })

    const keyless = ports()
    vi.mocked(keyless.propose).mockRejectedValue(new ModelKeyRequiredError())
    await expect(proposeSchemaEditWorkflow(input, keyless.ports)).resolves.toMatchObject({ ok: false, status: 409, code: 'model_key_required' })
    const misconfigured = ports()
    vi.mocked(misconfigured.propose).mockRejectedValue(new ApiError(409, 'invalid_model_config', 'No model.'))
    await expect(proposeSchemaEditWorkflow(input, misconfigured.ports)).resolves.toEqual({ ok: false, status: 409, code: 'invalid_model_config', message: 'No model.' })
  })

  it('a base or document read that fails is a typed 503 persistence_unavailable and no step', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const tree = ports()
    tree.readSchemaTree.mockRejectedValue(new Error('connection refused at 10.0.0.1'))
    const result = await proposeSchemaEditWorkflow(input, tree.ports)
    expect(result).toMatchObject({ ok: false, status: 503, code: 'persistence_unavailable' })
    expect((result as { message: string }).message).not.toContain('10.0.0.1')
    expect(tree.names).toEqual([])
    expect(tree.propose).not.toHaveBeenCalled()

    const document = ports()
    document.readSource.mockRejectedValue(new Error('package unreadable'))
    await expect(proposeSchemaEditWorkflow(input, document.ports)).resolves.toMatchObject({ ok: false, status: 503, code: 'persistence_unavailable' })
    expect(document.names).toEqual([])
  })

  it('a deleted base revision or document ends with a typed 404 and no step', async () => {
    const noTree = ports()
    noTree.readSchemaTree.mockResolvedValue(null)
    await expect(proposeSchemaEditWorkflow(input, noTree.ports)).resolves.toEqual({ ok: false, status: 404, code: 'not_found', message: 'Project model context was not found.' })
    expect(noTree.names).toEqual([])
    expect(noTree.propose).not.toHaveBeenCalled()

    const noDocument = ports()
    noDocument.readSource.mockResolvedValue(null)
    await expect(proposeSchemaEditWorkflow(input, noDocument.ports)).resolves.toMatchObject({ ok: false, status: 404 })
    expect(noDocument.names).toEqual([])
  })
})
