// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ResultCorrectionProposal } from '../shared/resultCorrection.contract'
import { NO_RESULTS_REPLY, useResultCorrections, type CorrectionTarget } from './useResultCorrections'

const { requestResultCorrections, deleteModelOperation, durableRequest } = vi.hoisted(() => ({
  requestResultCorrections: vi.fn(), deleteModelOperation: vi.fn(async () => {}), durableRequest: vi.fn(async () => ({})),
}))
vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), requestResultCorrections, deleteModelOperation }))
vi.mock('./durableExtractionApi', async (importOriginal) => ({ ...await importOriginal<typeof import('./durableExtractionApi')>(), durableRequest }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const TARGET: CorrectionTarget = { extractionId: 'extraction-1', snapshotVersion: null }
const PROPOSAL: ResultCorrectionProposal = {
  extractionId: 'extraction-1', snapshotVersion: 3, reply: 'Record 3 changed.', dropped: [],
  corrections: [
    { valueId: 'v/year', label: 'Record 3 · year', action: 'EDITED', current: 1845, value: 1854, expectedRevision: 0, reason: null },
    { valueId: 'v-name', label: 'Record 3 · name', action: 'REJECTED', current: 'Ane', expectedRevision: 2, reason: null },
  ],
}

function setup(target: CorrectionTarget | null = TARGET) {
  const say = vi.fn()
  const onSaved = vi.fn()
  const hook = renderHook((props: { target: CorrectionTarget | null }) => useResultCorrections({ target: props.target, say, onSaved }), { initialProps: { target } })
  return { hook, say, onSaved }
}

it('hands a template change on with the conversation through the request, after the changes it can make now', async () => {
  const say = vi.fn(), onTemplateChange = vi.fn()
  const hook = renderHook(() => useResultCorrections({ target: TARGET, say, onSaved: vi.fn(), onTemplateChange }))
  const history = [{ role: 'assistant' as const, text: 'Results ready.' }]
  requestResultCorrections.mockResolvedValueOnce({ ...PROPOSAL, corrections: [], reply: null, templateChange: 'Add a field "parish" (text).' })
  await act(() => hook.result.current.propose('Add the parish', history))
  expect(hook.result.current.pending).toBeNull()
  expect(say).not.toHaveBeenCalled()
  expect(onTemplateChange).toHaveBeenCalledExactlyOnceWith('Add a field "parish" (text).', [...history, { role: 'user', text: 'Add the parish' }])
  // Changes it can make now still wait for the researcher beside it.
  requestResultCorrections.mockResolvedValueOnce({ ...PROPOSAL, templateChange: 'Add a field "parish" (text).' })
  await act(() => hook.result.current.propose('Record 3 is 1854, and add the parish', []))
  expect(hook.result.current.pending?.proposal.corrections).toHaveLength(2)
  expect(onTemplateChange).toHaveBeenCalledTimes(2)
})

it('says the reply when there are no changes and nothing to hand on', async () => {
  const say = vi.fn()
  const hook = renderHook(() => useResultCorrections({ target: TARGET, say, onSaved: vi.fn(), onTemplateChange: vi.fn() }))
  requestResultCorrections.mockResolvedValueOnce({ ...PROPOSAL, corrections: [], reply: 'Which record?', templateChange: null })
  await act(() => hook.result.current.propose('fix it', []))
  expect(say).toHaveBeenCalledExactlyOnceWith('Which record?')
})

it('holds a proposal for the result shown, with what the model said', async () => {
  requestResultCorrections.mockResolvedValueOnce(PROPOSAL)
  const { hook, say } = setup()
  const history = [{ role: 'user' as const, text: 'Run it' }]
  await act(() => hook.result.current.propose('The year of record 3 is 1854', history))
  expect(requestResultCorrections.mock.calls[0]!.slice(0, 2)).toEqual([TARGET, 'The year of record 3 is 1854'])
  expect(requestResultCorrections.mock.calls[0]![4]).toEqual(history)
  expect(hook.result.current.pending).toEqual({ request: 1, proposal: PROPOSAL })
  expect(say).toHaveBeenCalledExactlyOnceWith('Record 3 changed.')
})

it('says what the model said, and what it left out, when it proposes nothing', async () => {
  requestResultCorrections.mockResolvedValueOnce({ ...PROPOSAL, corrections: [], reply: 'Which record?', dropped: ['A change to "v9", which is not a listed value.'] })
  const { hook, say } = setup()
  await act(() => hook.result.current.propose('fix it', []))
  expect(hook.result.current.pending).toBeNull()
  expect(say).toHaveBeenCalledExactlyOnceWith('Which record?\n\nLeft out: A change to "v9", which is not a listed value.')
})

it('says there is nothing to change without a result, and asks for nothing', async () => {
  const { hook, say } = setup(null)
  await act(() => hook.result.current.propose('fix it', []))
  expect(requestResultCorrections).not.toHaveBeenCalled()
  expect(say).toHaveBeenCalledExactlyOnceWith(NO_RESULTS_REPLY)
})

it('saves each change as Results saves a correction, unincluded and without Evidence, and reads the result again', async () => {
  requestResultCorrections.mockResolvedValueOnce(PROPOSAL)
  const { hook, say, onSaved } = setup()
  await act(() => hook.result.current.propose('fix record 3', []))
  await act(() => hook.result.current.save())
  expect(durableRequest.mock.calls).toEqual([
    ['/api/extractions/extraction-1/durable/values/v%2Fyear', { expectedRevision: 0, snapshotVersion: 3, action: 'EDITED', value: 1854, evidence: [], included: false }],
    ['/api/extractions/extraction-1/durable/values/v-name', { expectedRevision: 2, snapshotVersion: 3, action: 'REJECTED', evidence: [], included: false }],
  ])
  expect(onSaved).toHaveBeenCalledOnce()
  expect(hook.result.current.pending).toBeNull()
  expect(say).toHaveBeenLastCalledWith('Saved 2 changes to the results.')
})

it('says which changes a newer correction overtook, and keeps the others saved', async () => {
  requestResultCorrections.mockResolvedValueOnce(PROPOSAL)
  durableRequest.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Another view saved a newer correction.'))
  const { hook, say, onSaved } = setup()
  await act(() => hook.result.current.propose('fix record 3', []))
  await act(() => hook.result.current.save())
  expect(onSaved).toHaveBeenCalledOnce()
  expect(say).toHaveBeenLastCalledWith('Saved 1 of 2 changes. Not saved: Record 3 · name: Another view saved a newer correction.')
})

it('drops a proposal once another Extraction is shown', async () => {
  requestResultCorrections.mockResolvedValueOnce(PROPOSAL)
  const { hook } = setup()
  await act(() => hook.result.current.propose('fix record 3', []))
  hook.rerender({ target: { extractionId: 'extraction-2', snapshotVersion: null } })
  expect(hook.result.current.pending).toBeNull()
})

it('stops a proposal being asked for, on the server too', async () => {
  requestResultCorrections.mockImplementationOnce((_target, _message, signal: AbortSignal) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
  const { hook, say } = setup()
  let proposing!: Promise<void>
  act(() => { proposing = hook.result.current.propose('fix record 3', []) })
  expect(hook.result.current.busy).toBe('proposing')
  await act(async () => { hook.result.current.stop(); await proposing })
  expect(deleteModelOperation).toHaveBeenCalledWith(`correct:${requestResultCorrections.mock.calls[0]![3]}`)
  expect(hook.result.current.busy).toBeNull()
  expect(say).not.toHaveBeenCalled()
})
