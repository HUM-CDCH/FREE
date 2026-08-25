// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaEditResponse } from '../shared/schemaEdit.contract'
import type { SchemaRevision, SchemaRevisionSummary } from '../shared/schemaRevision.contract'
import { nodesToTemplate, type SchemaNode } from 'extraction/schema'
import SchemaPanel from './SchemaPanel'
import type { SchemaModelContext } from './api'
import {
  createSchemaEditorController,
  type SchemaEditorController,
  type SchemaEditorPersistence,
} from './currentSchemaRevision'
import type {
  AcknowledgedSchemaRevision,
  SchemaSaveState,
} from './schemaSaveCoordinator'
const { requestSchemaEdit } = vi.hoisted(() => ({ requestSchemaEdit: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  requestSchemaEdit,
}))

const nodes: SchemaNode[] = [
  { id: 'title', name: 'title', type: 'string', description: 'Research rule' },
  { id: 'gender', name: 'gender', type: 'string', allowedValues: ['woman', 'man'] },
]

const modelContext: SchemaModelContext = {
  projectContextId: '51000000-0000-4000-8000-000000000001',
  sourceRepresentationRevisionId:
    '51000000-0000-4000-8002-000000000001',
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  schemaRevisionId: '51000000-0000-4000-8004-000000000002',
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

type PanelSetup = {
  schema: SchemaEditorController
  /** Every committed draft, in order — the module's edit() calls. */
  edits: Array<{ recordDescription: string; schemaNodes: SchemaNode[] }>
  /** Ordered gate events: load / flush / edit. */
  events: string[]
}

function setupController({
  panelNodes = nodes,
  recordDescription = 'One test record.',
  currentRevisionNumber = 2,
  getRevision,
  flushImpl,
}: {
  panelNodes?: SchemaNode[]
  recordDescription?: string
  currentRevisionNumber?: number
  getRevision?: (schemaRevisionId: string) => Promise<SchemaRevision>
  flushImpl?: (call: number) => Promise<SchemaRevision | null>
} = {}): PanelSetup {
  const acknowledged: AcknowledgedSchemaRevision = {
    schemaRevisionId: '51000000-0000-4000-8004-000000000002',
    extractionSchemaId: '51000000-0000-4000-8003-000000000001',
    revisionNumber: currentRevisionNumber,
    recordDescription,
    schemaNodes: panelNodes,
  }
  const edits: PanelSetup['edits'] = []
  const events: string[] = []
  let flushCalls = 0
  const persistence: SchemaEditorPersistence = {
    extractionSchemaId: () => acknowledged.extractionSchemaId,
    initialize: async () => {
      throw new Error('Generation is not exercised here.')
    },
    edit(definition) {
      edits.push(definition)
      events.push('edit')
    },
    async flush() {
      events.push('flush')
      flushCalls += 1
      if (flushImpl) return flushImpl(flushCalls)
      const latest = edits.at(-1)
      return latest
        ? {
            ...acknowledged,
            revisionNumber: acknowledged.revisionNumber + edits.length,
            ...latest,
          }
        : acknowledged
    },
    saveState() {
      return null
    },
    modelContext: () => modelContext,
    listRevisions: async () => schemaHistory,
    getRevision: async (schemaRevisionId) => {
      events.push('load')
      if (getRevision) return getRevision(schemaRevisionId)
      return {
        ...schemaHistory[1],
        recordDescription: 'One historical record.',
        schemaNodes: historicalNodes,
      }
    },
    onChange: () => () => {},
    dispose: () => {},
  }
  const schema = createSchemaEditorController(persistence, {
    initialDraft: { recordDescription, schemaNodes: panelNodes },
    initialRevisionNumber: currentRevisionNumber,
    initialExtractableRevisionId: acknowledged.schemaRevisionId,
    initialHistory: schemaHistory,
  })
  return { schema, edits, events }
}

function renderPanel(
  setupOptions: Parameters<typeof setupController>[0] = {},
  renderProps: Partial<React.ComponentProps<typeof SchemaPanel>> = {},
): PanelSetup {
  const setup = setupController(setupOptions)
  render(<SchemaPanel
    schema={setup.schema}
    onClearDraft={() => setup.schema.reset()}
    sourceDocumentName="test.pdf"
    {...renderProps}
  />)
  return setup
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
    const setup = renderPanel({}, { schemaName: 'Places', onRenameSchema })

    fireEvent.click(screen.getByRole('button', { name: 'Rename schema Places' }))
    fireEvent.change(screen.getByLabelText('Schema name for Places'), {
      target: { value: 'Historic places' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save schema name' }))

    await waitFor(() =>
      expect(onRenameSchema).toHaveBeenCalledWith('Historic places'),
    )
    expect(setup.edits).toHaveLength(0)
  })

  it('omits unchanged types from a rename-only diff row', async () => {
    const setup = renderPanel()
    await send({
      status: 'proposed',
      fields: {
        title: { name: 'heading', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })
    expect(requestSchemaEdit).toHaveBeenCalledWith(
      modelContext,
      'Update fields',
      expect.any(AbortSignal),
    )

    const row = screen.getByText('title').parentElement!
    expect(within(row).queryAllByText('string')).toHaveLength(0)
    expect(setup.edits).toHaveLength(0)
  })

  it('previews history read-only and appends only after the explicit create action', async () => {
    const loadRevision = vi.fn(async () => ({
      ...schemaHistory[1],
      recordDescription: 'One historical record.',
      schemaNodes: historicalNodes,
    }))
    const setup = renderPanel({ getRevision: loadRevision })

    const chatHeader = screen.getByText('Chat').parentElement!
    fireEvent.click(within(chatHeader).getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByText('historical_place')).toBeInTheDocument()

    expect(setup.events).toEqual(['load'])
    expect(setup.edits).toHaveLength(0)
    expect(loadRevision).toHaveBeenCalledWith('51000000-0000-4000-8004-000000000001')
    expect(screen.queryByRole('button', { name: '+ Add field' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Create Current Schema Revision' }),
    )
    await waitFor(() => expect(setup.edits).toHaveLength(1))
    expect(setup.events).toEqual(['load', 'flush', 'edit', 'flush'])
    expect(setup.edits[0]).toEqual({
      recordDescription: 'One historical record.',
      schemaNodes: historicalNodes,
    })
    expect(screen.getByText('historical_year')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add field' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Revision 1/ })).not.toBeInTheDocument()
  })

  it('keeps the current fields usable while regeneration is pending and after failure', async () => {
    const setup = renderPanel()
    let rejectGeneration!: (reason: Error) => void
    const request = new Promise<unknown>((_resolve, reject) => {
      rejectGeneration = reject
    })
    let generation!: Promise<void>

    act(() => {
      generation = setup.schema.generate(() => request)
    })

    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'The current saved schema remains available.',
    )
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled()

    await act(async () => {
      rejectGeneration(new Error('Model unavailable'))
      await generation
    })

    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Regeneration failed: Model unavailable The current saved schema is unchanged.',
    )
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled()
  })

  it('regenerates from instructions edited in the compact popover', () => {
    const onGenerateInstructions = vi.fn()
    renderPanel({}, { showRegenerate: true, onGenerateInstructions })

    const regenerate = screen.getByRole('button', { name: 'Regenerate' })
    fireEvent.click(regenerate)

    const instruction = screen.getByPlaceholderText(/Add a generation instruction/)
    fireEvent.change(instruction, { target: { value: 'Focus on dates' } })
    fireEvent.keyDown(instruction, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: /Regenerate schema/ }))

    expect(onGenerateInstructions).toHaveBeenCalledWith('Focus on dates')
    expect(regenerate).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByPlaceholderText(/Add a generation instruction/)).not.toBeInTheDocument()
  })

  it('resets stale JSON when an external draft replaces the editor payload', async () => {
    const setup = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const jsonEditor = screen.getAllByRole('textbox')[0]
    expect((jsonEditor as HTMLTextAreaElement).value).toContain('"title"')

    act(() => {
      setup.schema.adoptDraft({
        recordDescription: 'One replacement record.',
        schemaNodes: historicalNodes,
      })
    })

    await waitFor(() => expect(jsonEditor).not.toBeInTheDocument())
    expect(screen.getByText('historical_place')).toBeVisible()
  })

  it('resets an uncommitted description on same-value external replacement', async () => {
    const setup = renderPanel()
    const description = screen.getByPlaceholderText(
      'Describe the record represented by this schema…',
    )
    fireEvent.change(description, { target: { value: 'Uncommitted text' } })

    act(() => {
      setup.schema.adoptDraft({
        recordDescription: 'One test record.',
        schemaNodes: historicalNodes,
      })
    })

    await waitFor(() =>
      expect(description).toHaveValue('One test record.'),
    )
  })

  it('closes history without loading or flushing the current revision', () => {
    const getRevision = vi.fn()
    const setup = renderPanel({ getRevision })

    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 2/ }))

    expect(getRevision).not.toHaveBeenCalled()
    expect(setup.events).not.toContain('flush')
    expect(setup.events).not.toContain('edit')
    expect(screen.queryByRole('button', { name: /Revision 2/ })).not.toBeInTheDocument()
  })

  it('keeps the current schema when loading or pre-creation flushing fails', async () => {
    const loadRevision = vi.fn(async () => { throw new Error('Load failed') })
    const setup = renderPanel({ getRevision: loadRevision })

    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed')
    expect(setup.events).toEqual(['load'])
    expect(setup.edits).toHaveLength(0)
    expect(screen.getByText('title')).toBeInTheDocument()

    cleanup()
    const failingSetup = renderPanel({
      flushImpl: async () => { throw new Error('Save current failed') },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    await screen.findByText('historical_place')
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Current Schema Revision' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Save current failed')
    expect(failingSetup.events).toEqual(['load', 'flush'])
    expect(failingSetup.edits).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(screen.getByText('title')).toBeInTheDocument()
  })

  it('keeps the historical editable tree when its append flush fails', async () => {
    let flushCalls = 0
    const setup = renderPanel({
      flushImpl: async () => {
        flushCalls += 1
        if (flushCalls === 1) return null
        throw new Error('Append failed')
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    await screen.findByText('historical_place')
    fireEvent.click(
      screen.getByRole('button', { name: 'Create Current Schema Revision' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Append failed')
    expect(setup.edits).toHaveLength(1)
    expect(setup.edits[0]).toEqual({
      recordDescription: 'One historical record.',
      schemaNodes: historicalNodes,
    })
    expect(screen.getByText('historical_place')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Add field' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(screen.getByText('title')).toBeInTheDocument()
  })

  it('applies an inline edit at arbitrary nesting depth', () => {
    const setup = renderPanel({ panelNodes: [{
      id: 'root',
      name: 'root',
      type: 'object',
      children: [{
        id: 'group',
        name: 'group',
        type: 'object',
        children: [{ id: 'leaf', name: 'leaf', type: 'string' }],
      }],
    }] })

    fireEvent.click(screen.getByText('group').parentElement!.querySelector('polygon')!.closest('span')!)
    fireEvent.click(screen.getByTitle('Edit leaf'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'renamed leaf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(setup.edits[0].schemaNodes[0].children![0].children![0].name).toBe('renamed_leaf')
    expect(screen.getByText('renamed_leaf')).toBeInTheDocument()
  })

  it.each(['Escape', 'Cancel field edit'])(
    'keeps a new field provisional when dismissed with %s',
    (dismissal) => {
      const setup = renderPanel()

      fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
      expect(screen.getByDisplayValue('nyt_felt')).toBeInTheDocument()

      if (dismissal === 'Escape') {
        fireEvent.keyDown(screen.getByDisplayValue('nyt_felt'), {
          key: 'Escape',
        })
      } else {
        fireEvent.click(
          screen.getByRole('button', { name: 'Cancel field edit' }),
        )
      }

      expect(screen.queryByDisplayValue('nyt_felt')).not.toBeInTheDocument()
      expect(screen.queryByText('nyt_felt')).not.toBeInTheDocument()
      expect(setup.edits).toHaveLength(0)
      expect(setup.schema.snapshot().draft?.schemaNodes).toEqual(nodes)
    },
  )

  it('commits a provisional field only when Save is activated', () => {
    const setup = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    fireEvent.change(screen.getByDisplayValue('nyt_felt'), {
      target: { value: 'published field' },
    })
    expect(setup.edits).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(setup.edits).toHaveLength(1)
    expect(setup.edits[0].schemaNodes.at(-1)?.name).toBe('published_field')
    expect(screen.getByText('published_field')).toBeInTheDocument()
  })

  it('commits a provisional field with Enter and cancels existing edits without writing', () => {
    const setup = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    fireEvent.change(screen.getByDisplayValue('nyt_felt'), {
      target: { value: 'entered field' },
    })
    fireEvent.keyDown(screen.getByDisplayValue('entered field'), {
      key: 'Enter',
    })

    expect(setup.edits).toHaveLength(1)
    expect(screen.getByText('entered_field')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('Edit title'))
    fireEvent.change(screen.getByDisplayValue('title'), {
      target: { value: 'discarded name' },
    })
    fireEvent.keyDown(screen.getByDisplayValue('discarded name'), {
      key: 'Escape',
    })

    expect(setup.edits).toHaveLength(1)
    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.queryByText('discarded_name')).not.toBeInTheDocument()
  })

  it('shows field types and lets an editor change them', () => {
    const setup = renderPanel()

    expect(screen.getAllByTitle('Type: string — click to edit')).toHaveLength(2)
    fireEvent.click(screen.getByTitle('Edit title'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Field type' }), { target: { value: 'number' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(setup.edits[0].schemaNodes[0]).toEqual({
      id: 'title',
      name: 'title',
      type: 'number',
      description: 'Research rule',
    })
    expect(screen.getByTitle('Type: number — click to edit')).toBeInTheDocument()
  })

  it('lets an editor change an array item type', () => {
    const setup = renderPanel({ panelNodes: [
      { id: 'dates', name: 'dates', type: 'array', itemType: 'date' },
    ] })

    fireEvent.click(screen.getByTitle('Type: array<date> — click to edit'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Array item type' }), { target: { value: 'integer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(setup.edits[0].schemaNodes[0]).toEqual({
      id: 'dates',
      name: 'dates',
      type: 'array',
      itemType: 'integer',
    })
    expect(screen.getByTitle('Type: array<integer> — click to edit')).toBeInTheDocument()
  })

  it('keeps an inline edit open when its name duplicates a sibling field', () => {
    const setup = renderPanel()

    fireEvent.click(screen.getByTitle('Edit title'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'gender' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByRole('alert')).toHaveTextContent('A sibling field already uses “gender”.')
    expect(screen.getByDisplayValue('gender')).toBeInTheDocument()
    expect(setup.edits).toHaveLength(0)
  })

  it('repairs a persisted duplicate id before renaming the affected field', async () => {
    const setup = renderPanel({ panelNodes: [
      { id: 'n1', name: 'grav_id', type: 'integer' },
      { id: 'n1', name: 'nyt_felt', type: 'verbatim-string' },
    ] })

    fireEvent.click(screen.getByTitle('Edit nyt_felt'))
    fireEvent.change(screen.getAllByPlaceholderText('field_name').at(-1)!, {
      target: { value: 'nuum' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!)

    await waitFor(() => expect(setup.edits).toHaveLength(1))
    const updated = setup.edits[0].schemaNodes
    expect(updated.map(({ name }) => name)).toEqual(['grav_id', 'nuum'])
    expect(new Set(updated.map(({ id }) => id))).toHaveLength(2)
    expect(screen.queryByText('A sibling field already uses “nuum”.')).not.toBeInTheDocument()
  })

  it('preserves an existing closed set when the field is renamed', () => {
    const setup = renderPanel()

    fireEvent.click(screen.getByTitle('Edit gender'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'sex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(setup.edits[0].schemaNodes[1]).toEqual({
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
    const setup = renderPanel()

    fireEvent.click(screen.getByTitle('Allowed values — click to edit: woman, man'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove woman' }))
    fireEvent.change(screen.getByPlaceholderText('add value…'), { target: { value: 'other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(setup.edits[0].schemaNodes[1]).toEqual({
      id: 'gender',
      name: 'gender',
      type: 'string',
      allowedValues: ['man', 'other'],
    })
  })

  it('drops the closed set entirely once fewer than two values remain', () => {
    const setup = renderPanel()

    fireEvent.click(screen.getByTitle('Allowed values — click to edit: woman, man'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove woman' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove man' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(setup.edits[0].schemaNodes[1]).toEqual({ id: 'gender', name: 'gender', type: 'string' })
  })

  it('preserves repetition when a field is dragged into a scalar array', async () => {
    const setup = renderPanel({ panelNodes: [
      { id: 'dates', name: 'dates', type: 'array', itemType: 'date' },
      { id: 'title', name: 'title', type: 'string' },
    ] })
    const titleRow = screen.getByText('title').parentElement!
    const datesRow = screen.getByText('dates').parentElement!

    fireEvent.mouseDown(titleRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(datesRow)
    fireEvent.mouseUp(window)

    await waitFor(() => expect(setup.edits).toHaveLength(1))
    expect(nodesToTemplate(setup.edits[0].schemaNodes)).toEqual({
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
    const setup = renderPanel({ panelNodes: original })

    const movedRow = screen.getByText('new_field').parentElement!
    const skeletonRow = screen.getByText('skeleton').parentElement!
    fireEvent.mouseDown(movedRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(skeletonRow)
    fireEvent.mouseUp(window)

    await waitFor(() => expect(setup.edits).toHaveLength(1))
    expect(nodesToTemplate(setup.edits[0].schemaNodes)).toEqual({
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
    const setup = renderPanel({ panelNodes: original })
    const graveRow = screen.getByText('grave').parentElement!
    const yearRow = screen.getByText('year').parentElement!
    const nestedSlot = yearRow.parentElement!.firstElementChild!

    fireEvent.mouseDown(graveRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(nestedSlot)
    fireEvent.mouseUp(window)

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot move field into its own contents.')
    expect(setup.edits).toHaveLength(0)
    expect(screen.getByText('grave')).toBeInTheDocument()
    expect(screen.getByText('year')).toBeInTheDocument()
    expect(screen.getByText('new_field')).toBeInTheDocument()
  })

  it('shows the item shape when reviewing an array type change', async () => {
    renderPanel({ panelNodes: [
      { id: 'entries', name: 'entries', type: 'array', itemType: 'date' },
    ] })

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
    const setup = renderPanel({ panelNodes: [
      { id: 'group', name: 'group', type: 'object', children: [{ id: 'nested-title', name: 'title', type: 'string' }] },
      { id: 'root-title', name: 'title', type: 'string' },
    ] })
    const titleRows = screen.getAllByText('title').map((label) => label.parentElement!)
    const groupRow = screen.getByText('group').parentElement!

    fireEvent.mouseDown(titleRows.at(-1)!.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(groupRow)
    fireEvent.mouseUp(window)

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot move field: a sibling field already uses “title”.')
    expect(setup.edits).toHaveLength(0)
  })

  it('allows a move when a dotted field name only resembles a nested path', async () => {
    const setup = renderPanel({ panelNodes: [
      { id: 'flat', name: 'place.region', type: 'string' },
      { id: 'place', name: 'place', type: 'object', children: [{ id: 'nested', name: 'region', type: 'string' }] },
      { id: 'year', name: 'year', type: 'integer' },
    ] })
    const yearRow = screen.getByText('year').parentElement!
    const placeRow = screen.getByText('place').parentElement!

    fireEvent.mouseDown(yearRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(placeRow)
    fireEvent.mouseUp(window)

    await waitFor(() => expect(setup.edits).toHaveLength(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not apply a rename that collides with an existing sibling', async () => {
    const setup = renderPanel({ panelNodes: [
      { id: 'surname', name: 'surname', type: 'string' },
      { id: 'name', name: 'name', type: 'string' },
    ] })
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

    expect(setup.edits).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(screen.getByText(/"surname": "string"/)).toBeInTheDocument()
    expect(screen.getByText(/"name": "string"/)).toBeInTheDocument()
  })

  it('shows one row per node, mixed counts, metadata reach, and applies atomically', async () => {
    const setup = renderPanel()
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

    expect(setup.edits).toHaveLength(1)
    expect(setup.edits[0].schemaNodes).toEqual([
      nodes[0],
      { id: 'gender', name: 'sex', type: 'string', allowedValues: ['woman', 'man'] },
    ])
  })

  it('keeps a chat proposal when the mutation gate rejects it', async () => {
    const setup = renderPanel()
    await send({
      status: 'proposed',
      fields: {
        title: { name: 'heading', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })
    setup.schema.commit = vi.fn(() => ({
      ok: false as const,
      reason: 'duplicate-name' as const,
      duplicateName: 'heading',
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))

    expect(
      screen.getByText(
        'Cannot apply the proposal: a sibling field already uses “heading”.',
      ),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Apply changes' }),
    ).toBeVisible()
    expect(setup.edits).toHaveLength(0)
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
    renderPanel({ panelNodes: [{ id: 'name', name: 'name', type: 'string' }] })
    await send({
      status: 'proposed',
      fields: { name: { name: 'name', type: 'string', removed: false } },
      additions: [{ path: ['missing', 'child'], type: 'string' }],
      issues: [],
    })

    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled()
  })

  it('gives an added group and child independent decisions', async () => {
    const setup = renderPanel()
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

    expect(setup.edits[0].schemaNodes).toEqual([
      ...nodes,
      expect.objectContaining({ name: 'new_group', children: [] }),
    ])
  })

  it('rejects dependent additions with their parent and disables a no-op apply', async () => {
    const setup = renderPanel()
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
    expect(setup.edits).toHaveLength(0)
  })

  it('expands ancestors so a nested before-and-after change is visible', async () => {
    renderPanel({ panelNodes: [{
      id: 'root',
      name: 'root',
      type: 'object',
      children: [{
        id: 'group',
        name: 'group',
        type: 'object',
        children: [{ id: 'leaf', name: 'leaf', type: 'string' }],
      }],
    }] })

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
    renderPanel({ panelNodes: [{
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
    }] })

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
    renderPanel({ panelNodes: [{
      id: 'group',
      name: 'group',
      type: 'object',
      children: [{ id: 'leaf', name: 'leaf', type: 'string' }],
    }] })

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
    const setup = renderPanel()
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
    expect(setup.edits).toHaveLength(0)
  })

  it('discards a chat response when the schema changed while the request was running', async () => {
    let resolveResponse!: (response: SchemaEditResponse) => void
    requestSchemaEdit.mockReturnValueOnce(new Promise<SchemaEditResponse>((resolve) => {
      resolveResponse = resolve
    }))
    const setup = renderPanel()
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
    expect(setup.edits[0].schemaNodes[0]).toEqual({ ...nodes[0], name: 'heading' })
  })

  it('discards a chat response when only the record description changed', async () => {
    let resolveResponse!: (response: SchemaEditResponse) => void
    requestSchemaEdit.mockReturnValueOnce(new Promise<SchemaEditResponse>((resolve) => {
      resolveResponse = resolve
    }))
    const setup = renderPanel()
    const chatInput = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(chatInput, { target: { value: 'Check fields' } })
    fireEvent.keyDown(chatInput, { key: 'Enter' })

    const description = screen.getByPlaceholderText(
      'Describe the record represented by this schema…',
    )
    fireEvent.change(description, { target: { value: 'One revised record.' } })
    fireEvent.blur(description)

    await act(async () => resolveResponse({
      status: 'proposed',
      fields: {
        title: { name: 'heading', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    }))

    expect(await screen.findByText('Schema changed while the request was running. Send the request again.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
    expect(setup.edits.at(-1)?.recordDescription).toBe('One revised record.')
    expect(screen.getByText('title')).toBeInTheDocument()
  })

  it('discards a proposal when the record description changes during review', async () => {
    const setup = renderPanel()
    await send({
      status: 'proposed',
      fields: {
        title: { name: 'heading', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false },
      },
      additions: [],
      issues: [],
    })

    const description = screen.getByPlaceholderText(
      'Describe the record represented by this schema…',
    )
    fireEvent.change(description, { target: { value: 'One revised record.' } })
    fireEvent.blur(description)
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))

    expect(await screen.findByText('Schema changed during review. The proposal was discarded.')).toBeInTheDocument()
    expect(setup.edits).toHaveLength(1)
    expect(setup.edits[0].recordDescription).toBe('One revised record.')
    expect(setup.edits[0].schemaNodes).toEqual(nodes)
    expect(screen.getByText('title')).toBeInTheDocument()
  })

  it('names the chat stop control and cancels it from the keyboard', async () => {
    requestSchemaEdit.mockImplementationOnce((_context, _message, signal) =>
      new Promise<SchemaEditResponse>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      }),
    )
    renderPanel()
    const chatInput = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(chatInput, { target: { value: 'Check fields' } })
    fireEvent.keyDown(chatInput, { key: 'Enter' })

    const stop = await screen.findByRole('button', {
      name: 'Stop schema edit request',
    })
    await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledTimes(1))
    stop.focus()
    expect(stop).toHaveFocus()
    fireEvent.click(stop)

    expect(await screen.findByText('Cancelled.')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Describe a change to the schema…')).toBeEnabled()
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
    const setup = renderPanel()
    requestSchemaEdit.mockResolvedValueOnce(response)
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Check fields' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
    expect(setup.edits).toHaveLength(0)
  })

})

describe('SchemaPanel conflict recovery', () => {
  it('lets the researcher reload the winning Current Schema Revision', async () => {
    const acknowledged: AcknowledgedSchemaRevision = {
      schemaRevisionId: '51000000-0000-4000-8004-000000000001',
      extractionSchemaId: '51000000-0000-4000-8003-000000000001',
      revisionNumber: 1,
      recordDescription: 'One mine record.',
      schemaNodes: [{ id: 'mine', name: 'mine', type: 'string' }],
    }
    const winning: SchemaRevision = {
      ...acknowledged,
      schemaRevisionId: '51000000-0000-4000-8004-000000000002',
      revisionNumber: 2,
      origin: 'researcher-edit',
      createdAt: '2026-08-01T12:01:00.000Z',
      recordDescription: 'One rival record.',
      schemaNodes: [{ id: 'rival', name: 'rival', type: 'string' }],
    }
    let saveState: SchemaSaveState = {
      status: 'conflict',
      acknowledged,
      draft: {
        recordDescription: acknowledged.recordDescription,
        schemaNodes: acknowledged.schemaNodes,
      },
      currentRevision: winning,
    }
    const listeners = new Set<() => void>()
    const persistence: SchemaEditorPersistence = {
      edit: () => undefined,
      saveState: () => saveState,
      reloadCurrent: () => {
        saveState = {
          status: 'saved',
          acknowledged: winning,
          draft: {
            recordDescription: winning.recordDescription,
            schemaNodes: winning.schemaNodes,
          },
        }
        for (const listener of listeners) listener()
        return winning
      },
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const schema = createSchemaEditorController(persistence, {
      initialDraft: saveState.draft,
    })
    render(
      <SchemaPanel
        schema={schema}
        onClearDraft={() => undefined}
        sourceDocumentName="test.pdf"
      />,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Reload Current Schema Revision',
      }),
    )

    await waitFor(() => expect(screen.getByText('rival')).toBeVisible())
    expect(schema.snapshot().save?.status).toBe('saved')
    expect(schema.snapshot().extractableSchemaRevisionId).toBe(
      winning.schemaRevisionId,
    )
  })
})

describe('SchemaPanel clear current schema', () => {
  it('requires confirmation before resetting the schema', () => {
    const onClearDraft = vi.fn(async () => {})
    renderPanel({}, { onClearDraft })

    fireEvent.click(screen.getByRole('button', { name: 'Clear current schema' }))
    expect(screen.getByText('Clear current schema?')).toBeInTheDocument()
    expect(onClearDraft).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Clear current schema?')).not.toBeInTheDocument()
    expect(onClearDraft).not.toHaveBeenCalled()
  })

  it('closes an armed clear confirmation when the draft is replaced', async () => {
    const setup = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Clear current schema' }))
    expect(screen.getByText('Clear current schema?')).toBeInTheDocument()

    act(() => {
      setup.schema.adoptDraft({
        recordDescription: 'One replacement record.',
        schemaNodes: historicalNodes,
      })
    })

    await waitFor(() =>
      expect(
        screen.queryByText('Clear current schema?'),
      ).not.toBeInTheDocument(),
    )
    expect(screen.getByText('historical_place')).toBeVisible()
  })

  it('clears local schema state after the workspace accepts the reset', async () => {
    const setup = renderPanel()
    const onClearDraft = vi.fn(async () => {
      await setup.schema.reset()
    })
    cleanup()
    render(<SchemaPanel
      schema={setup.schema}
      onClearDraft={onClearDraft}
      sourceDocumentName="test.pdf"
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear current schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear schema' }))

    expect(onClearDraft).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(setup.schema.snapshot().draft).toBeNull())
    await waitFor(() =>
      expect(screen.queryByText('Clear current schema?')).not.toBeInTheDocument(),
    )
    expect(screen.queryByText(nodes[0].name)).not.toBeInTheDocument()
    expect(screen.getByText('No schema yet')).toBeInTheDocument()
  })

  it('clears a history failure after a successful schema reset', async () => {
    const setup = renderPanel({
      getRevision: async () => {
        throw new Error('Load failed')
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Schema history' }))
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed')

    fireEvent.click(screen.getByRole('button', { name: 'Clear current schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear schema' }))

    await waitFor(() => expect(setup.schema.snapshot().draft).toBeNull())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('No schema yet')).toBeVisible()
  })

  it('keeps the editor when the workspace cannot flush the schema', async () => {
    const onClearDraft = vi.fn(async () => {
      throw new Error('The Current Schema Revision has changed.')
    })
    renderPanel({}, { onClearDraft })

    fireEvent.click(screen.getByRole('button', { name: 'Clear current schema' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear schema' }))

    await waitFor(() => expect(onClearDraft).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Clear current schema?')).toBeInTheDocument()
    expect(screen.getByTitle('Edit title')).toBeInTheDocument()
  })
})
