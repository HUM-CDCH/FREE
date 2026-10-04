import { describe, expect, it } from 'vitest'
import type { ReviewDecisionInput } from '../shared/extraction.contract'
import { recordDecision, undoLast } from './reviewHistory'

const sheet: ReviewDecisionInput = { resultPath: ['records', 0, 'sheet'], evidenceAnchorId: 'a', reviewedOccurrenceIds: ['o'], action: 'APPROVED', reviewedValue: null }

describe('reviewHistory (results review redesign §3.4)', () => {
  it('undo restores the decision and the value it replaced, untouched when it was untouched', () => {
    const calls: unknown[][] = []
    const set = (...args: unknown[]) => { calls.push(args) }
    const edited = recordDecision([], { ...sheet, action: 'EDITED', reviewedValue: '68' }, true)
    const history = recordDecision(edited, sheet, false)
    const undone = undoLast(history, set)!
    expect(calls.at(-1)).toEqual([['records', 0, 'sheet'], 'APPROVED', null, null, false])
    expect(undoLast(undone.history, set)!.history).toEqual([])
    expect(calls.at(-1)).toEqual([['records', 0, 'sheet'], 'EDITED', '68', null, true])
  })

  it('an undo is itself a decision, so Z can undo the undo; nothing to undo answers null', () => {
    const afterApprove = recordDecision([], sheet, false)
    const afterUndo = recordDecision(afterApprove, { ...sheet, action: 'APPROVED' }, true)
    expect(afterUndo.map((entry) => entry.before.touched)).toEqual([false, true])
    expect(undoLast([], () => {})).toBeNull()
  })
})
