import { describe, expect, it, vi } from 'vitest'
import type { WorkflowSteps } from 'extraction/workflows'
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
  const readMarkdown = vi.fn(async (): Promise<string | null> => '# Source A')
  const propose = vi.fn(async () => PROPOSED) as unknown as SchemaEditPorts['propose']
  const generateJson = vi.fn(async () => ({ text: '{"fields":{},"additions":[]}' })) as unknown as SchemaEditPorts['generateJson']
  return { names, readSchemaTree, readMarkdown, propose, generateJson, ports: { steps, readSchemaTree, readMarkdown, propose, generateJson, ...overrides } as SchemaEditPorts }
}

describe('proposeSchemaEditWorkflow', () => {
  it('reads the base schema and the document outside the step and proposes in one step named proposeSchemaEdit', async () => {
    const { names, readSchemaTree, readMarkdown, propose, ports: p } = ports()
    let namesWhenProposed: string[] = ['unset']
    vi.mocked(propose).mockImplementation((async () => {
      namesWhenProposed = [...names]
      return PROPOSED
    }) as never)

    const result = await proposeSchemaEditWorkflow(input, p)

    expect(readSchemaTree).toHaveBeenCalledExactlyOnceWith(input.extractionSchemaId, input.baseSchemaRevisionId)
    expect(readMarkdown).toHaveBeenCalledExactlyOnceWith(input.sourceRepresentationRevisionId)
    expect(namesWhenProposed).toEqual(['proposeSchemaEdit'])
    expect(names).toEqual(['proposeSchemaEdit'])
    expect(result).toEqual({ ok: true, baseSchemaRevisionId: input.baseSchemaRevisionId, response: PROPOSED })
    const call = vi.mocked(propose).mock.calls[0]! as unknown as [unknown[], string, string | null, { caller: unknown }]
    expect(call[0]).toHaveLength(1)
    expect(call[1]).toBe('Rename title to heading')
    expect(call[2]).toBe('# Source A')
    expect(call[3].caller).toEqual({ researcherAccountId: OWNER })

    // A schema-only edit never reads a document and proposes over null.
    const schemaOnly = ports()
    await proposeSchemaEditWorkflow({ ...input, sourceRepresentationRevisionId: null }, schemaOnly.ports)
    expect(schemaOnly.readMarkdown).not.toHaveBeenCalled()
    const only = vi.mocked(schemaOnly.propose).mock.calls[0]! as unknown as [unknown, string, string | null]
    expect(only[2]).toBeNull()
  })

  it("each of the repair's model calls gets its own ten-minute limit", async () => {
    const { propose, generateJson, ports: p } = ports()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.mocked(propose).mockImplementation((async (_nodes: unknown, _instruction: string, _markdown: unknown, options: { generate(prompt: string, temperature?: number): Promise<string> }) => {
      await options.generate('first prompt', 0.3)
      await options.generate('repair prompt', 0.3)
      return PROPOSED
    }) as never)

    await proposeSchemaEditWorkflow({ ...input, temperature: 0.3 }, p)

    expect(timeout).toHaveBeenCalledTimes(2)
    expect(timeout).toHaveBeenNthCalledWith(1, 600_000)
    expect(timeout).toHaveBeenNthCalledWith(2, 600_000)
    const calls = vi.mocked(generateJson).mock.calls as unknown as [unknown, string, number | undefined, AbortSignal][]
    expect(calls.map((call) => call[0])).toEqual([{ researcherAccountId: OWNER }, { researcherAccountId: OWNER }])
    expect(calls.map((call) => call[1])).toEqual(['first prompt', 'repair prompt'])
    expect(calls[0]![3]).toBe(timeout.mock.results[0]!.value)
    expect(calls[1]![3]).toBe(timeout.mock.results[1]!.value)
    expect(calls[0]![3]).not.toBe(calls[1]![3])
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
    document.readMarkdown.mockRejectedValue(new Error('package unreadable'))
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
    noDocument.readMarkdown.mockResolvedValue(null)
    await expect(proposeSchemaEditWorkflow(input, noDocument.ports)).resolves.toMatchObject({ ok: false, status: 404 })
    expect(noDocument.names).toEqual([])
  })
})
