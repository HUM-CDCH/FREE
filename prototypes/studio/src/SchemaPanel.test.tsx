// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaEditResponse } from '../shared/schemaEdit.contract'
import type { SchemaNode } from '../shared/schemaNode'
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

function renderPanel(onNodesChange = vi.fn(), initialNodes = nodes) {
  render(<SchemaPanel
    state={{ status: 'ready', nodes: initialNodes, inputsKey: 'test' }}
    stale={false}
    onGenerate={vi.fn()}
    onNodesChange={onNodesChange}
    annotationCount={0}
    annotationsMode="hints"
    onAnnotationsModeChange={vi.fn()}
    documentMarkdown={null}
  />)
  return onNodesChange
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
  vi.clearAllMocks()
})

describe('SchemaPanel schema proposal review', () => {
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

    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('0 applied · 1 unresolved')
    expect(screen.getByText('Unresolved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))

    expect(onNodesChange).toHaveBeenCalledWith(original, '✦ Schema updated via chat')
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

    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('1 applied · 1 unresolved · 1 conflicts')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('3 accepted · 0 rejected')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('1 missing')
    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent("1 description and 1 allowed-value list were not changed — chat edits don't change these.")
    expect(screen.getAllByText('heading')).toHaveLength(1)
    expect(screen.queryByText('title')).not.toBeInTheDocument()
    expect(input).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept change to heading' }))

    expect(screen.getByTestId('schema-proposal-summary')).toHaveTextContent('2 accepted · 1 rejected')
    expect(screen.getAllByText('heading')).toHaveLength(1)
    expect(screen.queryByText('title')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))

    expect(onNodesChange).toHaveBeenCalledTimes(1)
    expect(onNodesChange.mock.calls[0][0]).toEqual([
      nodes[0],
      { id: 'gender', name: 'sex', type: 'string', allowedValues: ['woman', 'man'] },
    ])
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
