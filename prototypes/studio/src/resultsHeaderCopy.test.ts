import { describe, expect, it } from 'vitest'
import { breakdownState } from './resultsHeaderCopy'

const base = { running: false, saving: false, saved: false, error: null, draftSaving: false, draftError: null, conflict: false }

describe('the breakdown line state (results review redesign §2.2, Error handling)', () => {
  it.each([
    [{ loading: true }, 'Loading the review…', undefined],
    [{ error: 'review_conflict: That Extraction was reviewed differently.' }, 'This review was saved elsewhere', 'reload-review'],
    [{ error: 'Loading the review failed.', loaded: false }, 'Review not loaded', 'reload-review'],
    [{ error: 'Saving the review failed.' }, 'Review not saved', 'retry'],
    [{ running: true }, 'draft until the run finishes', undefined],
    [{}, 'draft saved', undefined],
    [{ draftSaved: false }, '', undefined],
  ])('%o → %s', (overrides, text, action) => {
    expect(breakdownState({ ...base, ...overrides })).toEqual(action ? { text, action } : { text })
  })
})
