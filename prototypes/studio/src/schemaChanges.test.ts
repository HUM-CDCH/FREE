import { describe, expect, it } from 'vitest'
import type { ProposedSchemaEdit } from '../shared/schemaEdit.contract'
import { nodesToTemplate, templateToNodes, type SchemaNode } from '../shared/schemaNode'
import {
  deriveSchemaProposal,
  replaySchemaChanges,
  summarizeSchemaRevision,
  toggleAcceptedSchemaChange,
} from './schemaChanges'

function proposed(fields: ProposedSchemaEdit['fields'], additions: ProposedSchemaEdit['additions'] = []): ProposedSchemaEdit {
  return { status: 'proposed', fields, additions, issues: [] }
}

describe('summarizeSchemaRevision', () => {
  it('derives structural changes from stable ids and order', () => {
    const previous: SchemaNode[] = [
      { id: 'a', name: 'site', type: 'string' },
      {
        id: 'group',
        name: 'burial',
        type: 'object',
        children: [{ id: 'b', name: 'year', type: 'number' }],
      },
    ]
    const current: SchemaNode[] = [
      {
        id: 'group',
        name: 'grave',
        type: 'object',
        children: [
          { id: 'b', name: 'year', type: 'string', description: 'Recorded year' },
          { id: 'c', name: 'place', type: 'string' },
        ],
      },
      { id: 'a', name: 'site', type: 'string' },
    ]

    expect(
      summarizeSchemaRevision(
        { recordDescription: 'One record.', schemaNodes: previous },
        { recordDescription: 'One record.', schemaNodes: current },
      ),
    ).toBe(
      '1 added, 1 renamed, 1 retyped, 1 description updated, 2 moved',
    )
    expect(
      summarizeSchemaRevision(null, {
        recordDescription: 'One record.',
        schemaNodes: current,
      }),
    ).toBe('Initial schema')
  })
})

