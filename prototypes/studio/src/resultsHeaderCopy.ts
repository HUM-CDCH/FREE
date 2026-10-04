import type { ExtractionAttempt, PartialResult } from '../shared/extraction.contract'
import type { ExtractionState } from './extraction'
import { partialHeadline } from './partialResult'

export type StatusMark = 'spinner' | 'stopped' | 'failed' | 'completed' | 'incomplete' | 'saved'

/** The status line (results review redesign §2.1): a mark, a bold word and a muted rest, by state. */
export type StatusLine = {
  mark: StatusMark
  word: string
  rest: string
  /** "Schema rev {r}" after the rest, a link to the drawer's Schema section. */
  schemaRevision?: number
  /** "Why?" after the rest, a link to the drawer's Extraction section. */
  why?: boolean
  /** A failed run's message, on a second line with "Show details". */
  failure?: string
  /** The date of a saved review, as the line's title. */
  title?: string
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export function statusLine({ state, attempt, partial, cancellationRequested, schemaRevision, recordCount, decisionCount }: {
  state: ExtractionState
  attempt: ExtractionAttempt | null
  partial: PartialResult | null
  cancellationRequested: boolean
  schemaRevision: number | null
  recordCount: number
  decisionCount: number
}): StatusLine | null {
  const active = attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING'
  switch (state.status) {
    case 'idle': return null
    case 'cancelled': return { mark: 'stopped', word: 'Stopped', rest: '· nothing to review' }
    case 'error': return { mark: 'failed', word: 'Failed', rest: '· nothing to review', failure: state.message }
    case 'running': {
      if (!active) return { mark: 'spinner', word: 'Starting', rest: '' }
      if (cancellationRequested) return { mark: 'spinner', word: 'Stopping', rest: '· the run ends after the current call' }
      if (attempt?.executionStatus === 'QUEUED') return { mark: 'spinner', word: 'Queued', rest: '· waiting for the extraction worker' }
      if (!partial) return { mark: 'spinner', word: 'Starting', rest: '· finding records…' }
      const [word, ...rest] = partialHeadline(partial).split(' · ')
      return { mark: 'spinner', word: word!, rest: rest.length > 0 ? `· ${rest.join(' · ')}` : '' }
    }
    case 'ready': {
      if (attempt?.reviewedAt)
        return { mark: 'saved', word: 'Review saved', rest: `· ${plural(decisionCount, 'decision')} · read-only`, title: new Date(attempt.reviewedAt).toLocaleString() }
      if (attempt?.complete === false) return { mark: 'incomplete', word: 'Completed, not all of it', rest: '·', why: true }
      const what = attempt?.strategy === 'ARTICLE' ? '· Article' : `· Catalog · ${recordCount === 0 ? 'no records found' : plural(recordCount, 'record')}`
      return { mark: 'completed', word: 'Completed', rest: `${what}${schemaRevision === null ? '' : ' ·'}`, ...(schemaRevision === null ? {} : { schemaRevision }) }
    }
  }
}

/** The breakdown line's state (§2.2), from the review controller's three draft fields and its save. */
export function breakdownState({ running, saving, saved, error, loading = false, loaded = true, draftSaving, draftError, conflict }: {
  running: boolean; saving: boolean; saved: boolean; error: string | null
  /** The review is being read; `loaded` is false until it has decisions (a failed read). */
  loading?: boolean; loaded?: boolean
  draftSaving: boolean; draftError: string | null; conflict: boolean
}): { text: string; action?: 'retry-draft' | 'reload' | 'retry' | 'reload-review' } {
  if (saved) return { text: 'saved' }
  if (saving) return { text: 'Saving review…' }
  if (loading) return { text: 'Loading the review…' }
  // A review finalized elsewhere (review_conflict) cannot be saved again here: reload it (Error handling).
  if (error?.startsWith('review_conflict')) return { text: 'This review was saved elsewhere', action: 'reload-review' }
  if (error && !loaded) return { text: 'Review not loaded', action: 'reload-review' }
  if (error) return { text: 'Review not saved', action: 'retry' }
  if (conflict) return { text: 'The review changed elsewhere', action: 'reload' }
  if (draftError) return { text: 'Draft not saved', action: 'retry-draft' }
  if (draftSaving) return { text: 'Saving draft…' }
  if (running) return { text: 'draft until the run finishes' }
  return { text: 'draft saved' }
}
