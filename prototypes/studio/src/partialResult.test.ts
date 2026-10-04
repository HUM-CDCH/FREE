import { describe, expect, it } from 'vitest'
import type { PartialRecord, PartialResult, PartialValueState } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'
import { draftDecisionsFromPartial, partialHeadline, partialValueAt, partialValueState, retainFinished } from './partialResult'

const link = (index: number, field = 'site'): EvidenceLink => ({
  resultPath: ['records', index, field], evidenceAnchorId: 'a_p1_s0',
})

describe('partialValueState', () => {
  it.each<PartialValueState>(['grounded', 'checking', 'reading', 'empty', 'contested'])('passes the server leaf state %s through unchanged', (state) => {
    const shown = {
      ...record(0, 'finished', [link(0)]),
      values: { '["site"]': { value: 'Unverified candidate', state } },
    }
    expect(partialValueState(shown, ['site'])).toBe(state)
  })

  it.each([
    ['queued', 'queued'], ['reading', 'reading'], ['checking', 'queued'], ['finished', 'queued'],
  ] as const)('maps record %s without leaf metadata to the explicit %s placeholder', (state, presentation) => {
    const shown = { ...record(0, state, [link(0)]), record: { site: 'Must not become a value' }, values: {} }
    expect(partialValueState(shown, ['site'])).toBe(presentation)
    expect(partialValueState(shown, ['container'])).toBe(presentation)
  })
})

function record(index: number, state: PartialRecord['state'], links: EvidenceLink[] = []): PartialRecord {
  return {
    index, label: String(index + 1), page: 1, state,
    record: state === 'queued' || state === 'reading' ? null : { site: `Site ${index}` },
    values: state === 'queued' || state === 'reading' ? {} : {
      '["site"]': { value: `Site ${index}`, state: state === 'finished' ? 'grounded' : 'checking' },
    },
    evidenceLinks: links,
  }
}

function partial(records: PartialRecord[], finished = records.filter((each) => each.state === 'finished').length): PartialResult {
  return { strategy: 'CATALOG', startedAtPage: 1, discovered: 3, finished, records, document: null }
}

describe('retainFinished', () => {
  it('keeps the last server partial when a read brings none, and accepts the first partial unchanged', () => {
    const shown = partial([record(0, 'finished', [link(0)])])
    expect(retainFinished(shown, null)).toBe(shown)
    expect(retainFinished(null, null)).toBeNull()
    expect(retainFinished(null, shown)).toBe(shown)
  })

  it('retains complete finished snapshots and server counters when later reads regress', () => {
    const kept = record(5, 'finished', [link(5)])
    kept.values['["uncertain"]'] = { value: null, state: 'contested', candidates: ['A', 'B'] }
    const previous = { ...partial([kept, record(0, 'checking')], 2), discovered: 8 }
    const next = { ...partial([record(5, 'checking'), record(0, 'finished', [link(0)])], 1), discovered: 2 }
    const shown = retainFinished(previous, next)!
    expect(shown.records.map((each) => each.index)).toEqual([5, 0])
    expect(shown.records[0]).toBe(kept)
    expect(shown.records[0].values['["uncertain"]'].state).toBe('contested')
    expect(shown.records[1]).toBe(next.records[1])
    expect(shown.finished).toBe(2)
    expect(shown.discovered).toBe(8)
  })

  it('keeps temporarily omitted finished records in their last server order without sorting by index or page', () => {
    const previous = partial([record(5, 'finished'), record(0, 'reading'), record(3, 'finished')])
    const next = partial([record(0, 'finished'), record(2, 'reading')])
    const shown = retainFinished(previous, next)!
    expect(shown.records.map((each) => each.index)).toEqual([5, 0, 3, 2])
    expect(shown.records[0]).toBe(previous.records[0])
    expect(shown.records[2]).toBe(previous.records[2])
    expect(retainFinished(previous, { ...next, records: [] })!.records.map((each) => each.index)).toEqual([5, 3])
    const ordered = partial([record(2, 'reading'), record(0, 'finished'), record(5, 'finished'), record(3, 'finished')])
    expect(retainFinished(previous, ordered)!.records.map((each) => each.index)).toEqual([2, 0, 5, 3])
  })

  it('retains finished snapshots if any old link disappears, and accepts an unchanged or richer server snapshot', () => {
    const previous = partial([record(0, 'finished', [link(0)])])
    const missing = partial([record(0, 'finished')])
    const different = partial([record(0, 'finished', [link(0, 'label')])])
    const unchanged = partial([record(0, 'finished', [link(0)])])
    const richer = partial([record(0, 'finished', [link(0), link(0, 'label')])])
    expect(retainFinished(previous, missing)!.records[0]).toBe(previous.records[0])
    expect(retainFinished(previous, different)!.records[0]).toBe(previous.records[0])
    expect(retainFinished(previous, unchanged)!.records[0]).toBe(unchanged.records[0])
    expect(retainFinished(previous, richer)!.records[0]).toBe(richer.records[0])
  })
})

describe('partialHeadline', () => {
  it('names the server counts, the start page when known, and Article contexts', () => {
    const shown = { ...partial([record(0, 'finished')]), finished: 2, discovered: 5 }
    expect(partialHeadline(shown)).toBe('Reading records · 2 of 5 · from page 1')
    expect(partialHeadline({ ...shown, startedAtPage: null })).toBe('Reading records · 2 of 5')
    expect(partialHeadline({ ...shown, strategy: 'ARTICLE', document: { contextsAnswered: 1, contexts: 3, groundingBatches: 0 } }))
      .toBe('Reading the document · 1 of 3 contexts')
    expect(partialHeadline({ ...shown, strategy: 'ARTICLE' })).toBe('Reading the document')
  })
})

describe('draft decisions on a running Extraction (results review redesign §5.1)', () => {
  const occurrences = new Map([['a_p1_s0', ['o-2', 'o-1']]])

  it('prepares one approval per link of a finished record whose anchor the pinned document has, naming every occurrence', () => {
    const shown = partial([record(0, 'finished', [link(0), { resultPath: ['records', 0, 'gone'], evidenceAnchorId: 'elsewhere' }]),
      record(1, 'checking', [link(1)]), record(2, 'reading')])
    expect(draftDecisionsFromPartial(shown, occurrences)).toEqual([{
      resultPath: ['records', 0, 'site'], evidenceAnchorId: 'a_p1_s0', reviewedOccurrenceIds: ['o-2', 'o-1'],
      action: 'APPROVED', reviewedValue: null,
    }])
  })

  it('reads the value a decision is made on from its record', () => {
    const shown = partial([record(0, 'finished', [link(0)])])
    expect(partialValueAt(shown, ['records', 0, 'site'])).toBe('Site 0')
    expect(partialValueAt(shown, ['records', 4, 'site'])).toBeUndefined()
  })
})
