import { describe, expect, it, vi } from 'vitest'
import type { SchemaSource } from 'db'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import { ApiError } from './_http.js'
import { answerSchemaChatWorkflow, type SchemaChatInput, type SchemaChatPorts } from './_schema_chat_workflow.js'

const OWNER = '51000000-0000-4000-8009-00000000000a'
const input: SchemaChatInput = {
  operationId: '51000000-0000-4000-8009-0000000000f2',
  owner: OWNER,
  projectContextId: '51000000-0000-4000-8000-000000000001',
  sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
  message: 'How many burials are there?',
  history: [{ role: 'user', text: 'What is this register?' }, { role: 'assistant', text: 'A burial register.' }],
  temperature: null,
}
const SOURCE: SchemaSource = { markdown: '# Register\n\n42 burials.', pageSpans: [] }
const LONG: SchemaSource = { markdown: `${'a'.repeat(40_000)}\n\n${'b'.repeat(40_000)}`, pageSpans: [] }

function ports(overrides: Partial<SchemaChatPorts> = {}) {
  const names: string[] = []
  const steps: WorkflowSteps = {
    step: async (name, run) => {
      names.push(name)
      return run()
    },
    cancelSignal: () => undefined,
  }
  const readSource = vi.fn(async (): Promise<SchemaSource | null> => SOURCE)
  const answer = vi.fn(async (): Promise<string | null> => '42 burials.')
  const answerWindow = vi.fn(async (_caller: unknown, window: { index: number }) => `part ${window.index}`)
  const combineAnswers = vi.fn(async (_caller: unknown, answers: readonly string[]) => answers.join(' + '))
  return {
    names, readSource, answer, answerWindow, combineAnswers,
    ports: { steps, readSource, answer, answerWindow, combineAnswers, ...overrides } as unknown as SchemaChatPorts,
  }
}

describe('answerSchemaChatWorkflow', () => {
  it('a question over a short source is answered in one step, from the source read outside it', async () => {
    const { names, readSource, answer, ports: p } = ports()

    await expect(answerSchemaChatWorkflow(input, p)).resolves.toEqual({ ok: true, reply: { kind: 'answer', answer: '42 burials.' } })

    expect(readSource).toHaveBeenCalledExactlyOnceWith(input.sourceRepresentationRevisionId)
    expect(names).toEqual(['answerIfQuestion'])
    expect(answer.mock.calls[0]!.slice(0, 3)).toEqual([{ researcherAccountId: OWNER }, SOURCE, { message: input.message, history: input.history }])
  })

  it('an instruction is the reply `instruction`, and nothing else runs', async () => {
    const { names, answer, ports: p } = ports()
    answer.mockResolvedValue(null)
    await expect(answerSchemaChatWorkflow(input, p)).resolves.toEqual({ ok: true, reply: { kind: 'instruction' } })
    expect(names).toEqual(['answerIfQuestion'])
  })

  it('a long source\'s question is answered again from every window, then combined', async () => {
    const { names, ports: p } = ports({ readSource: async () => LONG })
    await expect(answerSchemaChatWorkflow({ ...input, temperature: 0.3 }, p)).resolves.toEqual({
      ok: true, reply: { kind: 'answer', answer: 'part 1 + part 2' },
    })
    expect(names).toEqual(['answerIfQuestion', 'answerWindow:1', 'answerWindow:2', 'combineAnswers'])
  })

  it('a failed model step is a typed failure; a missing or unreadable source runs no step', async () => {
    const failing = ports()
    failing.answer.mockRejectedValue(new ApiError(409, 'invalid_model_config', 'No model.'))
    await expect(answerSchemaChatWorkflow(input, failing.ports)).resolves.toEqual({ ok: false, status: 409, code: 'invalid_model_config', message: 'No model.' })

    const missing = ports({ readSource: async () => null })
    await expect(answerSchemaChatWorkflow(input, missing.ports)).resolves.toMatchObject({ ok: false, status: 404 })
    expect(missing.names).toEqual([])

    vi.spyOn(console, 'error').mockImplementation(() => {})
    const unreadable = ports({ readSource: async () => { throw new Error('package unreadable') } })
    await expect(answerSchemaChatWorkflow(input, unreadable.ports)).resolves.toMatchObject({ ok: false, status: 503, code: 'persistence_unavailable' })
  })
})
