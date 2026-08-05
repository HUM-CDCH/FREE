import { describe, expect, it } from 'vitest'
import type { ProposedSchemaEdit } from '../shared/schemaEdit.contract'
import type { SchemaNode } from '../shared/schemaNode'
import { deriveSchemaProposal, replaySchemaChanges } from './schemaChanges'

function proposed(fields: ProposedSchemaEdit['fields'], additions: ProposedSchemaEdit['additions'] = []): ProposedSchemaEdit {
  return { status: 'proposed', fields, additions, issues: [] }
}

describe('deriveSchemaProposal', () => {
  it('keeps rename and retype on one complete change record', () => {
    const original: SchemaNode[] = [{ id: 'a', name: 'old', type: 'string', description: 'keep' }]
    const result = deriveSchemaProposal(original, proposed({
      old: { name: 'new', type: 'number', removed: false },
    }))

    expect(result.changes).toEqual([expect.objectContaining({
      id: 'a',
      before: original[0],
      after: { id: 'a', name: 'new', type: 'number', description: 'keep' },
    })])
    expect(result.reviewNodes).toHaveLength(1)
  })

  it('does not manufacture ancestor changes for a nested field edit', () => {
    const original: SchemaNode[] = [{
      id: 'group',
      name: 'group',
      type: 'object',
      children: [{ id: 'child', name: 'child', type: 'string' }],
    }]
    const result = deriveSchemaProposal(original, proposed({
      group: { name: 'group', type: 'object', removed: false },
      'group.child': { name: 'renamed', type: 'string', removed: false },
    }))

    expect(result.changes).toEqual([expect.objectContaining({ id: 'child', kind: 'modified' })])
  })

  it('resolves additions only through the post-edit namespace', () => {
    const original: SchemaNode[] = [{ id: 'g', name: 'group', type: 'object', children: [] }]
    const result = deriveSchemaProposal(original, proposed(
      { group: { name: 'renamed', type: 'object', removed: false } },
      [
        { path: ['renamed', 'child'], type: 'string' },
        { path: ['group', 'child'], type: 'string' },
      ],
    ))

    expect(result.nodes[0].children).toEqual([expect.objectContaining({ name: 'child' })])
    expect(result.issues).toContainEqual({ kind: 'unknown-key', key: 'group.child' })
    expect(result.changes.filter(({ kind }) => kind === 'added')).toEqual([
      expect.objectContaining({ outcome: 'applied' }),
      expect.objectContaining({ outcome: 'unresolved', reason: expect.any(String) }),
    ])
  })

  it('gives an added group and child distinct provisional ids', () => {
    const result = deriveSchemaProposal([], proposed({}, [
      { path: ['new_group'], type: 'object' },
      { path: ['new_group', 'new_child'], type: 'string' },
    ]))

    expect(result.nodes).toEqual([expect.objectContaining({
      id: expect.any(String),
      name: 'new_group',
      children: [expect.objectContaining({ id: expect.any(String), name: 'new_child' })],
    })])
    expect(result.changes).toHaveLength(2)
    expect(new Set(result.changes.map(({ id }) => id)).size).toBe(2)
  })

  it('pins closed sets while retaining a rename', () => {
    const original: SchemaNode[] = [{ id: 'e', name: 'gender', type: 'string', allowedValues: ['woman', 'man'] }]
    const result = deriveSchemaProposal(original, proposed({
      gender: { name: 'sex', type: 'number', removed: false },
    }))

    expect(result.nodes[0]).toEqual({ ...original[0], name: 'sex' })
    expect(result.changes[0]).toMatchObject({ outcome: 'conflict', reason: expect.any(String) })
  })

  it('materialises and removes children across the container boundary', () => {
    const original: SchemaNode[] = [
      { id: 'leaf', name: 'leaf', type: 'string' },
      { id: 'group', name: 'group', type: 'object', description: 'rule', children: [{ id: 'child', name: 'child', type: 'string' }] },
    ]
    const result = deriveSchemaProposal(original, proposed({
      leaf: { name: 'leaf', type: 'object', removed: false },
      group: { name: 'group', type: 'string', removed: false },
      'group.child': { name: 'child', type: 'string', removed: false },
    }))

    expect(result.nodes[0]).toEqual({ id: 'leaf', name: 'leaf', type: 'object', children: [] })
    expect(result.nodes[1]).toEqual({ id: 'group', name: 'group', type: 'string' })
    const groupChange = result.changes.find(({ id }) => id === 'group')
    expect(groupChange).toMatchObject({ note: expect.any(String) })
    expect(groupChange).not.toHaveProperty('reason')
  })

  it('removes a subtree atomically and retains mixed valid changes', () => {
    const original: SchemaNode[] = [
      { id: 'g', name: 'group', type: 'object', children: [{ id: 'c', name: 'child', type: 'string' }] },
      { id: 'x', name: 'title', type: 'string' },
    ]
    const result = deriveSchemaProposal(original, proposed({
      group: { name: 'group', type: 'object', removed: true },
      'group.child': { name: 'child', type: 'string', removed: false },
      title: { name: 'heading', type: 'string', removed: false },
    }, [{ path: ['missing', 'new'], type: 'string' }]))

    expect(result.nodes).toEqual([{ id: 'x', name: 'heading', type: 'string' }])
    expect(result.reviewNodes[0]).toEqual(original[0])
    expect(result.issues).toContainEqual({ kind: 'unknown-key', key: 'missing.new' })
  })

  it('replays parent and child decisions independently from the original tree', () => {
    const original: SchemaNode[] = [{
      id: 'group', name: 'group', type: 'object', description: 'keep',
      children: [{ id: 'child', name: 'child', type: 'string', description: 'also keep' }],
    }]
    const proposal = deriveSchemaProposal(original, proposed({
      group: { name: 'renamed', type: 'object', removed: false },
      'group.child': { name: 'renamed_child', type: 'string', removed: false },
    }))

    expect(replaySchemaChanges(original, proposal.changes, new Set(['group'])).nodes).toEqual([{
      ...original[0], name: 'renamed', children: [original[0].children![0]],
    }])
    expect(replaySchemaChanges(original, proposal.changes, new Set(['child'])).nodes).toEqual([{
      ...original[0], children: [{ ...original[0].children![0], name: 'renamed_child' }],
    }])
  })

  it('replays additions by resolved parent id and reports rejected dependencies', () => {
    const original: SchemaNode[] = [{ id: 'group', name: 'group', type: 'object', children: [] }]
    const proposal = deriveSchemaProposal(original, proposed(
      { group: { name: 'renamed', type: 'object', removed: false } },
      [{ path: ['renamed', 'child'], type: 'string' }],
    ))
    const addition = proposal.changes.find(({ kind }) => kind === 'added')!

    expect(addition.parentId).toBe('group')
    expect(replaySchemaChanges(original, proposal.changes, new Set([addition.id])).nodes).toEqual([{
      ...original[0], children: [addition.after],
    }])

    const nested = deriveSchemaProposal([], proposed({}, [
      { path: ['new_group'], type: 'object' },
      { path: ['new_group', 'new_child'], type: 'string' },
    ]))
    const [group, child] = nested.changes
    const replayed = replaySchemaChanges([], nested.changes, new Set([child.id]))
    expect(replayed.nodes).toEqual([])
    expect(replayed.outcomes.get(group.id)).toBe('rejected')
    expect(replayed.outcomes.get(child.id)).toBe('unresolved')
  })
})
