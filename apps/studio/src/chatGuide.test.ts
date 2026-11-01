import { describe, expect, it } from 'vitest'
import { nextStep, type GuideInput } from './chatGuide'

const base: GuideInput = {
  view: 'editing',
  generationError: null,
  readOnly: false,
  canGenerate: true,
  asking: false,
  instructionCount: 0,
  sourceDocumentName: 'letters.pdf',
  proposal: null,
  recordScope: 'records',
  revision: { id: 'revision-2', number: 2, fieldCount: 6 },
  run: { unavailableReason: null, available: true },
  control: { busy: false, continueBlocked: null, continueDescription: 'Continue with its saved inputs.', pauseDescription: 'Pause.' },
  latest: null,
  resultsShown: false,
  dismissed: new Set(),
}
const latest = (status: NonNullable<GuideInput['latest']>['status'], schemaRevisionId = 'revision-2') =>
  ({ extractionId: 'extraction-1', schemaRevisionId, status, progress: 'Reading records · 3 of 14', toCheck: 2 })
const actions = (input: Partial<GuideInput>) => nextStep({ ...base, ...input })?.options.map(({ action }) => action)

describe('nextStep', () => {
  it('offers Generate schema before the first schema, counting the kept instructions', () => {
    const step = nextStep({ ...base, view: 'empty', instructionCount: 2 })
    expect(step?.options[0]).toMatchObject({ action: 'generate', label: 'Generate schema (2 messages)', tone: 'positive' })
    expect(step?.options.map(({ action }) => action)).toEqual(['generate', 'dismiss'])
  })

  it('holds Generate while a question is answered, and shows a failed generation\'s error', () => {
    expect(nextStep({ ...base, view: 'empty', asking: true })?.options[0]?.disabled).toBe(true)
    expect(nextStep({ ...base, view: 'failed', generationError: 'The model refused.' })?.error).toBe('The model refused.')
    expect(nextStep({ ...base, view: 'empty', canGenerate: false })).toBeNull()
  })

  it('follows a generation with its Stop', () => {
    expect(nextStep({ ...base, view: 'generating' })).toMatchObject({ busy: true, options: [{ action: 'stop-generation' }] })
  })

  it('reviews a proposal before anything else, with its counts and unresolved reasons', () => {
    const step = nextStep({ ...base, recordScope: null, proposal: { added: 2, removed: 1, modified: 0, unresolved: ['“date” already exists.'], canApply: false } })
    expect(step?.detail).toEqual([['Changes', '+2 added · −1 removed']])
    expect(step?.notice).toBe('“date” already exists.')
    expect(step?.options.map(({ action, disabled }) => [action, !!disabled])).toEqual([['apply', true], ['review-schema', false], ['discard', false]])
  })

  it('asks for the Record Scope before a run', () => {
    expect(actions({ recordScope: null })).toEqual(['scope:records', 'scope:document'])
  })

  it('offers the run, and says why it cannot start', () => {
    expect(nextStep(base)).toMatchObject({ key: 'run:first', title: 'Run extraction',
      options: [{ action: 'run', label: '▶ Run extraction', disabled: false }, { action: 'dismiss' }] })
    const blocked = nextStep({ ...base, run: { unavailableReason: 'The document is still being indexed', available: false } })
    expect(blocked?.notice).toBe('The document is still being indexed')
    expect(blocked?.options[0]?.disabled).toBe(true)
    expect(nextStep({ ...base, run: null })).toBeNull()
  })

  it('follows a running Extraction with its own controls, the chat being their only place', () => {
    expect(nextStep({ ...base, latest: latest('RUNNING') })).toMatchObject({ busy: true, notice: 'Reading records · 3 of 14',
      options: [{ action: 'pause', label: '❚❚ Pause extraction', description: 'Pause.' }, { action: 'stop', label: '■ Stop' }] })
    expect(actions({ latest: latest('PAUSED') })).toEqual(['resume', 'stop'])
    expect(actions({ latest: latest('FAILED') })).toEqual(['retry', 'stop'])
    expect(nextStep({ ...base, latest: latest('PAUSING') })).toMatchObject({ notice: 'Pausing…', options: [] })
    expect(nextStep({ ...base, latest: latest('RUNNING'), control: null })?.key).toBe('run:extraction-1')
  })

  it('holds Resume and Retry while pending inputs wait, saying why, and every command while one is under way', () => {
    const control = { ...base.control!, continueBlocked: 'Apply or discard the pending inputs before continuing.' }
    const step = nextStep({ ...base, latest: latest('PAUSED'), control })
    expect(step?.error).toBe('Apply or discard the pending inputs before continuing.')
    expect(step?.options.map(({ action, disabled }) => [action, !!disabled])).toEqual([['resume', true], ['stop', false]])
    expect(nextStep({ ...base, latest: latest('RUNNING'), control: { ...base.control!, busy: true } })?.options.every(({ disabled }) => disabled)).toBe(true)
  })

  it('keeps a finished run in view: Results while values wait, and a new run of the same revision', () => {
    expect(nextStep({ ...base, latest: latest('COMPLETED') })).toMatchObject({ question: 'Review the 2 values to check?',
      options: [{ action: 'review', tone: 'positive' }, { action: 'run', label: '↻ Re-run extraction', tone: 'secondary' }] })
    expect(actions({ latest: latest('COMPLETED'), resultsShown: true })).toEqual(['run'])
    expect(nextStep({ ...base, latest: { ...latest('COMPLETED'), toCheck: 0 } })).toMatchObject({ question: undefined,
      options: [{ action: 'review', tone: 'secondary' }, { action: 'run' }] })
  })

  it('offers a run again once the schema changed since the last one', () => {
    expect(nextStep({ ...base, latest: latest('COMPLETED', 'revision-1') })).toMatchObject({ key: 'run:extraction-1', title: 'Run extraction again' })
    expect(nextStep({ ...base, latest: latest('STOPPED') })?.title).toBe('Run extraction again')
  })

  it('keeps a dismissed step away until its key changes', () => {
    expect(nextStep({ ...base, dismissed: new Set(['run:first']) })).toBeNull()
    expect(nextStep({ ...base, view: 'empty', instructionCount: 1, dismissed: new Set(['generate:0']) })?.key).toBe('generate:1')
  })

  it('offers no schema step in a read-only view, leaving runs and the latest run\'s controls to the host', () => {
    expect(nextStep({ ...base, readOnly: true, view: 'empty' })).toBeNull()
    expect(nextStep({ ...base, readOnly: true, proposal: { added: 1, removed: 0, modified: 0, unresolved: [], canApply: true } })?.key).toBe('run:first')
    expect(nextStep({ ...base, readOnly: true, recordScope: null })?.key).toBe('run:first')
    expect(actions({ readOnly: true, latest: latest('PAUSED') })).toEqual(['resume', 'stop'])
  })
})
