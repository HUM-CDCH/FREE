import { describe, expect, it } from 'vitest'
import { exportableResults, extractStep, nextStep, type GuideInput, type ProjectGuideInput } from './chatGuide'
import type { BatchExtraction } from '../shared/batchExtraction.contract'
import type { ProjectContextActivitySummary } from './projectContexts/transport'
import { guidedWorkflow } from './projectContexts/guidedWorkflow'

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
  const batch = (members: BatchExtraction['members'], schemaRevisionId = 'revision-2'): BatchExtraction => ({
    batchExtractionId: `batch-${schemaRevisionId}`, projectContextId: 'project', schemaRevisionId, extractionSchemaId: 'schema',
    extractionSchemaName: 'Letters', schemaRevisionNumber: 2, strategy: 'CATALOG', executionStatus: 'COMPLETED', createdAt: '2026-11-01T00:00:00.000Z', members })
  const project = (overrides: Partial<ProjectGuideInput> = {}): ProjectGuideInput => ({
    summary: summary(), documents, currentDocumentId: 'b', batches: [], latest: null, roundId: null, busy: false, error: null, ...overrides })
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

  it('keeps leading a pilot round\'s review after the template changed, however this document was opened', () => {
    const revised = summary({ currentSchemaRevisionId: 'revision-3', extractedSourceDocumentCount: 3 })
    const round = batch([member('a'), member('b'), member('c')])
    const revision3 = { revision: { id: 'revision-3', number: 3, fieldCount: 6 } }
    expect(guidedWorkflow(revised).next).toMatchObject({ step: 'pilot', label: 'Review 3 pilot results' })
    expect(step({ summary: revised, batches: [round], roundId: round.batchExtractionId, currentDocumentId: 'a' }, revision3))
      .toMatchObject({ key: 'review:extraction-a', title: 'Pilot review' })
    // "Continue in chat" and a tab switch open the document without its round: the page still says to review.
    expect(step({ summary: revised, batches: [round], currentDocumentId: 'a' }, revision3)?.key).toBe('review:extraction-a')
    expect(step({ summary: revised, batches: [round], currentDocumentId: 'd' }, revision3)?.key).toBe('review-next:extraction-a')
  })

  it('leads the revised template\'s pilot to its review, not to another pilot, before the approval', () => {
    // The server's phase reached the approval with revision 2's pilot; revision 3's own pilot has run since.
    const revised = summary({ phase: 'approve', currentSchemaRevisionId: 'revision-3', currentSchemaRevisionReviewed: false })
    const revision3 = { revision: { id: 'revision-3', number: 3, fieldCount: 6 } }
    expect(guidedWorkflow(revised).next).toMatchObject({ step: 'pilot', label: 'Pilot the revised template' })
    const older = batch([member('a', true), member('b')]), current = batch([member('a'), member('b'), member('c')], 'revision-3')
    expect(step({ summary: revised, batches: [older, current] }, revision3)).toMatchObject({ key: 'review:extraction-b', title: 'Pilot review' })
    // Only revision 2's round waits: the revised template is still to pilot.
    expect(step({ summary: revised, batches: [older] }, revision3)?.key).toBe('pilot:revision-3')
  })

  describe('in the approve phase, which the server reaches at the pilot\'s first review', () => {
    const approve = (overrides: Partial<ProjectContextActivitySummary> = {}) =>
      summary({ phase: 'approve', currentSchemaRevisionReviewed: true, ...overrides })
    const options = (card: ReturnType<typeof step>) => card?.options.map(({ action, tone }) => `${action}:${tone}`)

    it('leads the rest of the round with the approval beside it, as the project page says, then the approval alone', () => {
      const half = { summary: approve(), batches: [batch([member('a'), member('b', true)])] }
      expect(guidedWorkflow(half.summary).next?.label).toBe('Approve template')
      expect(step(half)).toMatchObject({ key: 'review-next:extraction-a', title: 'Pilot review', detail: [['Progress', '1 of 2 documents reviewed']] })
      expect(options(step(half))).toEqual(['open-document:positive', 'approve:secondary', 'dismiss:dismiss'])
      expect(step({ summary: approve(), batches: [batch([member('a', true), member('b', true)])] })).toMatchObject({
        key: 'approve:revision-2', question: 'Every pilot document is reviewed. Approve the template for the whole project?' })
      // Unread rounds may still wait: no claim that every pilot document is reviewed.
      expect(step({ ...half, batches: null })?.question).toBe('Approve the template for the whole project?')
    })

    it('never strands the approval behind a pilot member re-run since, which can no longer be reviewed', () => {
      // a's pilot Extraction was followed by a run of a alone (extraction-a2), its document's latest, shown on a.
      const pilot = [batch([member('a'), member('b', true), member('c', true)])]
      const a2 = { ...latest('COMPLETED'), extractionId: 'extraction-a2', toCheck: 0 }
      expect(options(step({ summary: approve(), batches: pilot }))).toEqual(['open-document:positive', 'approve:secondary', 'dismiss:dismiss'])
      // a's own card has no "Not yet": the approval is its way on.
      const onA = step({ summary: approve(), batches: pilot, currentDocumentId: 'a' }, { latest: a2 })
      expect(onA?.key).toBe('review:extraction-a')
      expect(options(onA)).toEqual(['review:positive', 'approve:secondary'])
      // A second pilot round that covers a again, whichever round this document was opened from.
      const again = [{ ...batch([member('a'), member('b', true), member('c', true)]), batchExtractionId: 'pilot-1' },
        { ...batch([{ ...member('a', true), extractionId: 'extraction-a2' }]), batchExtractionId: 'pilot-2', createdAt: '2026-11-02T00:00:00.000Z' }]
      for (const roundId of [null, 'pilot-1', 'pilot-2'])
        expect(options(step({ summary: approve(), batches: again, roundId }))).toContain('approve:secondary')
    })

    it('leaves a round of another revision to itself, even the one this document was opened from', () => {
      const revision3 = { revision: { id: 'revision-3', number: 3, fieldCount: 6 } }
      // Re-approval: the approved batch on revision 2 still has c and d to review.
      const revised = approve({ phase: 'review', currentSchemaRevisionId: 'revision-3', currentSchemaRevisionReviewed: false })
      const approved = batch([member('a', true), member('b', true), member('c'), member('d')])
      expect(step({ summary: revised, batches: [approved], roundId: approved.batchExtractionId }, revision3)).toMatchObject({
        key: 'approve:revision-3', title: 'Re-approve template' })
      // First approval of revision 3, this document opened from revision 2's pilot round.
      const older = batch([member('a'), member('b', true), member('c')]), current = batch([member('a', true), member('b', true)], 'revision-3')
      expect(step({ summary: approve({ currentSchemaRevisionId: 'revision-3' }), batches: [older, current], roundId: older.batchExtractionId },
        revision3)?.key).toBe('approve:revision-3')
    })
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

  it('asked to extract, offers this document alone or the project\'s ticked documents, as a pilot before the approval', () => {
    expect(extractStep({ ...base, project: project() }, 1)).toMatchObject({ key: 'extract:1', title: 'Extract',
      picker: { initial: ['b', 'a', 'c'], limit: 5 }, options: [
        { action: 'run', label: 'Only this document', disabled: false },
        { action: 'pilot', label: 'Documents in this project · {n}', picks: true, disabled: false },
        { action: 'dismiss', label: 'Not now' }] })
    const approved = summary({ phase: 'batch', schemaStabilised: true, currentSchemaRevisionReviewed: true })
    expect(extractStep({ ...base, project: project({ summary: approved, batches: [batch([member('a', true)])] }) }, 2)).toMatchObject({
      picker: { initial: ['b', 'c', 'd'], limit: 50 }, options: [{ action: 'run' }, { action: 'batch', picks: true }, { action: 'dismiss' }] })
  })

  it('asked to extract, says why nothing can run: a running batch, the host\'s reason, or no template yet', () => {
    const running = extractStep({ ...base, run: null, project: project({ summary: summary({ runningBatch: { completedMemberCount: 0, memberCount: 2 } }) }) }, 1)
    expect(running).toMatchObject({ notice: expect.stringContaining('batch extraction is running'), options: [{ action: 'pilot', disabled: true }, { action: 'dismiss' }] })
    expect(extractStep({ ...base, run: { available: false, unavailableReason: 'The document is still being indexed' } }, 1).notice)
      .toBe('The document is still being indexed')
    expect(extractStep({ ...base, view: 'empty', run: null, project: project() }, 1)).toMatchObject({
      notice: 'Nothing can be extracted until the template is ready.', options: [{ action: 'dismiss' }] })
  })

  it('offers a finished project\'s results to export, every document with one ticked, each its newest reviewed result', () => {
    const done = summary({ phase: 'review', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 0,
      extractedSourceDocumentCount: 3, reviewedSourceDocumentCount: 3 })
    const pilot = { ...batch([member('a', true), member('b', true)]), batchExtractionId: 'pilot', createdAt: '2026-11-01T00:00:00.000Z' }
    const later = { ...batch([{ ...member('b'), extractionId: 'b-again' }, member('c', true)]), batchExtractionId: 'later', createdAt: '2026-11-02T00:00:00.000Z' }
    expect(step({ summary: done, batches: [pilot, later] })).toMatchObject({ key: 'export:revision-2', title: 'Export results',
      picker: { documents: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], initial: ['a', 'b', 'c'], limit: 3 },
      options: [{ action: 'export', label: 'Export {n}…', picks: true }, { action: 'dismiss' }] })
    // b's newer result is not reviewed: its reviewed pilot result is exported.
    const results = exportableResults(project({ summary: done, batches: [pilot, later] }))
    expect([...results].map(([id, { extractionId, batchExtractionId }]) => [id, extractionId, batchExtractionId])).toEqual([
      ['c', 'extraction-c', 'later'], ['a', 'extraction-a', 'pilot'], ['b', 'extraction-b', 'pilot']])
  })

  // a was run again alone (extraction-a2), after the pilot round.
  const a2 = { sourceDocumentId: 'a', extractionId: 'extraction-a2', schemaRevisionId: 'revision-2', sourceRepresentationRevisionId: 'source-a',
    batchExtractionId: null, createdAt: '2026-11-02T00:00:00.000Z', completed: true, reviewed: true }

  it('exports each document\'s latest Extraction as the project page counts it, one of the document alone too, once reviewed', () => {
    const done = summary({ phase: 'review', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 0,
      extractedSourceDocumentCount: 2, reviewedSourceDocumentCount: 2 })
    const exported = (latest: (typeof a2)[]) => [...exportableResults(project({ summary: done, batches: [batch([member('a', true), member('b', true)])], latest }))]
      .map(([id, { extractionId, batchExtractionId }]) => [id, extractionId, batchExtractionId])
    expect(exported([a2])).toEqual([['a', 'extraction-a2', null], ['b', 'extraction-b', 'batch-revision-2']])
    // Not reviewed, or of another revision: the document's reviewed result in the round is exported.
    expect(exported([{ ...a2, reviewed: false }])[0]).toEqual(['a', 'extraction-a', 'batch-revision-2'])
    expect(exported([{ ...a2, schemaRevisionId: 'revision-1' }])[0]).toEqual(['a', 'extraction-a', 'batch-revision-2'])
  })

  it('leaves a member to review no longer once its document has a newer latest Extraction, as the project page counts it', () => {
    const reviewing = summary({ phase: 'review', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 0,
      extractedSourceDocumentCount: 3, reviewedSourceDocumentCount: 2 })
    expect(step({ summary: reviewing, batches: [batch([member('a'), member('b', true), member('c')])], latest: [a2], currentDocumentId: 'a' }))
      .toMatchObject({ key: 'review-next:extraction-c', title: 'Review results' })
    // Its newer run is not reviewed: no claim that this document is.
    expect(step({ summary: reviewing, batches: [batch([member('a'), member('b', true), member('c')])], latest: [{ ...a2, reviewed: false }],
      currentDocumentId: 'a' })?.question).toBe('Open c.pdf to review its values?')
    // A member run after its document's latest (saved values, no completed attempt) still waits.
    const failed = { ...member('a'), executionStatus: 'FAILED' as const, completed: false }
    expect(step({ summary: reviewing, batches: [batch([failed, member('b', true), member('c')])], latest: [{ ...a2, createdAt: '2026-10-31T00:00:00.000Z' }],
      currentDocumentId: 'a' })?.key).toBe('review:extraction-a')
    // Before the approval, a pilot whose only waiting member was re-run alone claims no fully reviewed pilot.
    const approve = summary({ phase: 'approve', currentSchemaRevisionReviewed: true, extractedSourceDocumentCount: 2, reviewedSourceDocumentCount: 1 })
    expect(step({ summary: approve, batches: [batch([member('a'), member('b', true)])], latest: [{ ...a2, reviewed: false }] })).toMatchObject({
      key: 'approve:revision-2', question: 'Approve the template for the whole project?' })
  })

  it('keeps this document\'s own run controls ahead of the project, and a finished project to this document', () => {
    expect(actions({ project: project(), latest: latest('RUNNING') })).toEqual(['pause', 'stop'])
    const done = summary({ phase: 'review', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 0,
      extractedSourceDocumentCount: 4, reviewedSourceDocumentCount: 4 })
    expect(step({ summary: done })?.key).toBe('run:first')
  })
})
