import { describe, expect, it, vi } from 'vitest'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import { holdsKey, plantedKey } from '../test/support/plantedKey.js'
import { ApiError } from './_http.js'
import { ModelKeyRequiredError } from './_model_keys.js'
import { suggestSchemaWorkflow, type SchemaGenerationInput, type SchemaGenerationPorts } from './_schema_generation_workflow.js'

const OWNER = '51000000-0000-4000-8009-00000000000a'
const input: SchemaGenerationInput = {
  operationId: '51000000-0000-4000-8009-0000000000f1',
  owner: OWNER,
  projectContextId: '51000000-0000-4000-8000-000000000001',
  sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  baseSchemaRevisionId: '51000000-0000-4000-8004-000000000001',
  instruction: 'Catalog entries',
  temperature: null,
}
const TEMPLATE = { _description: 'One entry.', title: 'string' }

/** Steps that run at once and record their names, so the test sees what ran inside a step. */
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

const EXCERPTED = { complete: false as const, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] }

function ports(overrides: Partial<SchemaGenerationPorts> = {}) {
  const { names, steps } = recordingSteps()
  const generated = { template: TEMPLATE, raw: JSON.stringify(TEMPLATE), pages: 2, sourceCoverage: EXCERPTED }
  const generate = vi.fn(async () => generated) as unknown as SchemaGenerationPorts['generate']
  const readMarkdown = vi.fn(async (): Promise<string | null> => '# Source A')
  return { names, generate, readMarkdown, ports: { steps, readMarkdown, generate, ...overrides } as SchemaGenerationPorts }
}

describe('suggestSchemaWorkflow', () => {
  it('reads the document outside the step, generates in one step named generateSchema, and returns the template with its base', async () => {
    const { names, generate, readMarkdown, ports: p } = ports()
    let namesWhenRead: string[] = ['unset']
    readMarkdown.mockImplementation(async () => {
      namesWhenRead = [...names]
      return '# Source A'
    })
    let namesWhenGenerated: string[] = ['unset']
    vi.mocked(generate).mockImplementation((async () => {
      namesWhenGenerated = [...names]
      return { template: TEMPLATE, raw: JSON.stringify(TEMPLATE), pages: 2, sourceCoverage: EXCERPTED }
    }) as never)

    const result = await suggestSchemaWorkflow(input, p)

    expect(readMarkdown).toHaveBeenCalledExactlyOnceWith(input.sourceRepresentationRevisionId)
    expect(namesWhenRead).toEqual([])
    expect(namesWhenGenerated).toEqual(['generateSchema'])
    expect(names).toEqual(['generateSchema'])
    // The declaration of what the model did not read is part of the persisted outcome.
    expect(result).toEqual({ ok: true, template: TEMPLATE, raw: JSON.stringify(TEMPLATE), pages: 2, sourceCoverage: EXCERPTED, baseSchemaRevisionId: input.baseSchemaRevisionId })
    expect(generate).toHaveBeenCalledExactlyOnceWith(
      { researcherAccountId: OWNER },
      expect.objectContaining({ document: { file: null, pages: null, markdown: '# Source A' }, instruction: 'Catalog entries' }),
    )
  })

  it("every call resolves the owner's account and gets a ten-minute signal", async () => {
    const { generate, ports: p } = ports()
    const timeout = vi.spyOn(AbortSignal, 'timeout')

    await suggestSchemaWorkflow({ ...input, temperature: 0.4 }, p)

    expect(timeout).toHaveBeenCalledExactlyOnceWith(600_000)
    const call = vi.mocked(generate).mock.calls[0]! as unknown as [unknown, { signal?: AbortSignal; temperature?: number }]
    expect(call[0]).toEqual({ researcherAccountId: OWNER })
    expect(call[1].signal).toBe(timeout.mock.results[0]!.value)
    expect(call[1].temperature).toBe(0.4)
  })

  it('an expected failure is returned as a typed result, never thrown', async () => {
    const invalid = ports()
    vi.mocked(invalid.generate).mockRejectedValue(new ApiError(502, 'invalid_model_output', 'x'))
    await expect(suggestSchemaWorkflow(input, invalid.ports)).resolves.toEqual({ ok: false, status: 502, code: 'invalid_model_output', message: 'x' })

    const keyless = ports()
    vi.mocked(keyless.generate).mockRejectedValue(new ModelKeyRequiredError())
    await expect(suggestSchemaWorkflow(input, keyless.ports)).resolves.toMatchObject({ ok: false, status: 409, code: 'model_key_required' })
  })

  it("the step's output copies only the template, the raw text, the page count, the source declaration and the base", async () => {
    const key = plantedKey()
    const { generate, ports: p } = ports()
    vi.mocked(generate).mockResolvedValue({
      template: TEMPLATE, raw: '{}', pages: null, sourceCoverage: { complete: true },
      providerMetadata: { synthetic: { marker: key } }, response: { headers: { 'x-echo': key } },
    } as never)

    const output = await suggestSchemaWorkflow(input, p)

    expect(Object.keys(output).sort()).toEqual(['baseSchemaRevisionId', 'ok', 'pages', 'raw', 'sourceCoverage', 'template'])
    expect(holdsKey(output, key)).toBe(false)
  })

  it('a document read that fails is a typed 503 persistence_unavailable and no step', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { names, generate, readMarkdown, ports: p } = ports()
    readMarkdown.mockRejectedValue(new Error('connection refused at 10.0.0.1'))

    const result = await suggestSchemaWorkflow(input, p)

    expect(result).toMatchObject({ ok: false, status: 503, code: 'persistence_unavailable' })
    expect((result as { message: string }).message).not.toContain('10.0.0.1')
    expect(names).toEqual([])
    expect(generate).not.toHaveBeenCalled()
  })

  it('a deleted revision ends with a typed 404 and no step', async () => {
    const { names, generate, readMarkdown, ports: p } = ports()
    readMarkdown.mockResolvedValue(null)

    await expect(suggestSchemaWorkflow(input, p)).resolves.toEqual({ ok: false, status: 404, code: 'not_found', message: 'Project model context was not found.' })
    expect(names).toEqual([])
    expect(generate).not.toHaveBeenCalled()
  })
})
