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
  it('knows every field the values were read with, listed or not', () => {
    expect([...valueTable([year3, name3, sex1], 150).fields.keys()]).toEqual(['year', 'name', 'sex'])
  })

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

const MARKDOWN = '# Burial register\n\n| No. | Name | Year |\n|---|---|---|\n| 3 | **Anne  Hansen** | buried 1854 |\n| 12 | Peder Jensen | 1861 |'
const RESULT_READ = { ...RESULT, markdown: MARKDOWN }
const fact = (more: Record<string, unknown>) => ({ about: null, value: null, field: null, scope: 'value', remove: false, desired: null,
  from: null, quote: null, template: null, ...more })
const reply = (items: Record<string, unknown>[], more: Record<string, unknown> = {}) => JSON.stringify({ items: items.map(fact), ...more })

describe('correctionProposalOf: the model reports facts, Studio routes them (ADR 0043)', () => {
  const table = valueTable([year3, name3, sex1])
  const route = (items: Record<string, unknown>[], message = 'fix it') => correctionProposalOf(reply(items), RESULT_READ, table, message)

  it('changes a listed value to one the message gives, with the revision it was read at', async () => {
    await expect(correctionProposalOf(reply([
      { about: 'year of record 3', value: 'v1', field: 'year', desired: 1854, from: 'message' },
      { about: 'name of record 3', value: 'v2', field: 'name', remove: true },
    ], { reply: 'Record 3: year 1854, and the name rejected.' }), RESULT_READ, table)).resolves.toEqual({
      ...RESULT,
      corrections: [
        { valueId: 'val-year-3', label: 'Record 3 · year', action: 'EDITED', current: 1845, value: 1854, expectedRevision: 0, reason: 'year of record 3' },
        { valueId: 'val-name-3', label: 'Record 3 · name', action: 'REJECTED', current: 'Anne Hansen', expectedRevision: 2, reason: 'name of record 3' },
      ],
      reply: 'Record 3: year 1854, and the name rejected.',
      dropped: [],
      templateChange: null,
      rerun: null,
    })
  })

  it('takes a value read from the source only with a quote found in it; else it offers a new run', async () => {
    // Found, whatever its Markdown marks, case and spacing.
    const read = await route([{ value: 'v1', desired: 1854, from: 'source', quote: 'Buried 1854' }])
    expect(read.corrections).toMatchObject([{ valueId: 'val-year-3', value: 1854 }])
    expect((await route([{ value: 'v2', desired: 'Anne Hansen', from: 'source', quote: 'anne hansen' }])).corrections).toEqual([])
    // A quote not in the source, or none: the value is not taken as read.
    for (const quote of ['buried 1855', null, 'ab']) {
      const unread = await route([{ value: 'v1', desired: 1855, from: 'source', quote }])
      expect(unread).toMatchObject({ corrections: [], templateChange: null, rerun: 'Record 3 · year: its right value was not found in the source shown to the chat.' })
    }
    // Wrong, with no value to put in its place.
    expect((await route([{ value: 'v1', field: 'year' }])).rerun).toBe('Record 3 · year: its right value was not found in the source shown to the chat.')
  })

  it('offers a new run for a record the results do not have, when the template holds its field', async () => {
    const missed = await route([{ about: 'record 12 is missing', field: 'year', desired: 1861, from: 'message' }])
    expect(missed).toMatchObject({ corrections: [], templateChange: null, rerun: 'Not in the results: record 12 is missing.' })
  })

  it('changes the template for a field it lacks, a field read wrongly in general, or a value its field cannot hold', async () => {
    const lacking = await route([{ about: 'add the parish', template: 'Add a field "parish" (text).' }])
    expect(lacking).toMatchObject({ corrections: [], templateChange: 'Add a field "parish" (text).', rerun: null })
    // No template field, and the model named no change: the message, as what the template must hold.
    expect((await route([{ about: 'the parish', field: 'parish' }], 'the parish is missing')).templateChange)
      .toBe('Change the template so that the extraction can hold what the researcher asked for: “the parish is missing”. Say in each changed field\'s description how it is to be read.')
    const general = await route([{ about: 'dates read as day-month-year', value: 'v1', field: 'year', scope: 'field' }])
    expect(general.templateChange).toBe('Change how the field "year" is read: dates read as day-month-year. Say in its description how it is to be read.')
    expect(general.corrections).toEqual([])
    const misfit = await route([{ value: 'v1', desired: 'ca. 1850', from: 'message' }], 'record 3 is ca. 1850')
    expect(misfit).toMatchObject({ corrections: [], rerun: null,
      templateChange: 'Change the template so that the extraction can hold what the researcher asked for: “record 3 is ca. 1850”. Say in each changed field\'s description how it is to be read.' })
  })

  it('routes each thing one message asks on its own, and offers no run beside a template change', async () => {
    const mixed = await route([
      { value: 'v1', desired: 1854, from: 'message' },
      { about: 'record 12 is missing', field: 'year' },
      { about: 'add the parish', template: 'Add a field "parish" (text).' },
    ])
    expect(mixed.corrections).toHaveLength(1)
    expect(mixed.templateChange).toBe('Add a field "parish" (text).')
    expect(mixed.rerun).toBeNull()
    const twice = await route([{ about: 'add the parish', template: 'Add a field "parish" (text).' }, { about: 'parish too', template: 'Add a field "parish" (text).' }])
    expect(twice.templateChange).toBe('Add a field "parish" (text).')
  })

  it('fills in a missing value, and leaves out a rejection or an empty value for it', async () => {
    const missing = value('val-absent', YEAR, ['records', 1, 'year'], null, { processing: 'absent' })
    const filled = value('val-filled', YEAR, ['records', 4, 'year'], null, {
      processing: 'absent', correction: { revision: 1, decision: { action: 'EDITED', value: 1850 } },
    })
    const missingTable = valueTable([missing, filled])
    await expect(correctionProposalOf(reply([{ value: 'v1', desired: 1852, from: 'message' }, { value: 'v2', remove: true }]), RESULT_READ, missingTable))
      .resolves.toMatchObject({
        corrections: [{ valueId: 'val-absent', label: 'Record 2 · year', action: 'EDITED', current: null, value: 1852, expectedRevision: 0 }],
        dropped: ['Record 5 · year: to remove a value you filled in, use Undo in Results.'],
      })
  })

  it('leaves out, and says, a change to an unlisted value or a second change; a change to what is already so is none', async () => {
    const proposal = await route([
      { value: 'v9', desired: 1, from: 'message' },
      { value: 'v3', desired: 'male', from: 'message' },
      { value: 'v3', remove: true },
      { value: 'v2', desired: 'Anne Hansen', from: 'message' },
    ])
    expect(proposal.corrections.map(({ valueId, value: to }) => [valueId, to])).toEqual([['val-sex-1', 'male']])
    expect(proposal.dropped).toEqual(['A change to "v9", which is not a listed value.', 'A second change to Record 1 · sex.'])
  })

  it('asks when the message is unclear, and refuses a reply that is no JSON object', async () => {
    const unclear = await correctionProposalOf('{"items":[],"reply":"Which record?"}', RESULT_READ, table, 'fix it')
    expect(unclear).toMatchObject({ corrections: [], templateChange: null, rerun: null, reply: 'Which record?' })
    await expect(correctionProposalOf('[]', RESULT_READ, table)).rejects.toMatchObject({ code: 'invalid_model_output' })
  })
})

describe('resultCorrectionPrompt', () => {
  it('lists the template\'s fields, says where the message was said, and asks for facts, not decisions', () => {
    const prompt = resultCorrectionPrompt(valueTable([year3, name3, sex1]), { message: 'the date is wrong', history: [], view: 'template' })
    expect(prompt).toContain('FIELDS:\n{"field":"year","type":"integer","description":"Year of burial"}\n{"field":"name","type":"string"}')
    expect(prompt).toContain('looking at the template: a message there about a field is more likely about how the field is read')
    expect(prompt).toContain('do not decide what to do about it')
    expect(resultCorrectionPrompt(valueTable([year3]), { message: 'x', history: [] })).not.toContain('looking at')
  })
})
