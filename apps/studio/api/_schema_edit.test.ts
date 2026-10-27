import { describe, expect, it, vi } from 'vitest'
import type { SchemaDefinition, SchemaNode } from 'extraction/schema'
import { deriveSchemaProposal } from '../shared/schemaChanges.js'
import { ApiError } from './_http'
import { parseSchemaNodes, proposeSchemaEdit, schemaEditBetween } from './_schema_edit'

const CALLER = { researcherAccountId: '51000000-0000-4000-8009-00000000000c' }
const SOURCE = { markdown: '# Burial register', pageSpans: [{ pageNumber: 1, start: 0, end: 17 }] }

const definition: SchemaDefinition = {
  recordDescription: 'One numbered burial entry.',
  schemaNodes: [
    { id: 'title', name: 'title', type: 'string', description: 'The entry heading', evidencePolicy: 'quoted' },
    { id: 'status', name: 'status', type: 'string', allowedValues: ['open', 'closed'] },
    { id: 'count', name: 'count', type: 'string' },
    { id: 'notes', name: 'notes', type: 'string' },
    {
      id: 'grave',
      name: 'grave',
      type: 'object',
      children: [{ id: 'plot', name: 'plot', type: 'string' }],
    },
  ],
}

/** A generate port that answers with `template`, as generateSchemaWithModel does once it has parsed the reply. */
function answering(template: Record<string, unknown>) {
  return vi.fn(async () => ({ template, raw: JSON.stringify(template), pages: null, sourceCoverage: { complete: true as const } }))
}

/** The schema the researcher would have after applying every proposed change. */
async function applied(template: Record<string, unknown>): Promise<SchemaNode[]> {
  const response = await proposeSchemaEdit(definition, 'change it', SOURCE, { caller: CALLER, generate: answering(template) })
  if (response.status !== 'proposed') throw new Error(`expected a proposal, got ${response.status}`)
  return deriveSchemaProposal(definition.schemaNodes, response).nodes
}