describe('deriveSchemaProposal', () => {
  it('leaves an unchanged repeating scalar field untouched', () => {
    const original = templateToNodes({ dates: ['date'] })

    const result = deriveSchemaProposal(original, proposed({
      dates: { name: 'dates', type: 'array', itemType: 'date', removed: false },
    }))

    expect(result.changes).toEqual([])
    expect(nodesToTemplate(result.nodes)).toEqual({ dates: ['date'] })
  })

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

  it('rejects a rename that would duplicate a sibling field', () => {
    const original: SchemaNode[] = [
      { id: 'a', name: 'first', type: 'string' },
      { id: 'b', name: 'second', type: 'number' },
    ]

    const result = deriveSchemaProposal(original, proposed({
      first: { name: 'second', type: 'string', removed: false },
      second: { name: 'second', type: 'number', removed: false },
    }))

    expect(result.nodes).toEqual(original)
    expect(result.changes).toEqual([
      expect.objectContaining({ id: 'a', outcome: 'conflict', reason: expect.stringContaining('second') }),
    ])
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
      { id: 'g', name: 'group', type: 'object', description: 'group rule', children: [{ id: 'c', name: 'child', type: 'string' }] },
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
    expect(result.changes.find(({ id }) => id === 'g')).toMatchObject({
      note: expect.stringContaining('description'),
    })
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

  it('applies a sibling swap atomically and blocks a partial selection', () => {
    const original: SchemaNode[] = [
      { id: 'a', name: 'first', type: 'string' },
      { id: 'b', name: 'second', type: 'string' },
    ]
    const proposal = deriveSchemaProposal(original, proposed({
      first: { name: 'second', type: 'string', removed: false },
      second: { name: 'first', type: 'string', removed: false },
    }))

    expect(replaySchemaChanges(original, proposal.changes, new Set(['a', 'b'])).nodes).toEqual([
      { ...original[0], name: 'second' },
      { ...original[1], name: 'first' },
    ])
    const replayed = replaySchemaChanges(original, proposal.changes, new Set(['a']))

    expect(replayed.nodes).toEqual(original)
    expect(replayed.outcomes.get('a')).toBe('unresolved')
    expect(replayed.appliedCount).toBe(0)
    expect(replayed.hasChanges).toBe(false)
  })

  it('blocks a combined rename and retype when its rename cannot materialise', () => {
    const original: SchemaNode[] = [
      { id: 'a', name: 'first', type: 'string' },
      { id: 'b', name: 'second', type: 'string' },
    ]
    const proposal = deriveSchemaProposal(original, proposed({
      first: { name: 'second', type: 'number', removed: false },
      second: { name: 'first', type: 'string', removed: false },
    }))

    const replayed = replaySchemaChanges(original, proposal.changes, new Set(['a']))

    expect(replayed.nodes).toEqual(original)
    expect(replayed.outcomes.get('a')).toBe('unresolved')
    expect(replayed.appliedCount).toBe(0)
    expect(replayed.hasChanges).toBe(false)
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

  it('restores a modified parent required by a reselected child addition', () => {
    const original: SchemaNode[] = [{ id: 'group', name: 'group', type: 'string' }]
    const proposal = deriveSchemaProposal(original, proposed(
      { group: { name: 'group', type: 'object', removed: false } },
      [{ path: ['group', 'child'], type: 'string' }],
    ))
    const child = proposal.changes.find(({ kind }) => kind === 'added')!
    const accepted = new Set(proposal.changes.map(({ id }) => id))

    const withoutParent = toggleAcceptedSchemaChange(proposal.changes, accepted, 'group')
    const withChildReselected = toggleAcceptedSchemaChange(proposal.changes, withoutParent, child.id)

    expect(withoutParent).toEqual(new Set())
    expect(withChildReselected).toEqual(new Set(['group', child.id]))
    expect(replaySchemaChanges(original, proposal.changes, withChildReselected).hasChanges).toBe(true)
  })

  it('turns a scalar array into an array of records when the proposal adds a child', () => {
    const original: SchemaNode[] = [{ id: 'entries', name: 'entries', type: 'array', itemType: 'date' }]

    const result = deriveSchemaProposal(original, proposed(
      { entries: { name: 'entries', type: 'array', itemType: null, removed: false } },
      [{ path: ['entries', 'label'], type: 'string' }],
    ))

    expect(result.nodes).toEqual([{
      id: 'entries',
      name: 'entries',
      type: 'array',
      children: [expect.objectContaining({ name: 'label', type: 'string' })],
    }])
    expect(result.changes).toEqual([
      expect.objectContaining({ id: 'entries', kind: 'modified' }),
      expect.objectContaining({ kind: 'added', outcome: 'applied', dependsOn: ['entries'] }),
    ])
    expect(result.issues).toEqual([])
  })

  it('does not report descendant edits when a record array becomes a scalar array', () => {
    const original: SchemaNode[] = [{
      id: 'entries',
      name: 'entries',
      type: 'array',
      children: [{ id: 'label', name: 'label', type: 'string' }],
    }]

    const result = deriveSchemaProposal(original, proposed({
      entries: { name: 'entries', type: 'array', itemType: 'date', removed: false },
      'entries.label': { name: 'renamed_label', type: 'string', removed: false },
    }))

    expect(result.nodes).toEqual([{ id: 'entries', name: 'entries', type: 'array', itemType: 'date' }])
    expect(result.changes).toEqual([
      expect.objectContaining({ id: 'entries', kind: 'modified', outcome: 'applied' }),
    ])
    expect(result.changes[0].note).toContain('nested fields')
  })

  it('adds a repeating scalar with its requested item type', () => {
    const result = deriveSchemaProposal([], proposed({}, [
      { path: ['dates'], type: 'array', itemType: 'date' },
    ]))

    expect(result.nodes).toEqual([
      expect.objectContaining({ name: 'dates', type: 'array', itemType: 'date' }),
    ])
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'added', outcome: 'applied' }),
    ])
  })

  it('does not materialize an array of records for an unresolved deep addition', () => {
    const original: SchemaNode[] = [{ id: 'entries', name: 'entries', type: 'array', itemType: 'date' }]

    const result = deriveSchemaProposal(original, proposed(
      { entries: { name: 'entries', type: 'array', itemType: 'date', removed: false } },
      [{ path: ['entries', 'missing', 'label'], type: 'string' }],
    ))

    expect(result.nodes).toEqual(original)
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'added', outcome: 'unresolved' }),
    ])
    expect(result.issues).toContainEqual({ kind: 'unknown-key', key: 'entries.missing.label' })
  })
})
