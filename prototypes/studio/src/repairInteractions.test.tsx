// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ResultsTab from './ResultsTab'
import SchemaPanel from './SchemaPanel'
import { burialFindsPinnedSchema, pinnedSchemas } from './pinnedSchemas'
import { templateToNodes } from './schemaNode'
import { customizePinnedSchemaState, schemaMetadata } from './schemaState'
import type { SchemaOp } from './schemaOps'

const { requestSchemaEditMock } = vi.hoisted(() => ({ requestSchemaEditMock: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), requestSchemaEdit: requestSchemaEditMock }))

afterEach(() => {
  cleanup()
  requestSchemaEditMock.mockReset()
})

describe('post-merge interactions', () => {
  it('keeps pinned schemas immutable until Customize is explicit', async () => {
    const onCustomize = vi.fn()
    render(<SchemaPanel
      state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: templateToNodes(burialFindsPinnedSchema.schema.record), inputsKey: '', source: 'pinned', pinnedSchemaId: burialFindsPinnedSchema.id }}
      stale={false} pinnedSchemas={pinnedSchemas} selectedPinnedSchemaId={burialFindsPinnedSchema.id}
      onSelectPinnedSchema={vi.fn()} onGenerate={vi.fn()} onCustomize={onCustomize} onNodesChange={vi.fn()}
      annotationCount={0} annotationsMode="hints" onAnnotationsModeChange={vi.fn()}
    />)
    expect(screen.queryByText('+ Add field')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Customize this schema' }))
    expect(onCustomize).toHaveBeenCalledOnce()
  })

  it('creates a detached custom state with pinned provenance', () => {
    const pinned = { status: 'ready' as const, schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: templateToNodes(burialFindsPinnedSchema.schema.record), inputsKey: '', source: 'pinned' as const, pinnedSchemaId: burialFindsPinnedSchema.id }
    const custom = customizePinnedSchemaState(pinned)
    expect(custom).toMatchObject({ status: 'ready', source: 'custom', basePinnedSchemaId: burialFindsPinnedSchema.id })
    expect(custom).not.toBe(pinned)
    if (custom.status === 'ready') expect(custom.nodes).not.toBe(pinned.nodes)
  })

  it('drills one level, returns to Results, and preserves Forward', async () => {
    const controller = {
      state: { status: 'ready' as const, result: { group: { nested: { value: 'duplicate' }, sibling: 'duplicate' } }, warnings: [] },
      canRun: true, hasResults: true, strategy: 'article' as const, setStrategy: vi.fn(), runExtraction: vi.fn(),
    }
    render(<ResultsTab controller={controller} schemaReady documentMarkdown="# Canonical source" />)
    await userEvent.click(screen.getByText('group'))
    expect(screen.getByText('nested')).toBeTruthy()
    expect(screen.queryByText('value')).toBeNull()
    await userEvent.click(screen.getByTitle('Back'))
    expect(screen.getByTitle('Forward')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(screen.getByText('# Canonical source')).toBeTruthy()
  })

  it('preserves earlier Back history after jumping to a breadcrumb ancestor', async () => {
    const controller = {
      state: { status: 'ready' as const, result: { section: { subgroup: { value: 'nested' } } }, warnings: [] },
      canRun: true, hasResults: true, strategy: 'article' as const, setStrategy: vi.fn(), runExtraction: vi.fn(),
    }
    render(<ResultsTab controller={controller} schemaReady documentMarkdown={null} />)
    await userEvent.click(screen.getByText('section'))
    await userEvent.click(screen.getByText('subgroup'))
    await userEvent.click(screen.getByRole('button', { name: 'section' }))

    expect(screen.getByText('subgroup')).toBeTruthy()
    await userEvent.click(screen.getByTitle('Back'))
    expect(screen.getByText('section')).toBeTruthy()
    expect(screen.queryByText('subgroup')).toBeNull()
  })

  it('remembers an edited value across direct ancestor and Forward navigation', async () => {
    const controller = { state: { status: 'ready' as const, result: { group: { title: 'before' } }, warnings: [] }, canRun: true, hasResults: true, strategy: 'article' as const, setStrategy: vi.fn(), runExtraction: vi.fn() }
    render(<ResultsTab controller={controller} schemaReady documentMarkdown={null} />)
    await userEvent.click(screen.getByText('group'))
    await userEvent.click(screen.getByTitle('Edit title'))
    const input = screen.getByDisplayValue('before')
    await userEvent.clear(input)
    await userEvent.type(input, 'after{Enter}')
    await userEvent.click(screen.getByRole('button', { name: 'Results' }))
    await userEvent.click(screen.getByTitle('Forward'))
    expect(screen.getByText('after')).toBeTruthy()
  })

  it('shows an unavailable state when canonical Markdown is missing', async () => {
    const controller = { state: { status: 'ready' as const, result: { title: 'result' }, warnings: [] }, canRun: true, hasResults: true, strategy: 'article' as const, setStrategy: vi.fn(), runExtraction: vi.fn() }
    render(<ResultsTab controller={controller} schemaReady documentMarkdown={null} />)
    await userEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(screen.getByRole('status').textContent).toBe('Source Markdown is unavailable for this document.')
  })

  it('uses and removes suggestion chips, then applies and discards previews', async () => {
    requestSchemaEditMock.mockResolvedValueOnce([{ op: 'add', name: 'year', type: 'date' }]).mockResolvedValueOnce([{ op: 'remove', name: 'title' }])
    const onNodesChange = vi.fn()
    render(<SchemaPanel state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: [{ id: 'title', name: 'title', type: 'string' }], inputsKey: 'generated', source: 'generated' }} stale={false} pinnedSchemas={pinnedSchemas} selectedPinnedSchemaId={null} onSelectPinnedSchema={vi.fn()} onGenerate={vi.fn()} onCustomize={vi.fn()} onNodesChange={onNodesChange} annotationCount={0} annotationsMode="hints" onAnnotationsModeChange={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add a field' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply changes' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Add a field' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Apply changes' }))
    expect(onNodesChange).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Remove a field' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onNodesChange).toHaveBeenCalledOnce()
  })

  it('renames and retypes a nested field inline', async () => {
    const onNodesChange = vi.fn()
    render(<SchemaPanel state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: [{ id: 'group', name: 'group', type: 'object', children: [{ id: 'leaf', name: 'leaf', type: 'string' }] }], inputsKey: 'custom', source: 'custom' }} stale={false} pinnedSchemas={pinnedSchemas} selectedPinnedSchemaId={null} onSelectPinnedSchema={vi.fn()} onGenerate={vi.fn()} onCustomize={vi.fn()} onNodesChange={onNodesChange} annotationCount={0} annotationsMode="hints" onAnnotationsModeChange={vi.fn()} />)
    await userEvent.click(screen.getByTitle('Edit leaf'))
    const name = screen.getByDisplayValue('leaf')
    await userEvent.clear(name)
    await userEvent.type(name, 'published year')
    await userEvent.selectOptions(screen.getByLabelText('Field type'), 'integer')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onNodesChange.mock.calls[0]?.[0][0].children[0]).toMatchObject({ name: 'published_year', type: 'integer' })
  })

  it('invalidates an in-flight chat edit when the schema identity changes', async () => {
    let resolveEdit!: (ops: SchemaOp[]) => void
    let requestSignal!: AbortSignal
    requestSchemaEditMock.mockImplementationOnce((_nodes: unknown, _instruction: string, signal: AbortSignal) => {
      requestSignal = signal
      return new Promise<SchemaOp[]>(resolve => { resolveEdit = resolve })
    })
    const props = { stale: false, pinnedSchemas, selectedPinnedSchemaId: null, onSelectPinnedSchema: vi.fn(), onGenerate: vi.fn(), onCustomize: vi.fn(), onNodesChange: vi.fn(), annotationCount: 0, annotationsMode: 'hints' as const, onAnnotationsModeChange: vi.fn() }
    const view = render(<SchemaPanel {...props} state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: [{ id: 'old', name: 'old_field', type: 'string' }], inputsKey: 'old-schema', source: 'generated' }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Add a field' }))
    await waitFor(() => expect(requestSignal).toBeDefined())
    view.rerender(<SchemaPanel {...props} state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: [{ id: 'new', name: 'replacement_field', type: 'string' }], inputsKey: 'new-schema', source: 'generated' }} />)
    await waitFor(() => expect(requestSignal.aborted).toBe(true))

    await act(async () => { resolveEdit([{ op: 'add', name: 'stale_field', type: 'string' }]) })
    expect(screen.queryByRole('button', { name: 'Apply changes' })).toBeNull()
    expect(screen.getByText('replacement_field')).toBeTruthy()
    expect(props.onNodesChange).not.toHaveBeenCalled()
  })

  it('drags a scalar field into a group', () => {
    const onNodesChange = vi.fn()
    render(<SchemaPanel state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: [
      { id: 'notes', name: 'notes', type: 'string' },
      { id: 'metadata', name: 'metadata', type: 'object', children: [] },
    ], inputsKey: 'custom', source: 'custom' }} stale={false} pinnedSchemas={pinnedSchemas} selectedPinnedSchemaId={null} onSelectPinnedSchema={vi.fn()} onGenerate={vi.fn()} onCustomize={vi.fn()} onNodesChange={onNodesChange} annotationCount={0} annotationsMode="hints" onAnnotationsModeChange={vi.fn()} />)

    const notesRow = screen.getByText('notes').parentElement
    const metadataRow = screen.getByText('metadata').parentElement
    const dragHandle = notesRow?.querySelector('.cursor-grab')
    expect(dragHandle).toBeTruthy()
    expect(metadataRow).toBeTruthy()

    fireEvent.mouseDown(dragHandle as Element, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 10, clientY: 30 })
    fireEvent.mouseEnter(metadataRow as Element)
    fireEvent.mouseUp(window)

    expect(onNodesChange).toHaveBeenCalledOnce()
    expect(onNodesChange.mock.calls[0]?.[0]).toEqual([
      { id: 'metadata', name: 'metadata', type: 'object', children: [{ id: 'notes', name: 'notes', type: 'string' }] },
    ])
  })

  it('does not treat a scalar row as a group drop target', () => {
    const onNodesChange = vi.fn()
    render(<SchemaPanel state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: [
      { id: 'title', name: 'title', type: 'string' },
      { id: 'notes', name: 'notes', type: 'string' },
    ], inputsKey: 'scalar-target', source: 'custom' }} stale={false} pinnedSchemas={pinnedSchemas} selectedPinnedSchemaId={null} onSelectPinnedSchema={vi.fn()} onGenerate={vi.fn()} onCustomize={vi.fn()} onNodesChange={onNodesChange} annotationCount={0} annotationsMode="hints" onAnnotationsModeChange={vi.fn()} />)

    const notesRow = screen.getByText('notes').parentElement
    const titleRow = screen.getByText('title').parentElement
    const dragHandle = notesRow?.querySelector('.cursor-grab')
    fireEvent.mouseDown(dragHandle as Element, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 10, clientY: 40 })
    fireEvent.mouseEnter(titleRow as Element)
    fireEvent.mouseUp(window)

    expect(onNodesChange).not.toHaveBeenCalled()
    expect(screen.queryByText('into title')).toBeNull()
  })

  it('indents a leaf only into a preceding group and outdents it again', () => {
    const onNodesChange = vi.fn()
    const props = { stale: false, pinnedSchemas, selectedPinnedSchemaId: null, onSelectPinnedSchema: vi.fn(), onGenerate: vi.fn(), onCustomize: vi.fn(), onNodesChange, annotationCount: 0, annotationsMode: 'hints' as const, onAnnotationsModeChange: vi.fn() }
    const view = render(<SchemaPanel {...props} state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: [
      { id: 'metadata', name: 'metadata', type: 'object', children: [] },
      { id: 'notes', name: 'notes', type: 'string' },
    ], inputsKey: 'indent', source: 'custom' }} />)

    const panel = within(view.container)
    const notesHandle = panel.getByText('notes').parentElement?.querySelector('.cursor-grab')
    fireEvent.mouseDown(notesHandle as Element, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 70, clientY: 10 })
    fireEvent.mouseUp(window)
    expect(onNodesChange.mock.calls[0]?.[0]).toEqual([
      { id: 'metadata', name: 'metadata', type: 'object', children: [{ id: 'notes', name: 'notes', type: 'string' }] },
    ])

    view.rerender(<SchemaPanel {...props} state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: onNodesChange.mock.calls[0][0], inputsKey: 'outdent', source: 'custom' }} />)
    const nestedHandle = panel.getByText('notes').parentElement?.querySelector('.cursor-grab')
    fireEvent.mouseDown(nestedHandle as Element, { button: 0, clientX: 70, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 10, clientY: 10 })
    fireEvent.mouseUp(window)
    expect(onNodesChange.mock.calls[1]?.[0]).toEqual([
      { id: 'metadata', name: 'metadata', type: 'object', children: [] },
      { id: 'notes', name: 'notes', type: 'string' },
    ])
  })

  it('ignores horizontal indent into a scalar and group nesting', () => {
    const onNodesChange = vi.fn()
    const view = render(<SchemaPanel state={{ status: 'ready', schema: schemaMetadata(burialFindsPinnedSchema.schema), nodes: [
      { id: 'title', name: 'title', type: 'string' },
      { id: 'notes', name: 'notes', type: 'string' },
      { id: 'metadata', name: 'metadata', type: 'object', children: [] },
    ], inputsKey: 'invalid-indent', source: 'custom' }} stale={false} pinnedSchemas={pinnedSchemas} selectedPinnedSchemaId={null} onSelectPinnedSchema={vi.fn()} onGenerate={vi.fn()} onCustomize={vi.fn()} onNodesChange={onNodesChange} annotationCount={0} annotationsMode="hints" onAnnotationsModeChange={vi.fn()} />)

    const panel = within(view.container)
    for (const name of ['notes', 'metadata']) {
      const handle = panel.getByText(name).parentElement?.querySelector('.cursor-grab')
      fireEvent.mouseDown(handle as Element, { button: 0, clientX: 10, clientY: 10 })
      fireEvent.mouseMove(window, { clientX: 70, clientY: 10 })
      fireEvent.mouseUp(window)
    }
    expect(onNodesChange).not.toHaveBeenCalled()
  })
})
