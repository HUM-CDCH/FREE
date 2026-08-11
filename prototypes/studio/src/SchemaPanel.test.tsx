// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaEditResponse } from '../shared/schemaEdit.contract'
import type { SchemaRevision, SchemaRevisionSummary } from '../shared/schemaRevision.contract'
import { nodesToTemplate, type SchemaNode } from '../shared/schemaNode'
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

function renderPanel(onNodesChange = vi.fn(), panelNodes = nodes) {
  render(<SchemaPanel
    state={{ status: 'ready', recordDescription: 'One test record.', nodes: panelNodes, inputsKey: 'test' }}
    stale={false}
    onGenerate={vi.fn()}
    onNodesChange={onNodesChange}
    onRecordDescriptionChange={vi.fn()}
    beforeSchemaEdit={vi.fn()}
    history={[]}
    loadRevision={vi.fn()}
    annotationCount={0}
    annotationsMode="hints"
    onAnnotationsModeChange={vi.fn()}
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
    stale={false}
    onGenerate={vi.fn()}
    onNodesChange={onNodesChange}
    onRecordDescriptionChange={vi.fn()}
    beforeSchemaEdit={beforeSchemaEdit}
    annotationCount={0}
    annotationsMode="hints"
    onAnnotationsModeChange={vi.fn()}
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

  it('keeps an inline edit open when its name duplicates a sibling field', () => {
    const onNodesChange = renderPanel()

    fireEvent.click(screen.getByTitle('Edit title'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'gender' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByRole('alert')).toHaveTextContent('A sibling field already uses “gender”.')
    expect(screen.getByDisplayValue('gender')).toBeInTheDocument()
    expect(onNodesChange).not.toHaveBeenCalled()
  })

  it('keeps an existing closed set when replacement values are invalid', () => {
    const onNodesChange = renderPanel()

    fireEvent.click(screen.getByTitle('Edit gender'))
    fireEvent.change(screen.getByLabelText('Allowed values'), { target: { value: 'string, date' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Enter at least two values that are not field-type names.')
    expect(screen.getByDisplayValue('string, date')).toBeInTheDocument()
    expect(onNodesChange).not.toHaveBeenCalled()
  })

  it.each([
    ['blank input clears it', '', undefined],
    ['valid input replaces it', 'known, unknown', ['known', 'unknown']],
  ])('%s for an existing closed set', (_case, value, allowedValues) => {
    const onNodesChange = renderPanel()

    fireEvent.click(screen.getByTitle('Edit gender'))
    fireEvent.change(screen.getByLabelText('Allowed values'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onNodesChange.mock.calls[0][0][1]).toEqual({
      id: 'gender',
      name: 'gender',
      type: 'string',
      ...(allowedValues && { allowedValues }),
    })
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

    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('0 applied · 0 unresolved · 1 conflicts')
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

    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('2 applied · 1 unresolved · 1 conflicts')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('3 accepted · 0 rejected')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('missing: unreturned')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('unknown-key: missing.child')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('Metadata not directly editable by chat: 1 description · 1 allowed-value list')
    expect(screen.getAllByText('heading')).toHaveLength(1)
    expect(screen.getAllByText('title')).toHaveLength(1)
    expect(screen.getByText('number')).toBeInTheDocument()
    expect(input).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept change to heading' }))

    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('2 accepted · 1 rejected')
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
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('0 applied')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('1 unresolved')
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

    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('1 accepted · 0 rejected')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('0 applied · 1 unresolved')
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled()
  })

  it('omits the metadata summary when the original schema has none', async () => {
    renderPanel(vi.fn(), [{ id: 'name', name: 'name', type: 'string' }])
    await send({
      status: 'proposed',
      fields: { name: { name: 'heading', type: 'string', removed: false } },
      additions: [],
      issues: [],
    })

    expect(screen.getByTestId('schema-proposal-summary')).not.toHaveTextContent('Metadata not directly editable by chat')
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
        'root.group': { name: 'group', type: 'object', removed: false },
        'root.group.leaf': { name: 'renamed_leaf', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    expect(screen.getByText('leaf')).toBeInTheDocument()
    expect(screen.getByText('renamed_leaf')).toBeInTheDocument()
  })

  it('reveals the contents and losses of a removed nested group', async () => {
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
        'root.group': { name: 'group', type: 'object', removed: true },
        'root.group.leaf': { name: 'leaf', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    expect(screen.getByText('leaf')).toBeInTheDocument()
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('Metadata not directly editable by chat: 1 description · 0 allowed-value lists')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('Removing this field also removes its description and its nested fields.')
  })

  it('shows nested fields that a container-to-scalar change will delete', async () => {
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
        'group.leaf': { name: 'leaf', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    expect(screen.getByText('leaf')).toBeInTheDocument()
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('Retyping across the container boundary removed its nested fields.')
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
