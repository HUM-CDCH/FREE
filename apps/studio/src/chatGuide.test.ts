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
    expect(step?.options[0]).toMatchObject({ action: 'generate', label: 'Generate template (2 instructions)', tone: 'positive' })
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

  it('stops at Template ready after a generation, before the Record Scope or a run', () => {
    const step = nextStep({ ...base, templateReady: true, recordScope: null })
    expect(step).toMatchObject({ title: 'Template ready', question: 'Look at the template before going on?', detail: [['Template', '6 fields']] })
    expect(step?.options.map(({ action, tone }) => [action, tone])).toEqual([['review-schema', 'positive'], ['continue', 'secondary'], ['dismiss', 'dismiss']])
    expect(nextStep({ ...base, templateReady: true })?.detail).toEqual([['Template', '6 fields'], ['Strategy', 'Catalog']])
    // A finished run on the same template waits too: the generation is looked at first.
    expect(nextStep({ ...base, templateReady: true, latest: latest('COMPLETED') })?.title).toBe('Template ready')
  })

  it('leads Template ready with Continue once the template is in view, and keeps a proposal first', () => {
    expect(actions({ templateReady: true, templateShown: true })).toEqual(['continue', 'dismiss'])
    expect(nextStep({ ...base, templateReady: true, templateShown: true })?.options[0]?.tone).toBe('positive')
    expect(nextStep({ ...base, templateReady: true, proposal: { added: 1, removed: 0, modified: 0, unresolved: [], canApply: true } })?.key).toBe('proposal')
  })

  it('stops at Results ready after a completed run, before the project or the next run', () => {
    const step = nextStep({ ...base, resultsReady: true, latest: latest('COMPLETED') })
    expect(step).toMatchObject({ key: 'results-ready:extraction-1', title: 'Results ready', question: 'Look at the results? 2 values to check.',
      detail: [['Result', 'Reading records · 3 of 14']] })
    expect(step?.options.map(({ action, tone }) => [action, tone])).toEqual([['review', 'positive'], ['continue', 'secondary'], ['dismiss', 'dismiss']])
    // In view, Continue leads; a run not completed, or one not just seen to complete, has no such step.
    expect(actions({ resultsReady: true, latest: latest('COMPLETED'), resultsShown: true })).toEqual(['continue', 'dismiss'])
    expect(nextStep({ ...base, resultsReady: true, latest: latest('RUNNING') })?.title).not.toBe('Results ready')
    expect(nextStep({ ...base, latest: latest('COMPLETED') })?.title).not.toBe('Results ready')
  })

  it('asks for the Record Scope before a run', () => {
    expect(actions({ recordScope: null })).toEqual(['scope:records', 'scope:document', 'review-schema'])
  })

  it('opens the template from the steps after its generation, unless it is in view', () => {
    expect(nextStep({ ...base, recordScope: null })?.detail).toEqual([['Template', '6 fields']])
    expect(nextStep(base)?.options).toContainEqual(expect.objectContaining({ action: 'review-schema', label: 'View template' }))
    expect(actions({ recordScope: null, templateShown: true })).toEqual(['scope:records', 'scope:document'])
    expect(actions({ templateShown: true })).toEqual(['run', 'dismiss'])
  })

  it('offers the run, and says why it cannot start', () => {
    expect(nextStep(base)).toMatchObject({ key: 'run:first', title: 'Run extraction',
      options: [{ action: 'run', label: '▶ Run extraction', disabled: false }, { action: 'review-schema' }, { action: 'dismiss' }] })
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
    // Pausing waits for the call under way: Stop still ends the extraction.
    expect(nextStep({ ...base, latest: latest('PAUSING') })).toMatchObject({ notice: 'Pausing…', options: [{ action: 'stop', tone: 'danger' }] })
    expect(nextStep({ ...base, latest: latest('STOPPING') })).toMatchObject({ notice: 'Stopping…', options: [] })
    expect(nextStep({ ...base, latest: latest('RUNNING'), control: null })?.key).toBe('run:extraction-1')
  })

  it('leads a halted Extraction on an earlier template with a run of the current one, ahead of Retry or Resume', () => {
    const failed = nextStep({ ...base, latest: latest('FAILED', 'revision-1') })
    expect(failed?.question).toBe('It ran with an earlier template. Retry keeps that one; run the current template instead?')
    expect(failed?.options.map(({ action, tone }) => [action, tone])).toEqual([['restart', 'positive'], ['retry', 'secondary'], ['stop', 'danger']])
    expect(failed?.options[0]).toMatchObject({ label: '▶ Run again with the current template',
      description: 'Stops this extraction (its saved values and decisions stay), then runs template revision 2' })
    expect(actions({ latest: latest('PAUSED', 'revision-1') })).toEqual(['restart', 'resume', 'stop'])
    // The same template under another revision, or no way to run here, keeps Retry first.
    expect(actions({ latest: { ...latest('FAILED', 'revision-1'), sameTemplate: true } })).toEqual(['retry', 'stop'])
    expect(actions({ latest: latest('FAILED', 'revision-1'), run: null })).toEqual(['retry', 'stop'])
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

  it('offers Stop while the template is generated again, the saved one staying in view', () => {
    expect(nextStep({ ...base, generating: true })).toMatchObject({ title: 'Template Suggestion', busy: true,
      options: [{ action: 'stop-generation', label: 'Stop generating', tone: 'danger' }] })
    expect(nextStep({ ...base, view: 'generating', generating: true })?.options).toEqual([expect.objectContaining({ action: 'stop-generation' })])
  })

  it('says the template changed only once the last run\'s revision is compared and found to define another one', () => {
    const question = (status: Parameters<typeof latest>[0], schemaRevisionId: string, sameTemplate?: boolean | null) =>
      nextStep({ ...base, latest: { ...latest(status, schemaRevisionId), sameTemplate } })?.question
    expect(question('COMPLETED', 'revision-1', false)).toBe('The template changed since the last run. Run the extraction again?')
    // Not compared yet, or not readable: another revision, nothing more.
    expect(question('COMPLETED', 'revision-1', null)).toBe('The last run used another template revision. Run the extraction again?')
    expect(question('COMPLETED', 'revision-1')).toBe('The last run used another template revision. Run the extraction again?')
    // A stopped run of the current template asks to run again for that reason alone.
    expect(question('STOPPED', 'revision-2')).toBe('The last extraction was stopped. Run it again?')
    expect(question('STOPPED', 'revision-1', true)).toBe('The last extraction was stopped. Run it again?')
    expect(question('STOPPED', 'revision-1', false)).toBe('The last extraction was stopped, and the template changed since. Run it again?')
    expect(question('STOPPED', 'revision-1', null)).toBe('The last extraction was stopped, and it used another template revision. Run it again?')
  })

  it('leads with View template once the template is another than the last run\'s, and with the run otherwise', () => {
    const options = (input: Partial<GuideInput>) => nextStep({ ...base, ...input })?.options.map(({ action, tone }) => [action, tone])
    for (const sameTemplate of [false, null])
      expect(options({ latest: { ...latest('COMPLETED', 'revision-1'), sameTemplate } }))
        .toEqual([['review-schema', 'positive'], ['run', 'secondary'], ['dismiss', 'dismiss']])
    // Already in view: nothing to open, the run leads.
    expect(options({ latest: { ...latest('COMPLETED', 'revision-1'), sameTemplate: false }, templateShown: true }))
      .toEqual([['run', 'positive'], ['dismiss', 'dismiss']])
    // A stopped run of the same template, or the first run: the run leads, the template after it.
    expect(options({ latest: latest('STOPPED') })).toEqual([['run', 'positive'], ['review-schema', 'secondary'], ['dismiss', 'dismiss']])
    expect(options({ latest: null })).toEqual([['run', 'positive'], ['review-schema', 'secondary'], ['dismiss', 'dismiss']])
  })

  it('reads a finished run of another revision defining the same template as finished on it', () => {
    expect(nextStep({ ...base, latest: { ...latest('COMPLETED', 'revision-1'), sameTemplate: true } }))
      .toMatchObject({ key: 'finished:extraction-1', title: 'Extraction finished' })
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
    pendingExtractionSourceDocumentCount: 4, currentSchemaRevisionId: 'revision-2', schemaStabilised: false,
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

  it('stops a running Batch Extraction from the chat while a member is at work', () => {
    const running = { ...member('b'), executionStatus: 'RUNNING' as const, completed: false }
    const waiting = { summary: summary({ runningBatch: { completedMemberCount: 1, memberCount: 2 } }) }
    expect(step({ ...waiting, batches: [batch([member('a'), running])] })).toMatchObject({ key: 'project-running', busy: true,
      options: [{ action: 'stop-batch', label: '■ Stop batch extraction', tone: 'danger', disabled: false }] })
    expect(step({ ...waiting, batches: [batch([member('a'), running])], busy: true })?.options[0]).toMatchObject({ disabled: true })
    // Every member finished, or the batches not read yet: nothing to stop.
    expect(step({ ...waiting, batches: [batch([member('a')])] })?.options).toEqual([])
    expect(step({ ...waiting, batches: null })?.options).toEqual([])
  })

  it('pilots a ready template on this document and the next ones, with a run of this document alone beside it', () => {
    expect(step()).toMatchObject({ key: 'pilot:revision-2', title: 'Try template on a few documents',
      picker: { initial: ['b', 'a', 'c'], limit: 5 }, options: [{ action: 'pilot', picks: true }, { action: 'run', label: 'Only this document' }, { action: 'review-schema', label: 'View template' }, { action: 'dismiss' }] })
    // A schema saved here leads to the pilot before the summary is read again.
    expect(step({ summary: summary({ phase: 'schema' }) })?.key).toBe('pilot:revision-2')
    // Its own steps lead until the schema is ready.
    expect(step({}, { recordScope: null })?.key).toBe('scope')
    expect(step({}, { view: 'empty' })?.key).toBe('generate:0')
  })

  it('leads a pilot round\'s review: this document\'s Results, else the next document to review', () => {
    const pilot = { summary: summary({ extractedSourceDocumentCount: 3 }), batches: [batch([member('a', true), member('b'), member('c')])] }
    expect(step(pilot)).toMatchObject({ key: 'review:extraction-b', title: 'Review the trial results', detail: [['Progress', '1 of 3 documents reviewed']], options: [{ action: 'review' }] })
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
    expect(guidedWorkflow(revised).next).toMatchObject({ step: 'pilot', label: 'Review 3 trial results' })
    expect(step({ summary: revised, batches: [round], roundId: round.batchExtractionId, currentDocumentId: 'a' }, revision3))
      .toMatchObject({ key: 'review:extraction-a', title: 'Review the trial results' })
    // "Continue in chat" and a tab switch open the document without its round: the page still says to review.
    expect(step({ summary: revised, batches: [round], currentDocumentId: 'a' }, revision3)?.key).toBe('review:extraction-a')
    expect(step({ summary: revised, batches: [round], currentDocumentId: 'd' }, revision3)?.key).toBe('review-next:extraction-a')
  })

  it('leads the revised template\'s pilot to its review, not to another pilot, before the approval', () => {
    // The server's phase reached the approval with revision 2's pilot; revision 3's own pilot has run since.
    const revised = summary({ phase: 'approve', currentSchemaRevisionId: 'revision-3', currentSchemaRevisionReviewed: false })
    const revision3 = { revision: { id: 'revision-3', number: 3, fieldCount: 6 } }
    expect(guidedWorkflow(revised).next).toMatchObject({ step: 'pilot', label: 'Try the revised template on a few documents' })
    const older = batch([member('a', true), member('b')]), current = batch([member('a'), member('b'), member('c')], 'revision-3')
    expect(step({ summary: revised, batches: [older, current] }, revision3)).toMatchObject({ key: 'review:extraction-b', title: 'Review the trial results' })
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
      expect(step(half)).toMatchObject({ key: 'review-next:extraction-a', title: 'Review the trial results', detail: [['Progress', '1 of 2 documents reviewed']] })
      expect(options(step(half))).toEqual(['open-document:positive', 'approve:secondary', 'dismiss:dismiss'])
      expect(step({ summary: approve(), batches: [batch([member('a', true), member('b', true)])] })).toMatchObject({
        key: 'approve:revision-2', question: 'Every trial document is reviewed. Approve the template for the whole project?' })
      // Unread rounds may still wait: no claim that every pilot document is reviewed.
      expect(step({ ...half, batches: null })?.question).toBe('Approve the template for the whole project?')
    })

    it('reviews a trial member stopped or failed partway with its saved values, never one still running', () => {
      const stopped = { ...member('a'), executionStatus: 'STOPPED' as const, completed: false }
      const running = { ...member('a'), executionStatus: 'RUNNING' as const, completed: false }
      const others = [member('b', true), member('c', true)]
      expect(step({ summary: approve(), batches: [batch([stopped, ...others])] })).toMatchObject({ key: 'review-next:extraction-a',
        detail: [['Progress', '2 of 3 documents reviewed']] })
      expect(step({ summary: approve(), batches: [batch([running, ...others])] })?.key).toBe('approve:revision-2')
    })

    it('leaves a member whose document was run again since out of the round\'s progress', () => {
      // c's document shows a newer run (extraction-c2): only a and b are this round's to review.
      const round = batch([member('a'), member('b', true), member('c')])
      const latest = { extractions: [], reviewed: [], newest: ['extraction-a', 'extraction-b', 'extraction-c2'] }
      expect(step({ summary: approve(), batches: [round], latest })).toMatchObject({ key: 'review-next:extraction-a',
        detail: [['Progress', '1 of 2 documents reviewed']] })
    })

    it('names a round\'s review by whether the round was a trial, as the server says', () => {
      const waiting = [member('a'), member('b', true)]
      expect(step({ summary: approve(), batches: [{ ...batch(waiting), trial: false }] })?.title).toBe('Review results')
      expect(step({ summary: approve({ schemaStabilised: true }), batches: [{ ...batch(waiting), trial: true }] })?.title).toBe('Review the trial results')
    })

    it('offers a second trial, which can be skipped, between the first trial\'s review and the approval', () => {
      const reviewed = { summary: approve(), batches: [batch([member('a', true), member('b', true)])] }
      // Not asked yet: whether to try more documents, before the approval.
      expect(step({ ...reviewed, moreDocuments: 'ask' })).toMatchObject({ key: 'more-documents:revision-2', title: 'Try more documents?' })
      expect(step({ ...reviewed, moreDocuments: 'ask' })?.options.map(({ action, label }) => [action, label])).toEqual([
        ['more-documents', 'Yes, try more documents'], ['skip-more', 'No, go on to approval'], ['dismiss', expect.any(String)]])
      // Chosen: the documents not tried yet (c and d) to tick, with the upload beside them.
      const adding = step({ ...reviewed, moreDocuments: 'adding' })
      expect(adding).toMatchObject({ key: 'more-trial:revision-2', picker: { initial: ['c', 'd'], limit: 5 } })
      expect(adding?.picker?.documents.map(({ id }) => id)).toEqual(['c', 'd'])
      expect(options(adding)).toEqual(['pilot:positive', 'upload:secondary', 'skip-more:secondary', 'dismiss:dismiss'])
      // Every document tried: the upload leads, and waits while new ones are read.
      const all = { summary: approve(), batches: [batch(['a', 'b', 'c', 'd'].map((id) => member(id, true)))] }
      expect(step({ ...all, moreDocuments: 'ask' })?.options[0]).toMatchObject({ label: 'Yes, upload more documents' })
      expect(options(step({ ...all, moreDocuments: 'adding' }))).toEqual(['upload:positive', 'skip-more:secondary', 'dismiss:dismiss'])
      expect(step({ ...all, moreDocuments: 'adding', uploading: true })).toMatchObject({ key: 'more-upload:revision-2', busy: true,
        notice: 'Reading the new documents…', options: [{ action: 'upload', disabled: true }, { action: 'skip-more' }, { action: 'dismiss' }] })
      // Run or skipped: the approval.
      expect(step({ ...reviewed, moreDocuments: 'done' })?.key).toBe('approve:revision-2')
      // A round still to review comes first, and a re-approval never asks.
      expect(step({ summary: approve(), batches: [batch([member('a'), member('b', true)])], moreDocuments: 'ask' })?.key).toBe('review-next:extraction-a')
      const reapproval = approve({ phase: 'review', currentSchemaRevisionId: 'revision-3' })
      expect(guidedWorkflow(reapproval).next?.label).toBe('Re-approve template')
      expect(step({ summary: reapproval, batches: all.batches, moreDocuments: 'ask' })?.key).toBe('approve:revision-3')
    })

    it('never strands the approval behind a pilot member re-run since, which can no longer be reviewed', () => {
      // a's pilot Extraction was followed by a run of a alone (extraction-a2), its document's latest, shown on a.
      const pilot = [batch([member('a'), member('b', true), member('c', true)])]
      const a2 = { ...latest('COMPLETED'), extractionId: 'extraction-a2', toCheck: 0 }
      expect(options(step({ summary: approve(), batches: pilot }))).toEqual(['open-document:positive', 'approve:secondary', 'dismiss:dismiss'])
      // On a, which shows a2, a's pilot member can no longer be reviewed: the approval leads.
      expect(step({ summary: approve(), batches: pilot, currentDocumentId: 'a' }, { latest: a2 })?.key).toBe('approve:revision-2')
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
        { action: 'dismiss' }] })
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

  // a was run again alone (extraction-a2) after the pilot round, and reviewed at results 2 and decisions 3.
  const a2 = { sourceDocumentId: 'a', extractionId: 'extraction-a2', schemaRevisionId: 'revision-2', sourceRepresentationRevisionId: 'source-a',
    batchExtractionId: null as string | null, createdAt: '2026-11-02T00:00:00.000Z', completed: true,
    review: { snapshotVersion: 2, feedbackVersion: 3 } as { snapshotVersion: number; feedbackVersion: number } | null }
  // The project's read: each document's latest Extraction as its summary counts it, and the newest each document shows.
  const read = (extractions: (typeof a2)[], newest = ['extraction-a2', 'extraction-b', 'extraction-c', 'extraction-d']) =>
    ({ extractions, reviewed: extractions.filter(({ review }) => review), newest })
  const reviewing = summary({ phase: 'review', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 0,
    extractedSourceDocumentCount: 3, reviewedSourceDocumentCount: 2 })

  it('exports each document\'s newest review at its finalized cut, never unreviewed values', () => {
    const done = summary({ phase: 'review', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 0,
      extractedSourceDocumentCount: 2, reviewedSourceDocumentCount: 2 })
    const exported = (latest: ProjectGuideInput['latest'], members = [member('a', true), member('b', true)]) =>
      [...exportableResults(project({ summary: done, batches: [batch(members)], latest }))]
        .map(([id, { extractionId, batchExtractionId, review }]) => [id, extractionId, batchExtractionId, review])
    // Without the project's read (an older server): the rounds' reviewed members, at their reviewed cut.
    expect(exported(null)).toEqual([['a', 'extraction-a', 'batch-revision-2', { snapshotVersion: 1, feedbackVersion: 0 }],
      ['b', 'extraction-b', 'batch-revision-2', { snapshotVersion: 1, feedbackVersion: 0 }]])
    // A (a2, run alone) is reviewed, then B (a3) completes without review while the export is open: A, never B nor a's older member.
    const b = { ...a2, sourceDocumentId: 'b', extractionId: 'extraction-b', batchExtractionId: 'batch-revision-2', review: { snapshotVersion: 1, feedbackVersion: 0 } }
    const a3 = { ...a2, extractionId: 'extraction-a3', createdAt: '2026-11-03T00:00:00.000Z', review: null }
    expect(exported({ extractions: [a3, b], reviewed: [a2, b], newest: ['extraction-a3', 'extraction-b'] })).toEqual([
      ['a', 'extraction-a2', null, { snapshotVersion: 2, feedbackVersion: 3 }], ['b', 'extraction-b', 'batch-revision-2', { snapshotVersion: 1, feedbackVersion: 0 }]])
    // A newest review of another revision is not this template's result.
    expect(exported({ extractions: [], reviewed: [{ ...a2, schemaRevisionId: 'revision-1' }], newest: [] })).toEqual([])
    // A round member completed without review is never exported.
    expect(exported(null, [member('a')])).toEqual([])
  })

  it('leads no review to a member its document no longer shows: a newer run of it, finished or not', () => {
    const round = batch([member('a'), member('b', true), member('c')])
    expect(step({ summary: reviewing, batches: [round], latest: read([a2]), currentDocumentId: 'a' }))
      .toMatchObject({ key: 'review-next:extraction-c', title: 'Review results' })
    // a2 stopped before it completed: the summary's latest is still a's member, but a shows a2.
    const stopped = read([{ ...a2, extractionId: 'extraction-a', batchExtractionId: 'batch-revision-2', review: null }])
    expect(step({ summary: reviewing, batches: [round], latest: stopped, currentDocumentId: 'd' })?.key).toBe('review-next:extraction-c')
    // Open on a, which shows a2, whatever the project's last read says; and no claim that a is reviewed.
    expect(step({ summary: reviewing, batches: [round], currentDocumentId: 'a' }, { latest: { ...latest('STOPPED'), extractionId: 'extraction-a2' } }))
      .toMatchObject({ key: 'review-next:extraction-c', question: 'Open c.pdf to review its values?' })
    // A member its document shows still waits, whatever the summary counts as its latest.
    const failed = { ...member('a'), executionStatus: 'FAILED' as const, completed: false }
    expect(step({ summary: reviewing, batches: [batch([failed, member('b', true), member('c')])],
      latest: read([{ ...a2, extractionId: 'extraction-a0', createdAt: '2026-10-31T00:00:00.000Z' }], ['extraction-a', 'extraction-b', 'extraction-c']),
      currentDocumentId: 'a' })?.key).toBe('review:extraction-a')
    // Before the approval, a pilot whose only waiting member a shows no more claims no fully reviewed pilot.
    const approve = summary({ phase: 'approve', currentSchemaRevisionReviewed: true, extractedSourceDocumentCount: 2, reviewedSourceDocumentCount: 1 })
    expect(step({ summary: approve, batches: [batch([member('a'), member('b', true)])], latest: stopped })).toMatchObject({
      key: 'approve:revision-2', question: 'Approve the template for the whole project?' })
  })

  it('offers a finished run of a document alone, which no round holds, for review with the rounds\' members', () => {
    const unreviewed = read([{ ...a2, review: null }])
    const round = batch([member('a'), member('b', true), member('c', true)])
    expect(step({ summary: reviewing, batches: [round], latest: unreviewed })).toMatchObject({ key: 'review-next:extraction-a2', options: [
      { action: 'open-document', target: { sourceDocumentId: 'a', extractionId: 'extraction-a2', batchExtractionId: null } }, { action: 'dismiss' }] })
    expect(step({ summary: reviewing, batches: [round], latest: unreviewed, currentDocumentId: 'a' })?.key).toBe('review:extraction-a2')
    // Its own card keeps the run step's re-run: a run that saved no values can never be reviewed.
    expect(step({ summary: reviewing, batches: [round], latest: unreviewed, currentDocumentId: 'a' }, { resultsShown: true })?.options)
      .toEqual([expect.objectContaining({ action: 'run', label: '↻ Re-run extraction', tone: 'secondary' })])
    expect(step({ summary: reviewing, batches: [batch([member('b', true)])], latest: unreviewed })?.key).toBe('review-next:extraction-a2')
    // Of an older template, even in the pilot phase where every round counts, it leaves this document to its run again.
    const older = read([{ ...a2, review: null, schemaRevisionId: 'revision-1' }])
    expect(step({ summary: summary({ extractedSourceDocumentCount: 1 }), latest: older, currentDocumentId: 'a' },
      { latest: { ...latest('COMPLETED', 'revision-1'), extractionId: 'extraction-a2' } })?.key).toBe('run:extraction-a2')
  })

  it('keeps this document\'s own run controls ahead of the project, and a finished project to this document', () => {
    expect(actions({ project: project(), latest: latest('RUNNING') })).toEqual(['pause', 'stop'])
    const done = summary({ phase: 'review', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 0,
      extractedSourceDocumentCount: 4, reviewedSourceDocumentCount: 4 })
    expect(step({ summary: done })?.key).toBe('run:first')
  })
})
