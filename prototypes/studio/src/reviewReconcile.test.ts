import { describe, expect, it } from 'vitest'
import type { ReviewDecisionInput } from '../shared/extraction.contract'
import { reconcileAtSettlement } from './reviewReconcile'
import { resultPathKey } from './reviewDecisions'

const prepared = (record: number, field: string, anchor = `anchor-${field}`): ReviewDecisionInput => ({
  resultPath: ['records', record, field], evidenceAnchorId: anchor, reviewedOccurrenceIds: [`occurrence-${field}`],
  action: 'APPROVED', reviewedValue: null,
})
const key = (record: number, field: string) => resultPathKey(['records', record, field])

describe('reconcileAtSettlement (results review redesign §5.3)', () => {
  const settled = { records: [{ title: 'Alpha', year: 1900 }, { title: 'Beta', year: 1901 }] }

  it('keeps a decision the server kept whose settled value is the value it was made on', () => {
    const recovered = { decisions: [{ ...prepared(0, 'title'), action: 'REJECTED' as const }, prepared(0, 'year')], touchedPaths: new Set([key(0, 'title')]) }
    const reconciled = reconcileAtSettlement({ recovered, prepared: [prepared(0, 'title'), prepared(0, 'year')],
      result: settled, decidedOn: new Map([[key(0, 'title'), 'Alpha']]), dropped: [] })
    expect(reconciled.kept).toBe(1)
    expect([...reconciled.changed]).toEqual([])
    expect(reconciled.decisions[0]!.action).toBe('REJECTED')
    expect([...reconciled.touchedPaths]).toEqual([key(0, 'title')])
  })

  it('returns a value that changed under the decision to To check, marked changed', () => {
    const recovered = { decisions: [{ ...prepared(1, 'year'), action: 'REJECTED' as const }], touchedPaths: new Set([key(1, 'year')]) }
    const reconciled = reconcileAtSettlement({ recovered, prepared: [prepared(1, 'year')], result: settled,
      decidedOn: new Map([[key(1, 'year'), 1899]]), dropped: [] })
    expect(reconciled.kept).toBe(0)
    expect([...reconciled.changed]).toEqual([key(1, 'year')])
    expect(reconciled.touchedPaths.size).toBe(0)
    expect(reconciled.decisions).toEqual([prepared(1, 'year')])
  })

  it('counts a decision the server dropped (a record refused at the end) as changed', () => {
    const recovered = { decisions: [prepared(0, 'title')], touchedPaths: new Set([key(0, 'title')]) }
    const reconciled = reconcileAtSettlement({ recovered, prepared: [prepared(0, 'title')], result: settled,
      decidedOn: new Map([[key(0, 'title'), 'Alpha'], [key(4, 'title'), 'Gone']]),
      dropped: [{ resultPath: ['records', 4, 'title'], evidenceAnchorId: 'anchor-title' }] })
    expect(reconciled.kept).toBe(1)
    expect([...reconciled.changed]).toEqual([key(4, 'title')])
  })

  it('without decisions made in this session, keeps every kept draft decision (a reload during the run)', () => {
    const recovered = { decisions: [prepared(0, 'title')], touchedPaths: new Set([key(0, 'title')]) }
    const reconciled = reconcileAtSettlement({ recovered, prepared: [prepared(0, 'title')], result: settled, decidedOn: new Map(), dropped: [] })
    expect(reconciled.kept).toBe(1)
  })
})
