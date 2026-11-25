import { describe, expect, it } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import {
  correctionProposalOf,
  resultCorrectionPrompt,
  valueLabel,
  valueTable,
  type CorrectableValue,
} from './_result_correction.js'

const YEAR: SchemaNode = { id: 'f-year', name: 'year', type: 'integer', description: 'Year of burial' }
const NAME: SchemaNode = { id: 'f-name', name: 'name', type: 'string' }
const SEX: SchemaNode = { id: 'f-sex', name: 'sex', type: 'string', allowedValues: ['female', 'male'] }

function value(id: string, node: SchemaNode, path: CorrectableValue['path'], modelValue: unknown, more: Record<string, unknown> = {}): CorrectableValue {
  return {
    id, recordId: `r-${String(path[1])}`, fieldId: node.id, path, node, modelValue,
    selectionId: '51000000-0000-4000-8005-000000000001', schemaRevisionId: '51000000-0000-4000-8004-000000000001',
    evidence: [], grounding: 'grounded', processing: 'saved', lineage: [], links: [],
    correction: null, historicalCorrection: null, correctionCompatibility: 'compatible',
    ...more,
  } as unknown as CorrectableValue
}

const RESULT = { extractionId: '51000000-0000-4000-8006-000000000001', snapshotVersion: 3 }
const year3 = value('val-year-3', YEAR, ['records', 2, 'year'], 1845)
const name3 = value('val-name-3', NAME, ['records', 2, 'name'], 'Ane Hansen', {
  correction: { revision: 2, decision: { action: 'EDITED', value: 'Anne Hansen' } },
})
const sex1 = value('val-sex-1', SEX, ['records', 0, 'sex'], 'female')
const title = value('val-title', NAME, ['title'], 'Burial register')

describe('valueLabel', () => {
  it('names a Catalog record by its number, and an Article value as the document\'s', () => {
    expect(valueLabel(year3)).toBe('Record 3 · year')
    expect(valueLabel(title)).toBe('Document · title')
    expect(valueLabel(value('v', NAME, ['records', 0, 'graves', 1, 'name'], 'x'))).toBe('Record 1 · graves › #2 › name')
  })
})

describe('valueTable', () => {
  it('lists saved values under aliases, as they stand with the researcher\'s decision, then the missing ones, and leaves unread values out', () => {
    const missing = value('val-absent', YEAR, ['records', 1, 'year'], null, { processing: 'absent' })
    const unread = value('val-unread', YEAR, ['records', 3, 'year'], null, { processing: 'unprocessed' })
    const table = valueTable([year3, name3, missing, unread, sex1])
    expect([...table.aliases.entries()].map(([alias, saved]) => [alias, saved.id]))
      .toEqual([['v1', 'val-year-3'], ['v2', 'val-name-3'], ['v3', 'val-sex-1'], ['v4', 'val-absent']])
    const lines = table.text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]).toEqual({ id: 'v1', where: 'Record 3', field: 'year', type: 'integer', description: 'Year of burial', value: 1845 })
    expect(lines[1]).toMatchObject({ id: 'v2', value: 'Anne Hansen', decision: 'EDITED' })
    expect(lines[2]).toMatchObject({ type: 'one of "female", "male"' })
    expect(lines[3]).toEqual({ id: 'v4', where: 'Record 2', field: 'year', type: 'integer', description: 'Year of burial', value: null, missing: true })
    expect(table.omitted).toBe(0)
  })

  it('lists a missing value the researcher filled in with its value', () => {
    const filled = value('val-filled', YEAR, ['records', 1, 'year'], null, {
      processing: 'absent', correction: { revision: 1, decision: { action: 'EDITED', value: 1850 } },
    })
    expect(JSON.parse(valueTable([filled]).text)).toMatchObject({ value: 1850, missing: true, decision: 'EDITED' })
  })

  it('counts the values past its budget, which the prompt says cannot be changed', () => {
    const table = valueTable([year3, name3, sex1], 150)
    expect(table.aliases.size).toBe(1)
    expect(table.omitted).toBe(2)
    expect(resultCorrectionPrompt(table, { message: 'year of record 3 is 1854', history: [] }))
      .toContain('(2 more values are not listed; they cannot be changed here.)')
  })
})

