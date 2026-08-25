// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaEditResponse } from '../shared/schemaEdit.contract'
import type { SchemaRevision, SchemaRevisionSummary } from '../shared/schemaRevision.contract'
import { nodesToTemplate, type SchemaNode } from 'extraction/schema'
import SchemaPanel from './SchemaPanel'

const { requestSchemaEdit } = vi.hoisted(() => ({ requestSchemaEdit: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  requestSchemaEdit,
}))

const nodes: SchemaNode[] = [
  { id: 'title', name: 'title', type: 'string', description: 'Research rule' },
  { id: 'gender', name: 'gender', type: 'string', allowedValues: ['woman', 'man'] },
]

function renderPanel(onNodesChange = vi.fn(), panelNodes = nodes, onResetSchema = vi.fn()) {
  render(<SchemaPanel
    state={{ status: 'ready', recordDescription: 'One test record.', nodes: panelNodes, inputsKey: 'test' }}
    onGenerate={vi.fn()}
    onCancelGenerate={vi.fn()}
    onResetSchema={onResetSchema}
    onNodesChange={onNodesChange}
    beforeSchemaEdit={vi.fn()}
    history={[]}
    loadRevision={vi.fn()}
    documentMarkdown={null}
    sourceDocumentName="test.pdf"
  />)
  return onNodesChange
}

const schemaHistory: SchemaRevisionSummary[] = [
  {
    schemaRevisionId: '51000000-0000-4000-8004-000000000002',
    extractionSchemaId: '51000000-0000-4000-8003-000000000001',
    revisionNumber: 2,
    origin: 'researcher-edit',
    createdAt: '2026-08-01T12:01:00.000Z',
    summary: '1 renamed',
  },
  {
    schemaRevisionId: '51000000-0000-4000-8004-000000000001',
    extractionSchemaId: '51000000-0000-4000-8003-000000000001',
    revisionNumber: 1,
    origin: 'suggestion',
    createdAt: '2026-08-01T12:00:00.000Z',
    summary: 'Initial schema',
  },
]

const historicalNodes: SchemaNode[] = [
  { id: 'stable-place', name: 'historical_place', type: 'string' },
  { id: 'stable-year', name: 'historical_year', type: 'number' },
]

type HistoryPanelOptions = {
  onNodesChange?: (nodes: SchemaNode[], message: string) => void
  beforeSchemaEdit?: () => Promise<void>
  loadRevision?: (schemaRevisionId: string) => Promise<SchemaRevision>
  panelNodes?: SchemaNode[]
  currentRevisionNumber?: number
}

function renderHistoryPanel({
  onNodesChange = vi.fn(),
  beforeSchemaEdit = vi.fn(async () => undefined),
  loadRevision = vi.fn(async () => ({
    ...schemaHistory[1],
    recordDescription: 'One historical record.',
    schemaNodes: historicalNodes,
  })),
  panelNodes = nodes,
  currentRevisionNumber = 2,
}: HistoryPanelOptions = {}) {
  render(<SchemaPanel
    state={{ status: 'ready', recordDescription: 'One test record.', nodes: panelNodes, inputsKey: 'test' }}
    onGenerate={vi.fn()}
    onCancelGenerate={vi.fn()}
    onResetSchema={vi.fn()}
    onNodesChange={onNodesChange}
    beforeSchemaEdit={beforeSchemaEdit}
    documentMarkdown={null}
    sourceDocumentName="test.pdf"
    history={schemaHistory}
    currentRevisionNumber={currentRevisionNumber}
    loadRevision={loadRevision}
  />)
}

