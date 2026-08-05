import { describe, expect, it, vi } from 'vitest'
import type { SchemaNode } from '../shared/schemaNode'
import { proposeSchemaEdit } from './_schema_edit'

const nodes: SchemaNode[] = [
  { id: 'group', name: 'group', type: 'object', children: [{ id: 'child', name: 'child', type: 'string' }] },
]

describe('proposeSchemaEdit', () => {
  it('refuses duplicate keys before calling the model', async () => {
    const generate = vi.fn()
    const response = await proposeSchemaEdit([
      { id: 'a', name: 'same', type: 'string' },
      { id: 'b', name: 'same', type: 'number' },
    ], 'rename', null, { generate })

    expect(response).toMatchObject({ status: 'refused' })
    expect(generate).not.toHaveBeenCalled()
  })

  it('returns a valid zero-change proposal', async () => {
    const response = await proposeSchemaEdit(nodes, 'keep it', '# Source', {
      generate: vi.fn().mockResolvedValue(JSON.stringify({
        fields: {
          group: { name: 'group', type: 'object', removed: false },
          'group.child': { name: 'child', type: 'string', removed: false },
        },
        additions: [],
      })),
    })

    expect(response).toEqual({
      status: 'proposed',
      fields: {
        group: { name: 'group', type: 'object', removed: false },
        'group.child': { name: 'child', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })
  })

  it('retries missing and invalid keys once and keeps a validated partial result', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        fields: {
          group: { name: 'renamed', type: 'object', removed: false },
          'group.child': { name: 'child', type: 'unsupported', removed: false },
          invented: { name: 'invented', type: 'string', removed: false },
        },
        additions: [{ path: ['renamed', 'new'], type: 'string' }, { broken: true }],
      }))
      .mockResolvedValueOnce(JSON.stringify({ fields: {}, additions: [] }))

    const response = await proposeSchemaEdit(nodes, 'rename and add', null, { generate })

    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[1][0]).toContain('group.child')
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
        fields: { 'group.child': { name: 'renamed_child', type: 'string', removed: false } },
        additions: [],
      }))

    const response = await proposeSchemaEdit(nodes, 'rename child', null, { generate })

    expect(response).toMatchObject({
      status: 'proposed',
      fields: {
        group: { name: 'group', type: 'object', removed: false },
        'group.child': { name: 'renamed_child', type: 'string', removed: false },
      },
      issues: [],
    })
  })

  it.each(['[]', '{"fields":"wrong"}', 'not json'])('fails unusable output %s', async (text) => {
    const response = await proposeSchemaEdit(nodes, 'change', null, { generate: vi.fn().mockResolvedValue(text) })
    expect(response).toEqual({ status: 'failed', message: 'Schema edit generation failed.' })
  })
})
