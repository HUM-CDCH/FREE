import { describe, expect, it, vi } from 'vitest'
import { DurableNotFound } from 'extraction/durable'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import { ApiError } from './_http.js'
import type { ResultToCorrect } from './_result_correction.js'
import { proposeResultCorrectionsWorkflow, type ResultCorrectionInput, type ResultCorrectionPorts } from './_result_correction_workflow.js'
import type { ResultCorrectionProposal } from '../shared/resultCorrection.contract.js'

const OWNER = '51000000-0000-4000-8009-00000000000a'
const EXTRACTION = '51000000-0000-4000-8006-000000000001'
const input: ResultCorrectionInput = {
  operationId: '51000000-0000-4000-8009-0000000000f3',
  owner: OWNER,
  extractionId: EXTRACTION,
  snapshotVersion: 3,
  feedbackVersion: 7,
  message: 'The year of record 3 should be 1854',
  history: [{ role: 'user', text: 'Run it' }],
  temperature: null,
}
const RESULT: ResultToCorrect = { extractionId: EXTRACTION, snapshotVersion: 3, values: [], markdown: '# Register' }
const PROPOSAL: ResultCorrectionProposal = { extractionId: EXTRACTION, snapshotVersion: 3, corrections: [], reply: 'Which record?', dropped: [] }

function ports(overrides: Partial<ResultCorrectionPorts> = {}) {
  const names: string[] = []
  const steps: WorkflowSteps = { step: async (name, run) => { names.push(name); return run() }, cancelSignal: () => undefined }
  const readResult = vi.fn(async () => RESULT)
  const propose = vi.fn(async () => PROPOSAL)
  return { names, readResult, propose, ports: { steps, readResult, propose, ...overrides } as unknown as ResultCorrectionPorts }
}

describe('proposeResultCorrectionsWorkflow', () => {
  it('reads the pinned result outside any step, then asks for the changes in one step', async () => {
    const { names, readResult, propose, ports: p } = ports()
    await expect(proposeResultCorrectionsWorkflow(input, p)).resolves.toEqual({ ok: true, proposal: PROPOSAL })
    expect(readResult).toHaveBeenCalledExactlyOnceWith(input)
    expect(names).toEqual(['proposeCorrections'])
    expect((propose.mock.calls[0] as unknown[]).slice(0, 3))
      .toEqual([{ researcherAccountId: OWNER }, RESULT, { message: input.message, history: input.history, view: null }])
    // Where the message was said goes with it (ADR 0043).
    const said = ports()
    await proposeResultCorrectionsWorkflow({ ...input, view: 'template' }, said.ports)
    expect((said.propose.mock.calls[0] as unknown[])[2]).toMatchObject({ view: 'template' })
  })

  it('a result the researcher cannot read is not found, and no model is asked', async () => {
    const { names, ports: p } = ports({ readResult: vi.fn(async () => { throw new DurableNotFound('That Extraction was not found.') }) })
    await expect(proposeResultCorrectionsWorkflow(input, p))
      .resolves.toEqual({ ok: false, status: 404, code: 'not_found', message: 'That Extraction was not found.' })
    expect(names).toEqual([])
  })

  it('a failed model call is the operation\'s typed failure', async () => {
    const { ports: p } = ports({ propose: vi.fn(async () => { throw new ApiError(409, 'invalid_model_config', 'No Assistant model is configured to change results.') }) })
    await expect(proposeResultCorrectionsWorkflow(input, p)).resolves.toEqual({
      ok: false, status: 409, code: 'invalid_model_config', message: 'No Assistant model is configured to change results.',
    })
  })
})
