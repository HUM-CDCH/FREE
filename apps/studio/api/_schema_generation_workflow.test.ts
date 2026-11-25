import { describe, expect, it, vi } from 'vitest'
import type { SchemaSource } from 'db'
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
const SOURCE: SchemaSource = { markdown: '# Source A', pageSpans: [{ pageNumber: 1, start: 0, end: 10 }] }

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

function ports(overrides: Partial<SchemaGenerationPorts> = {}) {
  const { names, steps } = recordingSteps()
  const generated = { template: TEMPLATE, raw: JSON.stringify(TEMPLATE), pages: 2, sourceCoverage: { complete: true as const } }
  const generate = vi.fn(async () => generated) as unknown as SchemaGenerationPorts['generate']
  const readSource = vi.fn(async (): Promise<SchemaSource | null> => SOURCE)
  return { names, generate, readSource, ports: { steps, readSource, generate, ...overrides } as SchemaGenerationPorts }
}

describe('suggestSchemaWorkflow', () => {
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

  it("the step's output copies only the template, its field notes, the raw text, the page count, the source declaration and the base", async () => {
    const key = plantedKey()
    const { generate, ports: p } = ports()
    vi.mocked(generate).mockResolvedValue({
      template: TEMPLATE, raw: '{}', pages: null, sourceCoverage: { complete: true },
      providerMetadata: { synthetic: { marker: key } }, response: { headers: { 'x-echo': key } },
    } as never)

    const output = await suggestSchemaWorkflow(input, p)

    expect(Object.keys(output).sort()).toEqual(['baseSchemaRevisionId', 'fieldDescriptions', 'ok', 'pages', 'raw', 'sourceCoverage', 'template'])
    expect(holdsKey(output, key)).toBe(false)
  })

  it("keeps the suggestion's well-formed scalar field notes and drops malformed ones", async () => {
    const { generate, ports: p } = ports()
    vi.mocked(generate).mockResolvedValue({
      template: TEMPLATE, raw: '{}', pages: null, sourceCoverage: { complete: true },
      fieldDescriptions: [
        { path: ['title'], description: ' The entry heading. ' },
        { path: [], description: 'No path.' }, { path: ['title'], description: '  ' }, { path: ['title'] }, 'title',
      ],
    } as never)

    await expect(suggestSchemaWorkflow(input, p)).resolves.toMatchObject({
      ok: true, fieldDescriptions: [{ path: ['title'], description: 'The entry heading.' }],
    })
  })

  it('a document read that fails is a typed 503 persistence_unavailable and no step', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { names, generate, readSource, ports: p } = ports()
    readSource.mockRejectedValue(new Error('connection refused at 10.0.0.1'))

    const result = await suggestSchemaWorkflow(input, p)

    expect(result).toMatchObject({ ok: false, status: 503, code: 'persistence_unavailable' })
    expect((result as { message: string }).message).not.toContain('10.0.0.1')
    expect(names).toEqual([])
    expect(generate).not.toHaveBeenCalled()
  })

  it('a deleted revision ends with a typed 404 and no step', async () => {
    const { names, generate, readSource, ports: p } = ports()
    readSource.mockResolvedValue(null)

    await expect(suggestSchemaWorkflow(input, p)).resolves.toEqual({ ok: false, status: 404, code: 'not_found', message: 'Project model context was not found.' })
    expect(names).toEqual([])
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('suggestSchemaWorkflow, reading every window', () => {
  const paragraph = (i: number) => `Entry ${i}. ${'x'.repeat(3_000)}`
  const LONG = Array.from({ length: 40 }, (_, i) => paragraph(i)).join('\n\n')
  const windowTemplate = (markdown: string) => ({ _description: 'One entry.', [`from_${markdown.slice(0, 8).replace(/\W/g, '_')}`]: 'string' })

  /** Steps checkpointed by name, as DBOS replays them; `crashAt` throws before that step runs, like a lost process. */
  function checkpointedSteps(checkpoints: Map<string, unknown>, crashAt?: string) {
    const names: string[] = []
    const steps: WorkflowSteps = {
      step: async (name, run) => {
        names.push(name)
        if (checkpoints.has(name)) return checkpoints.get(name) as never
        if (name === crashAt) throw new Error('process lost')
        const output = await run()
        checkpoints.set(name, output)
        return output
      },
      cancelSignal: () => undefined,
    }
    return { names, steps }
  }

  function windowedPorts(steps: WorkflowSteps) {
    const generate = vi.fn(async (_caller: unknown, call: { document: { markdown: string }; instruction: string; window?: boolean }) => ({
      template: call.instruction === input.instruction ? windowTemplate(call.document.markdown) : { _description: 'One entry.', union: 'string' },
      raw: '{}', pages: null, sourceCoverage: { complete: true as const },
    }))
    return { generate, ports: { steps, readSource: async () => ({ markdown: LONG, pageSpans: [] }), generate } as unknown as SchemaGenerationPorts }
  }

  it('suggests from every window, combines them, and resumes after a lost process without repeating a window', async () => {
    const checkpoints = new Map<string, unknown>()
    const first = windowedPorts(checkpointedSteps(checkpoints, 'suggestWindow:2').steps)
    await expect(suggestSchemaWorkflow(input, first.ports)).rejects.toThrow('process lost')
    expect(first.generate).toHaveBeenCalledOnce()

    const replay = checkpointedSteps(checkpoints)
    const second = windowedPorts(replay.steps)
    const result = await suggestSchemaWorkflow(input, second.ports)

    const windowCalls = second.generate.mock.calls.filter(([, call]) => call.instruction === input.instruction)
    const firstWindow = first.generate.mock.calls[0]![1].document.markdown
    expect(firstWindow + windowCalls.map(([, call]) => call.document.markdown).join('')).toBe(LONG)
    expect(windowCalls.every(([, call]) => call.window === true)).toBe(true)
    expect(replay.names.filter((name) => name.startsWith('suggestWindow:'))).toEqual(['suggestWindow:1', 'suggestWindow:2', 'suggestWindow:3'])
    expect(replay.names.some((name) => name.startsWith('reduce:'))).toBe(true)
    expect(result).toEqual({
      ok: true, template: { _description: 'One entry.', union: 'string' }, fieldDescriptions: [],
      raw: JSON.stringify({ _description: 'One entry.', union: 'string' }),
      pages: null, sourceCoverage: { complete: true }, baseSchemaRevisionId: input.baseSchemaRevisionId,
    })
  })

  it('each window sends its field notes into the union, which returns the kept fields\' notes', async () => {
    const { steps } = checkpointedSteps(new Map())
    const generate = vi.fn(async (_caller: unknown, call: { document: { markdown: string }; instruction: string }) =>
      call.instruction === input.instruction
        ? { template: windowTemplate(call.document.markdown), raw: '{}', pages: null, sourceCoverage: { complete: true as const },
            fieldDescriptions: [{ path: [Object.keys(windowTemplate(call.document.markdown))[1]!], description: 'A window field.' }] }
        : { template: { _description: 'One entry.', union: 'string' }, raw: '{}', pages: null, sourceCoverage: { complete: true as const },
            fieldDescriptions: [{ path: ['union'], description: 'The combined field.' }] })
    const result = await suggestSchemaWorkflow(input, { steps, readSource: async () => ({ markdown: LONG, pageSpans: [] }), generate } as unknown as SchemaGenerationPorts)

    const unionText = generate.mock.calls.find(([, call]) => call.instruction !== input.instruction)![1].document.markdown
    expect(unionText).toContain('"fieldDescriptions":[{"path":["from_Entry_0_"],"description":"A window field."}]')
    expect(result).toMatchObject({ ok: true, fieldDescriptions: [{ path: ['union'], description: 'The combined field.' }] })
  })

  it('a combination recorded before suggestions returned notes replays as its template without notes', async () => {
    const checkpoints = new Map<string, unknown>()
    const first = windowedPorts(checkpointedSteps(checkpoints).steps)
    await suggestSchemaWorkflow(input, first.ports)
    const reduce = [...checkpoints.keys()].filter((name) => name.startsWith('reduce:'))
    expect(reduce.length).toBeGreaterThan(0)
    for (const name of reduce) checkpoints.set(name, { ok: true, value: { _description: 'One entry.', union: 'string' } })

    const replay = windowedPorts(checkpointedSteps(checkpoints).steps)
    const result = await suggestSchemaWorkflow(input, replay.ports)

    expect(replay.generate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, template: { _description: 'One entry.', union: 'string' }, fieldDescriptions: [] })
  })

  it('sends a fitting source whole in one call and no combination', async () => {
    const { names, steps } = checkpointedSteps(new Map())
    const { generate, ports: p } = windowedPorts(steps)
    const result = await suggestSchemaWorkflow(input, { ...p, readSource: async () => ({ markdown: '# Source A', pageSpans: [] }) })

    expect(generate).toHaveBeenCalledOnce()
    expect(names).toEqual(['suggestWindow:1'])
    expect(result).toMatchObject({ ok: true, template: windowTemplate('# Source A'), sourceCoverage: { complete: true } })
  })

  it('asks every window and every combination at the requested temperature', async () => {
    const { steps } = checkpointedSteps(new Map())
    const { generate, ports: p } = windowedPorts(steps)
    await suggestSchemaWorkflow({ ...input, temperature: 0.4 }, p)

    expect(generate.mock.calls.length).toBeGreaterThan(3)
    expect(generate.mock.calls.every(([, call]) => (call as { temperature?: number }).temperature === 0.4)).toBe(true)
  })

  it("asks every window with the researcher's instruction and combines them without it", async () => {
    // A document-scope exclusion ("exclude the bibliography") read again at the union drops per-entry fields (Bauer probe).
    const { steps } = checkpointedSteps(new Map())
    const { generate, ports: p } = windowedPorts(steps)
    await suggestSchemaWorkflow(input, p)

    const instructions = generate.mock.calls.map(([, call]) => call.instruction)
    expect(instructions.filter((instruction) => instruction === input.instruction)).toHaveLength(3)
    const unions = instructions.filter((instruction) => instruction !== input.instruction)
    expect(unions.length).toBeGreaterThan(0)
    expect(unions.every((instruction) => !instruction.includes(input.instruction))).toBe(true)
  })

  it('asks every window and every combination for the Record Scope chosen before it, and a Catalog union for one record', async () => {
    const { steps } = checkpointedSteps(new Map())
    const { generate, ports: p } = windowedPorts(steps)
    await suggestSchemaWorkflow({ ...input, recordScope: 'records' }, p)

    expect(generate.mock.calls.every(([, call]) => (call as { recordScope?: string }).recordScope === 'records')).toBe(true)
    const unions = generate.mock.calls.map(([, call]) => call.instruction).filter((instruction) => instruction !== input.instruction)
    expect(unions.every((instruction) => instruction.includes('one of the many records the document holds'))).toBe(true)
  })

  it('a failing window is the typed outcome, never thrown', async () => {
    const { steps } = checkpointedSteps(new Map())
    const { generate, ports: p } = windowedPorts(steps)
    generate.mockRejectedValueOnce(new ApiError(502, 'invalid_model_output', 'x'))
    await expect(suggestSchemaWorkflow(input, p)).resolves.toEqual({ ok: false, status: 502, code: 'invalid_model_output', message: 'x' })
  })
})