async function send(response: SchemaEditResponse) {
  requestSchemaEdit.mockResolvedValueOnce(response)
  const input = screen.getByPlaceholderText('Describe a change to the schema…')
  fireEvent.change(input, { target: { value: 'Update fields' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByRole('button', { name: 'Apply changes' })
  return input
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe.sequential('SchemaPanel schema proposal review', () => {
  it('renames the durable schema from the schema/chat header', async () => {
    const onRenameSchema = vi.fn(async () => null)
    render(
      <SchemaPanel
        state={{ status: 'ready', recordDescription: 'One test record.', nodes, inputsKey: 'test' }}
        onGenerate={vi.fn()}
        onCancelGenerate={vi.fn()}
        onResetSchema={vi.fn()}
        onNodesChange={vi.fn()}
        beforeSchemaEdit={vi.fn()}
        history={[]}
        loadRevision={vi.fn()}
        documentMarkdown={null}
        sourceDocumentName="test.pdf"
        schemaName="Places"
        onRenameSchema={onRenameSchema}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename schema Places' }))
    fireEvent.change(screen.getByLabelText('Schema name for Places'), {
      target: { value: 'Historic places' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))

    await waitFor(() =>
      expect(onRenameSchema).toHaveBeenCalledWith('Historic places'),
    )
  })

  it('omits unchanged types from a rename-only diff row', async () => {
    renderPanel()
    await send({
      status: 'proposed',
      fields: {
        title: { name: 'heading', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    const row = screen.getByText('title').parentElement!
    expect(within(row).queryAllByText('string')).toHaveLength(0)
  })

  it('loads, flushes, and appends an exact historical tree in order', async () => {
    const onNodesChange = vi.fn()
    const order: string[] = []
    const loadRevision = vi.fn(async () => {
      order.push('load')
      return {
        ...schemaHistory[1],
        recordDescription: 'One historical record.',
        schemaNodes: historicalNodes,
      }
    })
    const beforeSchemaEdit = vi.fn(async () => { order.push('flush') })
    onNodesChange.mockImplementation(() => { order.push('edit') })
    renderHistoryPanel({ onNodesChange, beforeSchemaEdit, loadRevision })

    const chatHeader = screen.getByText('Chat').parentElement!
    fireEvent.click(within(chatHeader).getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    await waitFor(() => expect(onNodesChange).toHaveBeenCalledTimes(1))

    expect(order).toEqual(['load', 'flush', 'edit', 'flush'])
    expect(onNodesChange).toHaveBeenCalledWith(
      historicalNodes,
      '↺ Restored revision 1',
      'One historical record.',
    )
    expect(screen.getByText('historical_place')).toBeInTheDocument()
    expect(screen.getByText('historical_year')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add field' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Revision 1/ })).not.toBeInTheDocument()
  })

  it('closes history without loading or flushing the current revision', () => {
    const onNodesChange = vi.fn()
    const beforeSchemaEdit = vi.fn()
    const loadRevision = vi.fn()
    renderHistoryPanel({ onNodesChange, beforeSchemaEdit, loadRevision })

    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 2/ }))

    expect(loadRevision).not.toHaveBeenCalled()
    expect(beforeSchemaEdit).not.toHaveBeenCalled()
    expect(onNodesChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Revision 2/ })).not.toBeInTheDocument()
  })

  it('keeps the current schema when loading or pre-restore flushing fails', async () => {
    const onNodesChange = vi.fn()
    const loadRevision = vi.fn(async () => { throw new Error('Load failed') })
    const beforeSchemaEdit = vi.fn(async () => undefined)
    renderHistoryPanel({ onNodesChange, beforeSchemaEdit, loadRevision })

    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed')
    expect(beforeSchemaEdit).not.toHaveBeenCalled()
    expect(onNodesChange).not.toHaveBeenCalled()
    expect(screen.getByText('title')).toBeInTheDocument()

    cleanup()
    const flushFailure = vi.fn(async () => { throw new Error('Save current failed') })
    renderHistoryPanel({ onNodesChange, beforeSchemaEdit: flushFailure })
    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save current failed')
    expect(flushFailure).toHaveBeenCalledTimes(1)
    expect(onNodesChange).not.toHaveBeenCalled()
    expect(screen.getByText('title')).toBeInTheDocument()
  })

  it('keeps the restored editable tree when its append flush fails', async () => {
    const onNodesChange = vi.fn()
    const beforeSchemaEdit = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Append failed'))
    renderHistoryPanel({ onNodesChange, beforeSchemaEdit })

    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Append failed')
    expect(onNodesChange).toHaveBeenCalledWith(
      historicalNodes,
      '↺ Restored revision 1',
      'One historical record.',
    )
    expect(screen.getByText('historical_place')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add field' })).toBeInTheDocument()
  })

  it('applies an inline edit at arbitrary nesting depth', () => {
    const onNodesChange = renderPanel(vi.fn(), [{
      id: 'root',
      name: 'root',
      type: 'object',
      children: [{
        id: 'group',
        name: 'group',
        type: 'object',
        children: [{ id: 'leaf', name: 'leaf', type: 'string' }],
      }],
    }])

    fireEvent.click(screen.getByText('group').parentElement!.querySelector('polygon')!.closest('span')!)
    fireEvent.click(screen.getByTitle('Edit leaf'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'renamed leaf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onNodesChange.mock.calls[0][0][0].children[0].children[0].name).toBe('renamed_leaf')
    expect(screen.getByText('renamed_leaf')).toBeInTheDocument()
  })

  it('shows field types and lets an editor change them', () => {
    const onNodesChange = renderPanel()

    expect(screen.getAllByTitle('Type: string — click to edit')).toHaveLength(2)
    fireEvent.click(screen.getByTitle('Edit title'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Field type' }), { target: { value: 'number' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onNodesChange.mock.calls[0][0][0]).toEqual({
      id: 'title',
      name: 'title',
      type: 'number',
      description: 'Research rule',
    })
    expect(screen.getByTitle('Type: number — click to edit')).toBeInTheDocument()
  })

  it('lets an editor change an array item type', () => {
    const onNodesChange = renderPanel(vi.fn(), [
      { id: 'dates', name: 'dates', type: 'array', itemType: 'date' },
    ])

    fireEvent.click(screen.getByTitle('Type: array<date> — click to edit'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Array item type' }), { target: { value: 'integer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onNodesChange.mock.calls[0][0][0]).toEqual({
      id: 'dates',
      name: 'dates',
      type: 'array',
      itemType: 'integer',
    })
    expect(screen.getByTitle('Type: array<integer> — click to edit')).toBeInTheDocument()
  })

  it('keeps an inline edit open when its name duplicates a sibling field', () => {
    const onNodesChange = renderPanel()

    fireEvent.click(screen.getByTitle('Edit title'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'gender' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByRole('alert')).toHaveTextContent('A sibling field already uses “gender”.')
    expect(screen.getByDisplayValue('gender')).toBeInTheDocument()
    expect(onNodesChange).not.toHaveBeenCalled()
  })

  it('repairs a persisted duplicate id before renaming the affected field', async () => {
    const onNodesChange = renderPanel(vi.fn(), [
      { id: 'n1', name: 'grav_id', type: 'integer' },
      { id: 'n1', name: 'nyt_felt', type: 'verbatim-string' },
    ])

    fireEvent.click(screen.getByTitle('Edit nyt_felt'))
    fireEvent.change(screen.getAllByPlaceholderText('field_name').at(-1)!, {
      target: { value: 'nuum' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!)

    await waitFor(() => expect(onNodesChange).toHaveBeenCalledTimes(1))
    const updated = onNodesChange.mock.calls[0][0] as SchemaNode[]
    expect(updated.map(({ name }) => name)).toEqual(['grav_id', 'nuum'])
    expect(new Set(updated.map(({ id }) => id))).toHaveLength(2)
    expect(screen.queryByText('A sibling field already uses “nuum”.')).not.toBeInTheDocument()
  })

  it('preserves an existing closed set when the field is renamed', () => {
    const onNodesChange = renderPanel()

    fireEvent.click(screen.getByTitle('Edit gender'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'sex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onNodesChange.mock.calls[0][0][1]).toEqual({
      id: 'gender',
      name: 'sex',
      type: 'string',
      allowedValues: ['woman', 'man'],
    })
  })

  it('opens the field editor when the allowed-values badge is clicked', () => {
    renderPanel()

    fireEvent.click(screen.getByTitle('Allowed values — click to edit: woman, man'))

    expect(screen.getByDisplayValue('gender')).toBeInTheDocument()
    expect(screen.getByText('woman')).toBeInTheDocument()
    expect(screen.getByText('man')).toBeInTheDocument()
  })

  it('adds and removes allowed values from the badge editor', () => {
    const onNodesChange = renderPanel()

    fireEvent.click(screen.getByTitle('Allowed values — click to edit: woman, man'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove woman' }))
    fireEvent.change(screen.getByPlaceholderText('add value…'), { target: { value: 'other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onNodesChange.mock.calls[0][0][1]).toEqual({
      id: 'gender',
      name: 'gender',
      type: 'string',
      allowedValues: ['man', 'other'],
    })
  })

  it('drops the closed set entirely once fewer than two values remain', () => {
    const onNodesChange = renderPanel()

    fireEvent.click(screen.getByTitle('Allowed values — click to edit: woman, man'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove woman' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove man' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onNodesChange.mock.calls[0][0][1]).toEqual({ id: 'gender', name: 'gender', type: 'string' })
  })

  it('preserves repetition when a field is dragged into a scalar array', async () => {
    const onNodesChange = renderPanel(vi.fn(), [
      { id: 'dates', name: 'dates', type: 'array', itemType: 'date' },
      { id: 'title', name: 'title', type: 'string' },
    ])
    const titleRow = screen.getByText('title').parentElement!
    const datesRow = screen.getByText('dates').parentElement!

    fireEvent.mouseDown(titleRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(datesRow)
    fireEvent.mouseUp(window)

    await waitFor(() => expect(onNodesChange).toHaveBeenCalledTimes(1))
    expect(nodesToTemplate(onNodesChange.mock.calls[0][0])).toEqual({
      dates: [{ title: 'string' }],
    })
  })

  it('preserves the complete schema when a nested field is moved into a sibling array', async () => {
    const original: SchemaNode[] = [
      { id: 'grave', name: 'grave', type: 'object', children: [
        { id: 'year', name: 'year', type: 'integer' },
        { id: 'skeleton', name: 'skeleton', type: 'array', children: [
          { id: 'equipment', name: 'equipment', type: 'string' },
          { id: 'dating', name: 'dating', type: 'string' },
        ] },
        { id: 'new-field', name: 'new_field', type: 'verbatim-string' },
      ] },
    ]
    const onNodesChange = renderPanel(vi.fn(), original)

    const movedRow = screen.getByText('new_field').parentElement!
    const skeletonRow = screen.getByText('skeleton').parentElement!
    fireEvent.mouseDown(movedRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(skeletonRow)
    fireEvent.mouseUp(window)

    await waitFor(() => expect(onNodesChange).toHaveBeenCalledTimes(1))
    expect(nodesToTemplate(onNodesChange.mock.calls[0][0])).toEqual({
      grave: {
        year: 'integer',
        skeleton: [{
          equipment: 'string',
          dating: 'string',
          new_field: 'verbatim-string',
        }],
      },
    })
  })

  it('does not truncate the schema when a group is dropped into its own contents', async () => {
    const original: SchemaNode[] = [
      { id: 'grave', name: 'grave', type: 'object', children: [
        { id: 'year', name: 'year', type: 'integer' },
      ] },
      { id: 'new-field', name: 'new_field', type: 'verbatim-string' },
    ]
    const onNodesChange = renderPanel(vi.fn(), original)
    const graveRow = screen.getByText('grave').parentElement!
    const yearRow = screen.getByText('year').parentElement!
    const nestedSlot = yearRow.parentElement!.firstElementChild!

    fireEvent.mouseDown(graveRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(nestedSlot)
    fireEvent.mouseUp(window)

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot move field into its own contents.')
    expect(onNodesChange).not.toHaveBeenCalled()
    expect(screen.getByText('grave')).toBeInTheDocument()
    expect(screen.getByText('year')).toBeInTheDocument()
    expect(screen.getByText('new_field')).toBeInTheDocument()
  })

  it('shows the item shape when reviewing an array type change', async () => {
    renderPanel(vi.fn(), [
      { id: 'entries', name: 'entries', type: 'array', itemType: 'date' },
    ])

    await send({
      status: 'proposed',
      fields: {
        entries: { name: 'entries', type: 'array', itemType: null, removed: false },
      },
      additions: [{ path: ['entries', 'label'], type: 'string' }],
      issues: [],
    })

    expect(screen.getByText('array<date>')).toBeInTheDocument()
    expect(screen.getByText('array<object>')).toBeInTheDocument()
  })

  it('rejects a drag that would duplicate a sibling field', async () => {
    const onNodesChange = renderPanel(vi.fn(), [
      { id: 'group', name: 'group', type: 'object', children: [{ id: 'nested-title', name: 'title', type: 'string' }] },
      { id: 'root-title', name: 'title', type: 'string' },
    ])
    const titleRows = screen.getAllByText('title').map((label) => label.parentElement!)
    const groupRow = screen.getByText('group').parentElement!

    fireEvent.mouseDown(titleRows.at(-1)!.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(groupRow)
    fireEvent.mouseUp(window)

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot move field: a sibling field already uses “title”.')
    expect(onNodesChange).not.toHaveBeenCalled()
  })

  it('allows a move when a dotted field name only resembles a nested path', async () => {
    const onNodesChange = renderPanel(vi.fn(), [
      { id: 'flat', name: 'place.region', type: 'string' },
      { id: 'place', name: 'place', type: 'object', children: [{ id: 'nested', name: 'region', type: 'string' }] },
      { id: 'year', name: 'year', type: 'integer' },
    ])
    const yearRow = screen.getByText('year').parentElement!
    const placeRow = screen.getByText('place').parentElement!

    fireEvent.mouseDown(yearRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(placeRow)
    fireEvent.mouseUp(window)

    await waitFor(() => expect(onNodesChange).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not apply a rename that collides with an existing sibling', async () => {
    const original: SchemaNode[] = [
      { id: 'surname', name: 'surname', type: 'string' },
      { id: 'name', name: 'name', type: 'string' },
    ]
    const onNodesChange = renderPanel(vi.fn(), original)
    await send({
      status: 'proposed',
      fields: {
        surname: { name: 'name', type: 'string', removed: false },
        name: { name: 'name', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    expect(screen.getByText('Conflict')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled()

    expect(onNodesChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(screen.getByText(/"surname": "string"/)).toBeInTheDocument()
    expect(screen.getByText(/"name": "string"/)).toBeInTheDocument()
  })

  it('shows one row per node, mixed counts, metadata reach, and applies atomically', async () => {
    const onNodesChange = renderPanel()
    const input = await send({
      status: 'proposed',
      fields: {
        title: { name: 'heading', type: 'number', removed: false },
        gender: { name: 'sex', type: 'number', removed: false },
      },
      additions: [{ path: ['missing', 'child'], type: 'string' }],
      issues: [{ kind: 'missing', key: 'unreturned' }],
    })

    expect(screen.getAllByText('heading')).toHaveLength(1)
    expect(screen.getAllByText('title')).toHaveLength(1)
    expect(screen.getByText('number')).toBeInTheDocument()
    expect(input).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept change to heading' }))

    expect(screen.getAllByText('heading')).toHaveLength(1)
    expect(screen.getAllByText('title')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))

    expect(onNodesChange).toHaveBeenCalledTimes(1)
    expect(onNodesChange.mock.calls[0][0]).toEqual([
      nodes[0],
      { id: 'gender', name: 'sex', type: 'string', allowedValues: ['woman', 'man'] },
    ])
  })

  it('explains an unresolved change created by selective acceptance', async () => {
    renderPanel()
    await send({
      status: 'proposed',
      fields: {
        title: { name: 'gender', type: 'number', removed: false },
        gender: { name: 'title', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept change to title' }))

    expect(screen.getByText('Unresolved')).toHaveAttribute('title', expect.stringContaining('review decision'))
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled()
  })

  it('starts an unmaterialisable change accepted while replay keeps it unresolved', async () => {
    renderPanel(vi.fn(), [{ id: 'name', name: 'name', type: 'string' }])
    await send({
      status: 'proposed',
      fields: { name: { name: 'name', type: 'string', removed: false } },
      additions: [{ path: ['missing', 'child'], type: 'string' }],
      issues: [],
    })

    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled()
  })

  it('gives an added group and child independent decisions', async () => {
    const onNodesChange = renderPanel()
    await send({
      status: 'proposed',
      fields: {
        title: { name: 'title', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [
        { path: ['new_group'], type: 'object' },
        { path: ['new_group', 'new_child'], type: 'string' },
      ],
      issues: [],
    })

    expect(screen.getByRole('checkbox', { name: 'Accept change to new_group' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Accept change to new_child' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept change to new_child' }))
    expect(screen.getByText('new_child')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))

    expect(onNodesChange.mock.calls[0][0]).toEqual([
      ...nodes,
      expect.objectContaining({ name: 'new_group', children: [] }),
    ])
  })

  it('rejects dependent additions with their parent and disables a no-op apply', async () => {
    const onNodesChange = renderPanel()
    await send({
      status: 'proposed',
      fields: {
        title: { name: 'title', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [
        { path: ['new_group'], type: 'object' },
        { path: ['new_group', 'new_child'], type: 'string' },
      ],
      issues: [],
    })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept change to new_group' }))

    expect(screen.getByRole('checkbox', { name: 'Accept change to new_group' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Accept change to new_child' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled()
    expect(onNodesChange).not.toHaveBeenCalled()
  })

  it('expands ancestors so a nested before-and-after change is visible', async () => {
    renderPanel(vi.fn(), [{
      id: 'root',
      name: 'root',
      type: 'object',
      children: [{
        id: 'group',
        name: 'group',
        type: 'object',
        children: [{ id: 'leaf', name: 'leaf', type: 'string' }],
      }],
    }])

    await send({
      status: 'proposed',
      fields: {
        root: { name: 'root', type: 'object', removed: false },
        group: { name: 'group', type: 'object', removed: false },
        leaf: { name: 'renamed_leaf', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    expect(screen.getByText('leaf')).toBeInTheDocument()
    expect(screen.getByText('renamed_leaf')).toBeInTheDocument()
  })

  it('reveals the contents of a removed nested group', async () => {
    renderPanel(vi.fn(), [{
      id: 'root',
      name: 'root',
      type: 'object',
      children: [{
        id: 'group',
        name: 'group',
        type: 'object',
        description: 'Research rule',
        children: [{ id: 'leaf', name: 'leaf', type: 'string' }],
      }],
    }])

    await send({
      status: 'proposed',
      fields: {
        root: { name: 'root', type: 'object', removed: false },
        group: { name: 'group', type: 'object', removed: true },
        leaf: { name: 'leaf', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    expect(screen.getByText('leaf')).toBeInTheDocument()
  })

  it('reveals the contents of a container-to-scalar change that will delete nested fields', async () => {
    renderPanel(vi.fn(), [{
      id: 'group',
      name: 'group',
      type: 'object',
      children: [{ id: 'leaf', name: 'leaf', type: 'string' }],
    }])

    await send({
      status: 'proposed',
      fields: {
        group: { name: 'group', type: 'string', removed: false },
        leaf: { name: 'leaf', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    expect(screen.getByText('leaf')).toBeInTheDocument()
  })

  it('discards the proposal without changing the schema', async () => {
    const onNodesChange = renderPanel()
    await send({
      status: 'proposed',
      fields: {
        title: { name: 'heading', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument())
    expect(screen.getByText('title')).toBeInTheDocument()
    expect(onNodesChange).not.toHaveBeenCalled()
  })

  it('discards a chat response when the schema changed while the request was running', async () => {
    let resolveResponse!: (response: SchemaEditResponse) => void
    requestSchemaEdit.mockReturnValueOnce(new Promise<SchemaEditResponse>((resolve) => {
      resolveResponse = resolve
    }))
    const onNodesChange = renderPanel()
    const chatInput = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(chatInput, { target: { value: 'Check fields' } })
    fireEvent.keyDown(chatInput, { key: 'Enter' })

    fireEvent.click(screen.getByTitle('Edit title'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'heading' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await act(async () => resolveResponse({
      status: 'proposed',
      fields: {
        title: { name: 'title', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    }))

    expect(await screen.findByText('Schema changed while the request was running. Send the request again.')).toBeInTheDocument()
    expect(screen.getByText('heading')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
    expect(onNodesChange.mock.calls[0][0]).toEqual([{ ...nodes[0], name: 'heading' }, nodes[1]])
  })

  it.each([
    [{ status: 'refused', message: 'Duplicate field paths: title' } as const, 'Request refused: Duplicate field paths: title'],
    [{ status: 'failed', message: 'Schema edit generation failed.' } as const, 'Request failed: Schema edit generation failed.'],
    [{
      status: 'proposed',
      fields: {
        title: { name: 'title', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    } as const, 'Proposal checked every field: 0 changes proposed.'],
  ])('reports non-review outcome without inventing intent', async (response, message) => {
    renderPanel()
    requestSchemaEdit.mockResolvedValueOnce(response)
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Check fields' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
  })
})

describe('SchemaPanel clear current schema', () => {
  it('requires confirmation before resetting the schema', () => {
    const onResetSchema = vi.fn()
    renderPanel(vi.fn(), nodes, onResetSchema)

    fireEvent.click(screen.getByRole('button', { name: 'Clear current schema' }))
    expect(screen.getByText('Clear current schema?')).toBeInTheDocument()
    expect(onResetSchema).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Clear current schema?')).not.toBeInTheDocument()
    expect(onResetSchema).not.toHaveBeenCalled()
  })

  it('clears local schema state after the workspace accepts the reset', async () => {
    const onResetSchema = vi.fn()
    renderPanel(vi.fn(), nodes, onResetSchema)

    fireEvent.click(screen.getByRole('button', { name: 'Clear current schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear schema' }))

    expect(onResetSchema).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByText('Clear current schema?')).not.toBeInTheDocument())
    expect(screen.queryByText(nodes[0].name)).not.toBeInTheDocument()
  })

  it('keeps the editor when the workspace cannot flush the schema', async () => {
    const onResetSchema = vi.fn(async () => {
      throw new Error('The Current Schema Revision has changed.')
    })
    renderPanel(vi.fn(), nodes, onResetSchema)

    fireEvent.click(screen.getByRole('button', { name: 'Clear current schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear schema' }))

    await waitFor(() => expect(onResetSchema).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Clear current schema?')).toBeInTheDocument()
    expect(screen.getByTitle('Edit title')).toBeInTheDocument()
  })
})
