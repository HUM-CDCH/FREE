import { describe, expect, it, vi } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import { ApiError } from './_http'
import { parseSchemaNodes, proposeSchemaEdit } from './_schema_edit'

const { generateSchemaEditJson } = vi.hoisted(() => ({ generateSchemaEditJson: vi.fn() }))
vi.mock('./_model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_model.js')>()),
  generateSchemaEditJson,
}))

const CALLER = { researcherAccountId: '51000000-0000-4000-8009-00000000000c' }
const nodes: SchemaNode[] = [
  { id: 'group', name: 'group', type: 'object', children: [{ id: 'child', name: 'child', type: 'string' }] },
]

describe('proposeSchemaEdit', () => {
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

  it('accepts an explicit item type for a new repeating scalar field', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({
      fields: {},
      additions: [{ path: ['dates'], type: 'array', itemType: 'date' }],
    }))

    await expect(proposeSchemaEdit([], 'add a list of dates', null, { caller: CALLER, generate })).resolves.toEqual({
      status: 'proposed',
      fields: {},
      additions: [{ path: ['dates'], type: 'array', itemType: 'date' }],
      issues: [],
    })
  })

  it('refuses duplicate keys before calling the model', async () => {
    const generate = vi.fn()
    const response = await proposeSchemaEdit([
      { id: 'a', name: 'same', type: 'string' },
      { id: 'b', name: 'same', type: 'number' },
    ], 'rename', null, { caller: CALLER, generate })

    expect(response).toMatchObject({ status: 'refused' })
    expect(generate).not.toHaveBeenCalled()
  })

  it('returns a valid zero-change proposal', async () => {
    const response = await proposeSchemaEdit(nodes, 'keep it', '# Source', {
      caller: CALLER,
      generate: vi.fn().mockResolvedValue(JSON.stringify({
        fields: {
          group: { name: 'group', type: 'object', removed: false },
          child: { name: 'child', type: 'string', removed: false },
        },
        additions: [],
      })),
    })

    expect(response).toEqual({
      status: 'proposed',
      fields: {
        group: { name: 'group', type: 'object', removed: false },
        child: { name: 'child', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })
  })

  it('accepts a model-proposed closed set and description for a string field', async () => {
    const response = await proposeSchemaEdit(
      [{ id: 'm', name: 'model_type', type: 'string' }],
      'model_type should be encoder, decoder, or both, in detail',
      null,
      {
        caller: CALLER,
        generate: vi.fn().mockResolvedValue(JSON.stringify({
          fields: {
            m: {
              name: 'model_type',
              type: 'string',
              removed: false,
              allowedValues: ['encoder', 'decoder', 'both'],
              description: 'Architecture family of the model',
            },
          },
          additions: [],
        })),
      },
    )

    expect(response).toEqual({
      status: 'proposed',
      fields: {
        m: {
          name: 'model_type',
          type: 'string',
          removed: false,
          allowedValues: ['encoder', 'decoder', 'both'],
          description: 'Architecture family of the model',
        },
      },
      additions: [],
      issues: [],
    })
  })

  it('accepts null for unchanged description and allowed values, not just omission', async () => {
    const response = await proposeSchemaEdit(
      [
        { id: 'm', name: 'model_type', type: 'string' },
        { id: 'g', name: 'gender', type: 'string', allowedValues: ['woman', 'man'] },
      ],
      'model type should be detailed, rather than just "transformer model"',
      null,
      {
        caller: CALLER,
        generate: vi.fn().mockResolvedValue(JSON.stringify({
          fields: {
            m: {
              name: 'model_type',
              type: 'string',
              removed: false,
              description: 'The architecture family, e.g. encoder, decoder, or both',
              allowedValues: null,
            },
            g: { name: 'gender', type: 'string', removed: false, description: null, allowedValues: null },
          },
          additions: [],
        })),
      },
    )

    expect(response).toEqual({
      status: 'proposed',
      fields: {
        m: {
          name: 'model_type',
          type: 'string',
          removed: false,
          description: 'The architecture family, e.g. encoder, decoder, or both',
          allowedValues: null,
        },
        g: { name: 'gender', type: 'string', removed: false, description: null, allowedValues: null },
      },
      additions: [],
      issues: [],
    })
  })

  it('rejects a single-value closed set as invalid', async () => {
    const response = await proposeSchemaEdit(
      [{ id: 'm', name: 'model_type', type: 'string' }],
      'model_type should only ever be "encoder"',
      null,
      {
        caller: CALLER,
        generate: vi.fn()
          .mockResolvedValueOnce(JSON.stringify({
            fields: { m: { name: 'model_type', type: 'string', removed: false, allowedValues: ['encoder'] } },
            additions: [],
          }))
          .mockResolvedValueOnce(JSON.stringify({ fields: {}, additions: [] })),
      },
    )

    expect(response).toMatchObject({ status: 'failed' })
  })

  it('retries missing and invalid keys once and keeps a validated partial result', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        fields: {
          group: { name: 'renamed', type: 'object', removed: false },
          child: { name: 'child', type: 'unsupported', removed: false },
          invented: { name: 'invented', type: 'string', removed: false },
        },
        additions: [{ path: ['renamed', 'new'], type: 'string' }, { broken: true }],
      }))
      .mockResolvedValueOnce(JSON.stringify({ fields: {}, additions: [] }))

    const response = await proposeSchemaEdit(nodes, 'rename and add', null, { caller: CALLER, generate })

    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[1][0]).toContain('"child"')
    expect(response).toEqual({
      status: 'proposed',
      fields: { group: { name: 'renamed', type: 'object', removed: false } },
      additions: [{ path: ['renamed', 'new'], type: 'string' }],
      issues: [
        { kind: 'unknown-key', key: 'invented' },
        { kind: 'invalid', key: 'additions[1]' },
        { kind: 'missing', key: 'group.child' },
      ],
    })
  })

  it('merges a valid scoped retry into the first-pass proposal', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        fields: { group: { name: 'group', type: 'object', removed: false } },
        additions: [],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        fields: { child: { name: 'renamed_child', type: 'string', removed: false } },
        additions: [],
      }))

    const response = await proposeSchemaEdit(nodes, 'rename child', null, { caller: CALLER, generate })

    expect(response).toMatchObject({
      status: 'proposed',
      fields: {
        group: { name: 'group', type: 'object', removed: false },
        child: { name: 'renamed_child', type: 'string', removed: false },
      },
      issues: [],
    })
  })

  it.each(['', '[]', '{"fields":"wrong"}', 'not json'])('fails unusable output %s', async (text) => {
    const response = await proposeSchemaEdit(nodes, 'change', null, { caller: CALLER, generate: vi.fn().mockResolvedValue(text) })
    expect(response).toEqual({ status: 'failed', message: 'Schema edit generation failed.' })
  })

  it.each(['invalid_model_output', 'model_operation_failed'])('converts %s into a failed response', async (code) => {
    const response = await proposeSchemaEdit(nodes, 'change', null, {
      caller: CALLER,
      generate: vi.fn().mockRejectedValue(new ApiError(502, code, 'Model failure.')),
    })

    expect(response).toEqual({ status: 'failed', message: 'Schema edit generation failed.' })
  })

  it.each([
    [409, 'invalid_model_config'],
    [503, 'keyring_unavailable'],
    [409, 'unsupported_temperature'],
    [500, 'unexpected_failure'],
  ])('preserves non-model ApiError %s %s for the HTTP adapter', async (status, code) => {
    const error = new ApiError(status, code, 'Operational failure.')

    await expect(proposeSchemaEdit(nodes, 'change', null, {
      caller: CALLER,
      generate: vi.fn().mockRejectedValue(error),
    })).rejects.toBe(error)
  })

  it('keeps a valid partial proposal when retry output is malformed', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        fields: { group: { name: 'renamed', type: 'object', removed: false } },
        additions: [],
      }))
      .mockResolvedValueOnce('')

    await expect(proposeSchemaEdit(nodes, 'rename group', null, { caller: CALLER, generate })).resolves.toEqual({
      status: 'proposed',
      fields: { group: { name: 'renamed', type: 'object', removed: false } },
      additions: [],
      issues: [{ kind: 'missing', key: 'group.child' }],
    })
  })

  it('preserves an operational error from a retry', async () => {
    const error = new ApiError(503, 'keyring_unavailable', 'Credential store unavailable.')
    const generate = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        fields: { group: { name: 'renamed', type: 'object', removed: false } },
        additions: [],
      }))
      .mockRejectedValueOnce(error)

    await expect(proposeSchemaEdit(nodes, 'rename group', null, { caller: CALLER, generate })).rejects.toBe(error)
  })

  it('instructs the model about complete independent edits and additions', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ fields: {}, additions: [] }))
    await proposeSchemaEdit([], 'add fields', null, { caller: CALLER, generate })
    const prompt = generate.mock.calls[0][0]

    expect(prompt).toContain('"new_scalar"')
    expect(prompt).toContain('"new_dates"')
    expect(prompt).toContain('additions must always be present; use []')
    expect(prompt).toContain('apply the researcher instruction to every relevant field')
    expect(prompt).not.toContain('unless explicitly told to rename it')
    expect(prompt).toContain('itemType is allowed only when type is array')
    expect(prompt).toContain('must not invent root path segments')
  })

  it("runs the default model call on the caller's configuration", async () => {
    generateSchemaEditJson.mockResolvedValue({ text: JSON.stringify({ fields: {}, additions: [] }) })

    await proposeSchemaEdit([], 'add fields', null, { caller: CALLER, temperature: 0.3 })

    expect(generateSchemaEditJson).toHaveBeenCalledWith(CALLER, expect.any(String), 0.3, undefined)
  })
})
