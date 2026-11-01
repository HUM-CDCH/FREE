import { describe, expect, it } from 'vitest'
import { nextStep, type GuideInput, type ProjectGuideInput } from './chatGuide'
import type { BatchExtraction } from '../shared/batchExtraction.contract'
import type { ProjectContextActivitySummary } from './projectContexts/transport'

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
  it('offers Generate template before the first template, counting the kept instructions', () => {
    const step = nextStep({ ...base, view: 'empty', instructionCount: 2 })
    expect(step?.options[0]).toMatchObject({ action: 'generate', label: 'Generate template (2 messages)', tone: 'positive' })
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

  it('offers a run again once the template changed since the last one', () => {
    expect(nextStep({ ...base, latest: latest('COMPLETED', 'revision-1') })).toMatchObject({ key: 'run:extraction-1', title: 'Run extraction again' })
    expect(nextStep({ ...base, latest: latest('STOPPED') })?.title).toBe('Run extraction again')
  })

  it('keeps a dismissed step away until its key changes', () => {
    expect(nextStep({ ...base, dismissed: new Set(['run:first']) })).toBeNull()
    expect(nextStep({ ...base, view: 'empty', instructionCount: 1, dismissed: new Set(['generate:0']) })?.key).toBe('generate:1')
  })

  it('offers no template step in a read-only view, leaving runs and the latest run\'s controls to the host', () => {
    expect(nextStep({ ...base, readOnly: true, view: 'empty' })).toBeNull()
    expect(nextStep({ ...base, readOnly: true, proposal: { added: 1, removed: 0, modified: 0, unresolved: [], canApply: true } })?.key).toBe('run:first')
    expect(nextStep({ ...base, readOnly: true, recordScope: null })?.key).toBe('run:first')
    expect(actions({ readOnly: true, latest: latest('PAUSED') })).toEqual(['resume', 'stop'])
  })
})

describe('nextStep in a project', () => {
  const summary = (overrides: Partial<ProjectContextActivitySummary> = {}): ProjectContextActivitySummary => ({
    phase: 'pilot', extractionCount: 0, extractedSourceDocumentCount: 0, reviewedSourceDocumentCount: 0, staleSourceDocumentCount: 0,
    pendingExtractionSourceDocumentCount: 4, schemaDraftCount: 0, currentSchemaRevisionId: 'revision-2', schemaStabilised: false,
    currentSchemaRevisionReviewed: false, lastActivityAt: '2026-11-01T00:00:00.000Z', runningBatch: null, ...overrides,
  })
  const documents = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: `${id}.pdf` }))
  const member = (sourceDocumentId: string, reviewed = false) => ({ extractionId: `extraction-${sourceDocumentId}`, sourceDocumentId,
    sourceRepresentationRevisionId: `source-${sourceDocumentId}`, executionStatus: 'COMPLETED' as const, completed: true, reviewable: true,
    currentReview: reviewed ? { snapshotVersion: 1, feedbackVersion: 0, createdAt: '2026-11-01T00:00:00.000Z', schemaRevisionId: 'revision-2' } : null })
  const batch = (members: ReturnType<typeof member>[], schemaRevisionId = 'revision-2'): BatchExtraction => ({
    batchExtractionId: `batch-${schemaRevisionId}`, projectContextId: 'project', schemaRevisionId, extractionSchemaId: 'schema',
    extractionSchemaName: 'Letters', schemaRevisionNumber: 2, strategy: 'CATALOG', executionStatus: 'COMPLETED', createdAt: '2026-11-01T00:00:00.000Z', members })
  const project = (overrides: Partial<ProjectGuideInput> = {}): ProjectGuideInput => ({
    summary: summary(), documents, currentDocumentId: 'b', batches: [], roundId: null, busy: false, error: null, ...overrides })
  const step = (overrides: Partial<ProjectGuideInput> = {}, input: Partial<GuideInput> = {}) => nextStep({ ...base, project: project(overrides), ...input })

  it('pilots a ready template on this document and the next ones, with a run of this document alone beside it', () => {
    expect(step()).toMatchObject({ key: 'pilot:revision-2', title: 'Pilot the template',
      picker: { initial: ['b', 'a', 'c'], limit: 5 }, options: [{ action: 'pilot', picks: true }, { action: 'run', label: 'Only this document' }, { action: 'dismiss' }] })
    // A schema saved here leads to the pilot before the summary is read again.
    expect(step({ summary: summary({ phase: 'schema' }) })?.key).toBe('pilot:revision-2')
    // Its own steps lead until the schema is ready.
    expect(step({}, { recordScope: null })?.key).toBe('scope')
    expect(step({}, { view: 'empty' })?.key).toBe('generate:0')
  })

  it('leads a pilot round\'s review: this document\'s Results, else the next document to review', () => {
    const pilot = { summary: summary({ extractedSourceDocumentCount: 3 }), batches: [batch([member('a', true), member('b'), member('c')])] }
    expect(step(pilot)).toMatchObject({ key: 'review:extraction-b', title: 'Pilot review', detail: [['Progress', '1 of 3 documents reviewed']], options: [{ action: 'review' }] })
    expect(step(pilot, { resultsShown: true })).toMatchObject({ options: [], notice: expect.stringContaining('save the review') })
    expect(step({ ...pilot, currentDocumentId: 'd' })).toMatchObject({ key: 'review-next:extraction-b', options: [
      { action: 'open-document', label: 'Next document · b.pdf', target: { sourceDocumentId: 'b', extractionId: 'extraction-b', batchExtractionId: 'batch-revision-2' } },
      { action: 'dismiss' }] })
    // Reviewed here, the round's next document after this one, round the round.
    expect(step({ ...pilot, batches: [batch([member('a'), member('b', true), member('c')])] })).toMatchObject({
      key: 'review-next:extraction-c', question: 'This document is reviewed. Open c.pdf next?' })
  })

  it('follows a running batch, then asks for the approval, then extracts the documents left', () => {
    expect(step({ summary: summary({ runningBatch: { completedMemberCount: 1, memberCount: 3 } }) })).toMatchObject({ busy: true, notice: 'Extraction running · 1/3' })
    expect(step({ summary: summary({ phase: 'approve', currentSchemaRevisionReviewed: true }) })).toMatchObject({
      key: 'approve:revision-2', options: [{ action: 'approve', label: 'Approve template' }, { action: 'dismiss' }] })
    const approved = summary({ phase: 'batch', schemaStabilised: true, currentSchemaRevisionReviewed: true })
    expect(step({ summary: approved, batches: [batch([member('a', true), member('b', true)])] })).toMatchObject({
      question: 'Extract the 2 documents left with the approved template?', picker: { initial: ['c', 'd'], limit: 50 }, options: [{ action: 'batch', picks: true }, { action: 'dismiss' }] })
    expect(step({ summary: approved, batches: null })).toMatchObject({ busy: true })
  })

  it('keeps this document\'s own run controls ahead of the project, and a finished project to this document', () => {
    expect(actions({ project: project(), latest: latest('RUNNING') })).toEqual(['pause', 'stop'])
    const done = summary({ phase: 'review', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 0,
      extractedSourceDocumentCount: 4, reviewedSourceDocumentCount: 4 })
    expect(step({ summary: done })?.key).toBe('run:first')
  })
})