describe('correctionProposalOf', () => {
  const { aliases } = valueTable([year3, name3, sex1])

  it('fills in a missing value, and leaves out a rejection or an empty value for it', async () => {
    const missing = value('val-absent', YEAR, ['records', 1, 'year'], null, { processing: 'absent' })
    const filled = value('val-filled', YEAR, ['records', 4, 'year'], null, {
      processing: 'absent', correction: { revision: 1, decision: { action: 'EDITED', value: 1850 } },
    })
    const table = valueTable([missing, filled])
    const reply = JSON.stringify({ corrections: [
      { id: 'v1', action: 'edit', value: 1852, reason: 'on p. 2' },
      { id: 'v2', action: 'reject' },
    ] })
    await expect(correctionProposalOf(reply, RESULT, table.aliases)).resolves.toMatchObject({
      corrections: [{ valueId: 'val-absent', label: 'Record 2 · year', action: 'EDITED', current: null, value: 1852, expectedRevision: 0 }],
      dropped: ['Record 5 · year: to remove a value you filled in, use Undo in Results.'],
    })
    const empty = JSON.stringify({ corrections: [{ id: 'v1', action: 'reject' }, { id: 'v2', action: 'edit', value: null }] })
    await expect(correctionProposalOf(empty, RESULT, table.aliases)).resolves.toMatchObject({
      corrections: [], dropped: ['Record 5 · year: to remove a value you filled in, use Undo in Results.'],
    })
  })

  it('keeps each fitting change to a listed value, with the revision it was read at', async () => {
    const reply = JSON.stringify({
      corrections: [
        { id: 'v1', action: 'edit', value: 1854, reason: 'the register says 1854' },
        { id: 'v2', action: 'reject' },
      ],
      reply: 'Record 3: year 1854, and the name rejected.',
    })
    await expect(correctionProposalOf(reply, RESULT, aliases)).resolves.toEqual({
      ...RESULT,
      corrections: [
        { valueId: 'val-year-3', label: 'Record 3 · year', action: 'EDITED', current: 1845, value: 1854, expectedRevision: 0, reason: 'the register says 1854' },
        { valueId: 'val-name-3', label: 'Record 3 · name', action: 'REJECTED', current: 'Anne Hansen', expectedRevision: 2, reason: null },
      ],
      reply: 'Record 3: year 1854, and the name rejected.',
      dropped: [],
      templateChange: null,
    })
  })

  it('keeps the template change the model names beside the changes it can make now', async () => {
    const reply = JSON.stringify({
      corrections: [{ id: 'v1', action: 'edit', value: 1854 }],
      templateChange: '  Add a field "burial_place" (text): the parish named after the date.  ',
    })
    const proposal = await correctionProposalOf(reply, RESULT, aliases, 'add the burial place, and record 3 is 1854')
    expect(proposal.corrections).toHaveLength(1)
    expect(proposal.templateChange).toBe('Add a field "burial_place" (text): the parish named after the date.')
  })

  it('asks for a template change when every change it proposed does not fit its field, and for none otherwise', async () => {
    const misfit = JSON.stringify({ corrections: [{ id: 'v1', action: 'edit', value: 'ca. 1850' }] })
    const proposal = await correctionProposalOf(misfit, RESULT, aliases, 'record 3 is ca. 1850')
    expect(proposal.corrections).toEqual([])
    expect(proposal.templateChange).toBe('Change the template so that the extraction can hold what the researcher asked for: “record 3 is ca. 1850”. Say in each changed field\'s description how it is to be read.')
    // An unclear message the model asks about is no template change.
    const unclear = await correctionProposalOf('{"corrections":[],"templateChange":null,"reply":"Which record?"}', RESULT, aliases, 'fix it')
    expect(unclear.templateChange).toBeNull()
  })

  it('leaves out, and says, a change to an unlisted value, one that does not fit its field, or a second change', async () => {
    const reply = JSON.stringify({
      corrections: [
        { id: 'v9', action: 'edit', value: 1 },
        { id: 'v1', action: 'edit', value: 'eighteen fifty-four' },
        { id: 'v3', action: 'edit', value: 'unknown' },
        { id: 'v3', action: 'edit', value: 'male' },
        { id: 'v3', action: 'reject' },
      ],
    })
    const proposal = await correctionProposalOf(reply, RESULT, aliases)
    expect(proposal.corrections.map(({ valueId, value: to }) => [valueId, to])).toEqual([['val-sex-1', 'male']])
    expect(proposal.dropped).toEqual([
      'A change to "v9", which is not a listed value.',
      'Record 3 · year: "eighteen fifty-four" does not fit its field (integer).',
      'Record 1 · sex: "unknown" does not fit its field (one of "female", "male").',
      'A second change to Record 1 · sex.',
    ])
    expect(proposal.reply).toBeNull()
  })

  it('proposes nothing for a change that leaves the value as it is', async () => {
    const proposal = await correctionProposalOf('{"corrections":[{"id":"v2","action":"edit","value":"Anne Hansen"}],"reply":"Already so."}', RESULT, aliases)
    expect(proposal.corrections).toEqual([])
    expect(proposal.reply).toBe('Already so.')
  })

  it('refuses a reply that is no JSON object', async () => {
    await expect(correctionProposalOf('[]', RESULT, aliases)).rejects.toMatchObject({ code: 'invalid_model_output' })
  })
})