describe('proposeSchemaEdit', () => {
  it('as a chat reply, answers a question with no proposal, and proposes from a revised schema otherwise', async () => {
    const generate = answering({})
    const respond = vi.fn()
      .mockResolvedValueOnce({ answer: 'Status is open or closed.' })
      .mockResolvedValueOnce({ template: { _description: 'One numbered burial entry.', title: 'string' }, raw: '', pages: null, sourceCoverage: { complete: true } })
    await expect(proposeSchemaEdit(definition, 'What can status be?', SOURCE, { caller: CALLER, generate, answerable: true, respond }))
      .resolves.toEqual({ status: 'answered', answer: 'Status is open or closed.' })
    const [caller, input, question] = respond.mock.calls[0]!
    expect(caller).toBe(CALLER)
    expect(input).toMatchObject({ document: { markdown: SOURCE.markdown } })
    expect(question).toMatchObject({ message: 'What can status be?' })
    expect(question.context).toContain('"status"')

    await expect(proposeSchemaEdit(definition, 'Keep only the title', SOURCE, { caller: CALLER, generate, answerable: true, respond }))
      .resolves.toMatchObject({ status: 'proposed' })
    expect(generate).not.toHaveBeenCalled()
  })

  it('accepts a typed repeating scalar field from the browser', () => {
    const repeatingDates = [{ id: 'dates', name: 'dates', type: 'array', itemType: 'date' }]

    expect(parseSchemaNodes(repeatingDates)).toEqual(repeatingDates)
    expect(() => parseSchemaNodes([{ id: 'dates', name: 'dates', type: 'array' }])).toThrow()
    expect(() => parseSchemaNodes([
      { id: 'count', name: 'count', type: 'number', allowedValues: ['one', 'two'] },
    ])).toThrow()
    expect(() => parseSchemaNodes([
      { id: 'kind', name: 'kind', type: 'string', allowedValues: ['string', 'date'] },
    ])).toThrow()
  })

  it('refuses duplicate keys before calling the model', async () => {
    const generate = answering({})
    const response = await proposeSchemaEdit({
      recordDescription: 'One row.',
      schemaNodes: [
        { id: 'a', name: 'same', type: 'string' },
        { id: 'b', name: 'same', type: 'number' },
      ],
    }, 'rename', null, { caller: CALLER, generate })

    expect(response).toMatchObject({ status: 'refused' })
    expect(generate).not.toHaveBeenCalled()
  })

  it('asks Schema Suggestion with the current template, its field notes, the change request and the source', async () => {
    const generate = answering({ _description: 'One numbered burial entry.' })
    const signal = new AbortController().signal

    await proposeSchemaEdit(definition, '  Make count a number  ', SOURCE, { caller: CALLER, generate, temperature: 0.2, signal })

    const [caller, input] = generate.mock.calls[0]! as unknown as [unknown, {
      document: { markdown: string; pageSpans: unknown }
      instruction: string
      temperature: number
      signal: AbortSignal
    }]
    expect(caller).toEqual(CALLER)
    expect(input.document).toMatchObject({ markdown: SOURCE.markdown, pageSpans: SOURCE.pageSpans })
    expect(input.temperature).toBe(0.2)
    expect(input.signal).toBe(signal)
    expect(input.instruction).toContain('"_description": "One numbered burial entry."')
    expect(input.instruction).toContain('"status": [\n    "open",\n    "closed"\n  ]')
    expect(input.instruction).toContain('- title: The entry heading')
    expect(input.instruction).toContain('Change request:\nMake count a number\n')
  })

  it('says a schema-only edit has no source document', async () => {
    const generate = answering({ _description: 'One numbered burial entry.' })

    await proposeSchemaEdit(definition, 'drop notes', null, { caller: CALLER, generate })

    const input = (generate.mock.calls[0]! as unknown as [unknown, { document: { markdown: string } }])[1]
    expect(input.document.markdown).toMatch(/^No source document accompanies this schema edit/)
  })

  it('proposes nothing when the revised template is the current one', async () => {
    const response = await proposeSchemaEdit(definition, 'keep it', SOURCE, {
      caller: CALLER,
      generate: answering({
        _description: 'One numbered burial entry.',
        title: 'string',
        status: ['open', 'closed'],
        count: 'string',
        notes: 'string',
        grave: { plot: 'string' },
      }),
    })

    expect(response).toEqual({ status: 'proposed', fields: {}, additions: [], issues: [] })
  })

  it('turns a revised template into the edits that reproduce it, keeping each surviving field', async () => {
    const nodes = await applied({
      _description: 'One numbered burial entry.',
      heading: 'string',
      status: 'string',
      count: 'integer',
      grave: { _description: 'Where the burial lies', plot: 'string', row: 'integer' },
      mourners: [{ name: 'verbatim-string' }],
    })

    expect(nodes).toEqual([
      // A lone unmatched pair at one level is a rename: the field keeps its id, note and evidence policy.
      { id: 'title', name: 'heading', type: 'string', description: 'The entry heading', evidencePolicy: 'quoted' },
      // A closed set the revision dropped is cleared.
      { id: 'status', name: 'status', type: 'string' },
      { id: 'count', name: 'count', type: 'integer' },
      {
        id: 'grave',
        name: 'grave',
        type: 'object',
        description: 'Where the burial lies',
        children: [{ id: 'plot', name: 'plot', type: 'string' }, { id: expect.any(String), name: 'row', type: 'integer' }],
      },
      {
        id: expect.any(String),
        name: 'mourners',
        type: 'array',
        children: [{ id: expect.any(String), name: 'name', type: 'verbatim-string' }],
      },
    ])
  })

  it('renames a field the revision replaces in place with one of the same shape, and removes one it does not', () => {
    const current: SchemaNode[] = [
      { id: 'a', name: 'a', type: 'string' },
      { id: 'b', name: 'b', type: 'string' },
    ]
    const revised: SchemaNode[] = [
      { id: 'x', name: 'c', type: 'string' },
      { id: 'y', name: 'd', type: 'date' },
      { id: 'z', name: 'e', type: 'string' },
    ]

    expect(schemaEditBetween(current, revised)).toEqual({
      fields: {
        a: { name: 'c', removed: false, description: null, type: 'string' },
        b: { name: 'b', removed: true, type: 'string' },
      },
      additions: [{ path: ['d'], type: 'date' }, { path: ['e'], type: 'string' }],
    })
  })

  it('sets a closed set and a repeating scalar the revision introduces', () => {
    const current: SchemaNode[] = [
      { id: 'kind', name: 'kind', type: 'string' },
      { id: 'dates', name: 'dates', type: 'string' },
    ]
    const revised: SchemaNode[] = [
      { id: 'x', name: 'kind', type: 'string', allowedValues: ['urn', 'coffin'] },
      { id: 'y', name: 'dates', type: 'array', itemType: 'date' },
    ]

    expect(schemaEditBetween(current, revised).fields).toEqual({
      kind: { name: 'kind', removed: false, description: null, type: 'string', allowedValues: ['urn', 'coffin'] },
      dates: { name: 'dates', removed: false, description: null, type: 'array', itemType: 'date' },
    })
  })

  it('answers failed when the model output is unusable, and lets an operational error through', async () => {
    const invalid = vi.fn(async () => { throw new ApiError(502, 'invalid_model_output', 'bad JSON') })
    await expect(proposeSchemaEdit(definition, 'change', SOURCE, { caller: CALLER, generate: invalid }))
      .resolves.toEqual({ status: 'failed', message: 'Schema edit generation failed.' })

    await expect(proposeSchemaEdit(definition, 'change', SOURCE, { caller: CALLER, generate: answering({ title: 'string' }) }))
      .resolves.toEqual({ status: 'failed', message: 'Schema edit generation failed.' })

    const misconfigured = new ApiError(409, 'invalid_model_config', 'No model.')
    await expect(proposeSchemaEdit(definition, 'change', SOURCE, {
      caller: CALLER,
      generate: vi.fn(async () => { throw misconfigured }),
    })).rejects.toBe(misconfigured)
  })
})
