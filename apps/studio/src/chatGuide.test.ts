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
    expect(nextStep(base)).toMatchObject({ key: 'run:first', title: 'Run extraction', options: [{ action: 'run', disabled: false }, { action: 'dismiss' }] })
    const blocked = nextStep({ ...base, run: { unavailableReason: 'The document is still being indexed', available: false } })
    expect(blocked?.notice).toBe('The document is still being indexed')
    expect(blocked?.options[0]?.disabled).toBe(true)
    expect(nextStep({ ...base, run: null })).toBeNull()
  })

  it('follows a running Extraction without controls of its own, and points to them once it stops short', () => {
    expect(nextStep({ ...base, latest: latest('RUNNING') })).toMatchObject({ busy: true, notice: 'Reading records · 3 of 14', options: [] })
    expect(nextStep({ ...base, latest: latest('PAUSED') })?.notice).toBe('Reading records · 3 of 14. Resume, retry or stop it above.')
  })

  it('opens Results after a finished run, unless Results is already in view or nothing is left to check', () => {
    expect(actions({ latest: latest('COMPLETED') })).toEqual(['review', 'dismiss'])
    expect(nextStep({ ...base, latest: latest('COMPLETED'), resultsShown: true })).toBeNull()
    expect(nextStep({ ...base, latest: { ...latest('COMPLETED'), toCheck: 0 } })).toBeNull()
  })

  it('offers a run again once the schema changed since the last one', () => {
    expect(nextStep({ ...base, latest: latest('COMPLETED', 'revision-1') })).toMatchObject({ key: 'run:extraction-1', title: 'Run extraction again' })
    expect(nextStep({ ...base, latest: latest('STOPPED') })?.title).toBe('Run extraction again')
  })

  it('keeps a dismissed step away until its key changes', () => {
    expect(nextStep({ ...base, dismissed: new Set(['run:first']) })).toBeNull()
    expect(nextStep({ ...base, view: 'empty', instructionCount: 1, dismissed: new Set(['generate:0']) })?.key).toBe('generate:1')
  })

  it('offers nothing in a read-only view', () => {
    expect(nextStep({ ...base, readOnly: true, recordScope: null })).toBeNull()
  })
})
