// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelOperation } from '../shared/modelOperation.contract'
import type { SchemaEditResponse } from '../shared/schemaEdit.contract'
import type { SchemaRevision, SchemaRevisionSummary } from '../shared/schemaRevision.contract'
import { nodesToTemplate, type SchemaDefinition, type SchemaNode } from 'extraction/schema'
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
// The server-side cancel resolves unless a case says otherwise; resetAllMocks restores this implementation.
const { requestSchemaEdit, deleteModelOperation, listModelOperations } = vi.hoisted(() => ({
  requestSchemaEdit: vi.fn(),
  deleteModelOperation: vi.fn<(workflowId: string) => Promise<void>>(async () => undefined),
  listModelOperations: vi.fn<() => Promise<ModelOperation[]>>(async () => []),
}))
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  requestSchemaEdit,
  deleteModelOperation,
  listModelOperations,
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
    recordScope: 'document',
    summary: '1 renamed',
  },
  {
    schemaRevisionId: '51000000-0000-4000-8004-000000000001',
    extractionSchemaId: '51000000-0000-4000-8003-000000000001',
    revisionNumber: 1,
    origin: 'suggestion',
    recordScope: null,
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
  /** Every definition the first revision was initialized from (an import or Start blank). */
  initialized: SchemaDefinition[]
}

function setupController({
  panelNodes = nodes,
  recordDescription = 'One test record.',
  currentRevisionNumber = 2,
  getRevision,
  flushImpl,
  durableScope = false,
  noSchema = false,
}: {
  panelNodes?: SchemaNode[]
  recordDescription?: string
  currentRevisionNumber?: number
  getRevision?: (schemaRevisionId: string) => Promise<SchemaRevision>
  flushImpl?: (call: number) => Promise<SchemaRevision | null>
  /** A durable, clean scope: the panel lists and restores model operations on load. */
  durableScope?: boolean
  /** A durable scope before its first schema: no draft, no revision. */
  noSchema?: boolean
} = {}): PanelSetup {
  const acknowledged: AcknowledgedSchemaRevision = {
    schemaRevisionId: '51000000-0000-4000-8004-000000000002',
    extractionSchemaId: '51000000-0000-4000-8003-000000000001',
    revisionNumber: currentRevisionNumber,
    recordDescription,
    recordScope: 'document',
    schemaNodes: panelNodes,
  }
  const edits: PanelSetup['edits'] = []
  const events: string[] = []
  const initialized: SchemaDefinition[] = []
  let flushCalls = 0
  const persistence: SchemaEditorPersistence = {
    extractionSchemaId: () => (noSchema ? null : acknowledged.extractionSchemaId),
    ...(durableScope ? { projectContextId: () => modelContext.projectContextId } : {}),
    initialize: async (definition) => {
      initialized.push(definition)
      return {
        ...schemaHistory[1],
        revisionNumber: 1,
        recordScope: null,
        recordDescription: definition.recordDescription,
        schemaNodes: definition.schemaNodes,
      }
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
      return durableScope && !noSchema ? { status: 'saved', acknowledged, draft: { recordDescription, schemaNodes: panelNodes }, recordScope: 'document' } : null
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
  const schema = createSchemaEditorController(persistence, noSchema ? {} : {
    initialDraft: { recordDescription, schemaNodes: panelNodes },
    initialRevisionNumber: currentRevisionNumber,
    initialExtractableRevisionId: acknowledged.schemaRevisionId,
    initialHistory: schemaHistory,
  })
  return { schema, edits, events, initialized }
}

type PanelProps = Partial<React.ComponentProps<typeof SchemaPanel>>

function renderPanel(
  setupOptions: Parameters<typeof setupController>[0] = {},
  renderProps: PanelProps = {},
): PanelSetup & {
  /** Renders the same controller with new props; the setup options of the first render stay. */
  rerender: (setupOptions: Parameters<typeof setupController>[0], renderProps: PanelProps) => void
} {
  const setup = setupController(setupOptions)
  const panel = (props: PanelProps) => (
    <SchemaPanel
      schema={setup.schema}
      onClearDraft={() => setup.schema.reset()}
      sourceDocumentName="test.pdf"
      {...props}
    />
  )
  const { rerender } = render(panel(renderProps))
  return { ...setup, rerender: (_setupOptions, props) => rerender(panel(props)) }
}

/** Opens the header's "Schema actions" menu and chooses `name`. */
function chooseSchemaAction(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name }))
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
  it('each edit request carries a new operation ID', async () => {
    renderPanel()
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    for (const turn of [1, 2]) {
      requestSchemaEdit.mockResolvedValueOnce({ status: 'refused', message: 'no' })
      fireEvent.change(input, { target: { value: `Update fields ${turn}` } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledTimes(turn))
      await screen.findByText(`Request refused: no`, { exact: false }, { timeout: 2_000 }).catch(() => undefined)
    }

    const ids = requestSchemaEdit.mock.calls.map((call) => call[3] as string)
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(ids[0]).not.toBe(ids[1])
  })

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
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    )

    const row = screen.getByText('title').closest('[role="listitem"]')!
    expect(within(row as HTMLElement).queryAllByText('string')).toHaveLength(0)
    expect(setup.edits).toHaveLength(0)
  })

  it('previews history read-only and appends only after the explicit create action', async () => {
    const loadRevision = vi.fn(async () => ({
      ...schemaHistory[1],
      recordDescription: 'One historical record.',
      schemaNodes: historicalNodes,
    }))
    const setup = renderPanel({ getRevision: loadRevision })

    chooseSchemaAction('History')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Schema history' })).getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByText('historical_place')).toBeInTheDocument()

    expect(setup.events).toEqual(['load'])
    expect(setup.edits).toHaveLength(0)
    expect(loadRevision).toHaveBeenCalledWith('51000000-0000-4000-8004-000000000001')
    expect(screen.queryByRole('button', { name: '+ Add field' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Schema actions' })).not.toBeInTheDocument()

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
    expect(screen.getByRole('button', { name: 'Schema actions' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Revision 1/ })).not.toBeInTheDocument()
  })

  it('keeps the current fields usable while regeneration is pending and after failure', async () => {
    const setup = renderPanel({}, { onGenerateInstructions: vi.fn() })
    let rejectGeneration!: (reason: Error) => void
    const request = new Promise<unknown>((_resolve, reject) => {
      rejectGeneration = reject
    })
    let generation!: Promise<void>

    act(() => {
      generation = setup.schema.generate(() => request)
    })

    expect(screen.getByText('title')).toBeInTheDocument()
    // The footer's save status is a status region too.
    expect(screen.getByText('Regenerating. The current saved schema remains available.').parentElement)
      .toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
    expect(screen.getByRole('menuitem', { name: 'Regenerate from the document…' })).toBeDisabled()

    await act(async () => {
      rejectGeneration(new Error('Model unavailable'))
      await generation
    })

    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Regeneration failed: Model unavailable The current saved schema is unchanged.',
    )
    expect(screen.getByRole('menuitem', { name: 'Regenerate from the document…' })).toBeEnabled()
  })

  it('says what of the source an excerpted generation did not read', async () => {
    const setup = renderPanel()

    await act(async () => {
      await setup.schema.generate(async (_signal, declareSourceCoverage) => {
        declareSourceCoverage({ complete: false, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] })
        return { _description: 'One test record.', title: 'string' }
      })
    })

    expect(
      screen.getByText('Suggested from excerpts: the middle of page 1 was not read (4,040 of 50,040 characters).'),
    ).toBeVisible()
  })

  it('regenerates from instructions edited in the Regenerate dialog', () => {
    const onGenerateInstructions = vi.fn()
    renderPanel({}, { showRegenerate: true, onGenerateInstructions })

    chooseSchemaAction('Regenerate from the document…')
    const dialog = screen.getByRole('dialog', { name: 'Regenerate from the document' })

    const instruction = within(dialog).getByPlaceholderText(/Add a generation instruction/)
    fireEvent.change(instruction, { target: { value: 'Focus on dates' } })
    fireEvent.keyDown(instruction, { key: 'Enter' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Regenerate schema/ }))

    expect(onGenerateInstructions).toHaveBeenCalledWith(
      'Focus on dates\n\nField notes from the current schema:\n- title: Research rule',
    )
    expect(screen.queryByRole('dialog', { name: 'Regenerate from the document' })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Add a generation instruction/)).not.toBeInTheDocument()
  })

  it('resets stale JSON when an external draft replaces the editor payload', async () => {
    const setup = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
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
      'Describe the record this schema extracts…',
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

    chooseSchemaAction('History')
    fireEvent.click(screen.getByRole('button', { name: /Revision 2/ }))

    expect(getRevision).not.toHaveBeenCalled()
    expect(setup.events).not.toContain('flush')
    expect(setup.events).not.toContain('edit')
    expect(screen.queryByRole('button', { name: /Revision 2/ })).not.toBeInTheDocument()
  })

  it('keeps the current schema when loading or pre-creation flushing fails', async () => {
    const loadRevision = vi.fn(async () => { throw new Error('Load failed') })
    const setup = renderPanel({ getRevision: loadRevision })

    chooseSchemaAction('History')
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed')
    expect(setup.events).toEqual(['load'])
    expect(setup.edits).toHaveLength(0)
    expect(screen.getByText('title')).toBeInTheDocument()

    cleanup()
    const failingSetup = renderPanel({
      flushImpl: async () => { throw new Error('Save current failed') },
    })
    chooseSchemaAction('History')
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

    chooseSchemaAction('History')
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

  it('shows the description button for a leaf field and accumulates its notes', () => {
    const setup = renderPanel()
    const row = screen.getByRole('listitem', { name: 'title' })
    fireEvent.click(within(row).getByRole('button', { name: /^Add note to / }))

    // The row's note line and the open form's list both show the existing note.
    expect(screen.getAllByText('Research rule')).toHaveLength(2)
    const input = screen.getByPlaceholderText('Add another note…')
    expect(input).toHaveValue('')

    fireEvent.change(input, { target: { value: 'Second note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(setup.schema.snapshot().draft?.schemaNodes[0]).toMatchObject({
      id: 'title',
      description: 'Research rule\nSecond note',
    })
    // The popover stays open with a cleared input, ready for another note.
    expect(screen.getByPlaceholderText('Add another note…')).toHaveValue('')
    expect(screen.getByText('Second note')).toBeInTheDocument()
  })

  it('clears every accumulated note on a field in one action', () => {
    const setup = renderPanel()
    const row = screen.getByRole('listitem', { name: 'title' })
    fireEvent.click(within(row).getByRole('button', { name: /^Add note to / }))
    fireEvent.click(screen.getByTitle('Clear all notes'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(setup.schema.snapshot().draft?.schemaNodes[0]).toMatchObject({
      id: 'title',
      description: undefined,
    })
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

    expect(screen.getByRole('button', { name: 'Collapse group' })).toHaveAttribute('aria-expanded', 'true')
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
      expect(screen.getByPlaceholderText('field_name')).toHaveValue('')

      if (dismissal === 'Escape') {
        fireEvent.keyDown(screen.getByPlaceholderText('field_name'), {
          key: 'Escape',
        })
      } else {
        fireEvent.click(
          screen.getByRole('button', { name: 'Cancel field edit' }),
        )
      }

      expect(screen.queryByPlaceholderText('field_name')).not.toBeInTheDocument()
      expect(within(screen.getByRole('list', { name: 'Schema fields' })).getAllByRole('listitem')
        .map((row) => row.getAttribute('aria-label'))).toEqual(['title', 'gender'])
      expect(setup.edits).toHaveLength(0)
      expect(setup.schema.snapshot().draft?.schemaNodes).toEqual(nodes)
    },
  )

  it('commits a provisional field only when Save is activated', () => {
    const setup = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    fireEvent.change(screen.getByPlaceholderText('field_name'), {
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
    fireEvent.change(screen.getByPlaceholderText('field_name'), {
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

    fireEvent.click(screen.getByTitle('Type: list of dates — click to edit'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Array item type' }), { target: { value: 'integer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(setup.edits[0].schemaNodes[0]).toEqual({
      id: 'dates',
      name: 'dates',
      type: 'array',
      itemType: 'integer',
    })
    expect(screen.getByTitle('Type: list of integers — click to edit')).toBeInTheDocument()
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

    expect(screen.getByTitle('Allowed values — click to edit: woman, man')).toHaveTextContent('2 values')
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
    const titleRow = screen.getByText('title').closest<HTMLElement>('[role="listitem"]')!
    const datesRow = screen.getByText('dates').closest<HTMLElement>('[role="listitem"]')!

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

    const movedRow = screen.getByText('new_field').closest<HTMLElement>('[role="listitem"]')!
    const skeletonRow = screen.getByText('skeleton').closest<HTMLElement>('[role="listitem"]')!
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
    const graveRow = screen.getByText('grave').closest<HTMLElement>('[role="listitem"]')!
    const yearRow = screen.getByText('year').closest<HTMLElement>('[role="listitem"]')!
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

    expect(screen.getByText('list of dates')).toBeInTheDocument()
    expect(screen.getByText('list of objects')).toBeInTheDocument()
  })

  it('rejects a drag that would duplicate a sibling field', async () => {
    const setup = renderPanel({ panelNodes: [
      { id: 'group', name: 'group', type: 'object', children: [{ id: 'nested-title', name: 'title', type: 'string' }] },
      { id: 'root-title', name: 'title', type: 'string' },
    ] })
    const titleRows = screen.getAllByText('title').map((label) => label.closest<HTMLElement>('[role="listitem"]')!)
    const groupRow = screen.getByText('group').closest<HTMLElement>('[role="listitem"]')!

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
    const yearRow = screen.getByText('year').closest<HTMLElement>('[role="listitem"]')!
    const placeRow = screen.getByText('place').closest<HTMLElement>('[role="listitem"]')!

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
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
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
      'Describe the record this schema extracts…',
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
      'Describe the record this schema extracts…',
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

  it('a reloaded panel shows a running operation with its instruction, and Stop cancels it', async () => {
    const running: ModelOperation = {
      kind: 'generation', workflowId: 'suggestion:51000000-0000-4000-8009-0000000000f1', operationId: '51000000-0000-4000-8009-0000000000f1',
      status: 'RUNNING', instruction: 'Catalog entries', createdAt: '2026-09-26T10:00:00.000Z', failure: null, baseSchemaRevisionId: null, template: null, sourceCoverage: null,
    }
    listModelOperations.mockResolvedValueOnce([running])
    renderPanel({ durableScope: true })

    expect(await screen.findByText('Still working on an earlier request: “Catalog entries”')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop earlier request “Catalog entries”' }))

    await waitFor(() => expect(deleteModelOperation).toHaveBeenCalledExactlyOnceWith(running.workflowId))
    expect(listModelOperations).toHaveBeenCalledExactlyOnceWith(
      { projectContextId: modelContext.projectContextId, extractionSchemaId: modelContext.extractionSchemaId },
      expect.any(AbortSignal),
    )
  })

  it('a reloaded panel before its first schema shows the running first generation with a Stop', async () => {
    const running: ModelOperation = {
      kind: 'generation', workflowId: 'suggestion:51000000-0000-4000-8009-0000000000f3', operationId: '51000000-0000-4000-8009-0000000000f3',
      status: 'RUNNING', instruction: 'First catalog', createdAt: '2026-09-26T10:00:00.000Z', failure: null, baseSchemaRevisionId: null, template: null, sourceCoverage: null,
    }
    listModelOperations.mockResolvedValueOnce([running])
    renderPanel({ durableScope: true, noSchema: true }, { onGenerateInstructions: vi.fn() })

    expect(await screen.findByText('Still working on an earlier request: “First catalog”')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop earlier request “First catalog”' }))
    await waitFor(() => expect(deleteModelOperation).toHaveBeenCalledExactlyOnceWith(running.workflowId))
  })

  it('a reloaded panel with a running edit opens the conversation; collapsed, a mark on the composer brings it back', async () => {
    const running: ModelOperation = {
      kind: 'proposal', workflowId: 'edit:51000000-0000-4000-8009-0000000000f4', operationId: '51000000-0000-4000-8009-0000000000f4',
      status: 'RUNNING', instruction: 'Rename title to heading', createdAt: '2026-09-26T10:00:00.000Z', failure: null,
      baseSchemaRevisionId: modelContext.schemaRevisionId, response: null,
    }
    listModelOperations.mockResolvedValueOnce([running])
    renderPanel({ durableScope: true })

    const row = 'Still working on an earlier request: “Rename title to heading”'
    expect(within(await screen.findByRole('region', { name: 'Conversation' })).getByText(row)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversation' }))
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'An earlier request is still running' }))
    expect(within(screen.getByRole('region', { name: 'Conversation' })).getByText(row)).toBeInTheDocument()
  })

  it("a restored proposal reopens the review bar and replays onto the base revision's nodes", async () => {
    const restored: ModelOperation = {
      kind: 'proposal', workflowId: 'edit:51000000-0000-4000-8009-0000000000f2', operationId: '51000000-0000-4000-8009-0000000000f2',
      status: 'SUCCEEDED', instruction: 'Rename title to heading', createdAt: '2026-09-26T10:00:00.000Z', failure: null,
      baseSchemaRevisionId: modelContext.schemaRevisionId,
      response: { status: 'proposed', fields: { title: { name: 'heading', type: 'string', removed: false } }, additions: [], issues: [] },
    }
    listModelOperations.mockResolvedValueOnce([restored])
    const setup = renderPanel({ durableScope: true })

    const apply = await screen.findByRole('button', { name: 'Apply changes' })
    expect(screen.getByText('Reopened the proposal for “Rename title to heading”.')).toBeInTheDocument()
    fireEvent.click(apply)

    await waitFor(() => expect(setup.edits).toHaveLength(1))
    expect(setup.edits[0]!.schemaNodes.map((node) => node.name)).toEqual(['heading', 'gender'])
    expect(requestSchemaEdit).not.toHaveBeenCalled()
  })

  it('Stop on a running edit cancels edit:<operationId> on the server and says Cancelled.', async () => {
    requestSchemaEdit.mockImplementationOnce((_context, _message, signal) =>
      new Promise<SchemaEditResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
    )
    deleteModelOperation.mockResolvedValueOnce(undefined)
    renderPanel()
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Check fields' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const stop = await screen.findByRole('button', { name: 'Stop schema edit request' })
    await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledOnce())
    const operationId = requestSchemaEdit.mock.calls[0]![3] as string

    fireEvent.click(stop)

    expect(await screen.findByText('Cancelled.')).toBeInTheDocument()
    expect(deleteModelOperation).toHaveBeenCalledExactlyOnceWith(`edit:${operationId}`)
  })

  it('Stop whose server cancel fails still stops waiting, and says the request may still be running', async () => {
    requestSchemaEdit.mockImplementationOnce((_context, _message, signal) =>
      new Promise<SchemaEditResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
    )
    deleteModelOperation.mockRejectedValueOnce(new Error('503'))
    renderPanel()
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Check fields' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const stop = await screen.findByRole('button', { name: 'Stop schema edit request' })
    await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledOnce())

    fireEvent.click(stop)

    expect(await screen.findByText('Cancelled.')).toBeInTheDocument()
    expect(await screen.findByText('The request could not be stopped on the server; it may still be running and will show as an earlier request after a reload.')).toBeInTheDocument()
    expect(input).toBeEnabled()
  })

  it('unmounting during an edit cancels nothing on the server', async () => {
    requestSchemaEdit.mockImplementationOnce(() => new Promise<SchemaEditResponse>(() => undefined))
    renderPanel()
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Check fields' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledOnce())
    const signal = requestSchemaEdit.mock.calls[0]![2] as AbortSignal

    cleanup()

    expect(signal.aborted).toBe(true)
    expect(deleteModelOperation).not.toHaveBeenCalled()
  })

  it('cancels a schema edit request when the panel unmounts', async () => {
    requestSchemaEdit.mockImplementationOnce(() =>
      new Promise<SchemaEditResponse>(() => undefined),
    )
    renderPanel()
    const input = screen.getByPlaceholderText(
      'Describe a change to the schema…',
    )
    fireEvent.change(input, { target: { value: 'Check fields' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledOnce())
    const signal = requestSchemaEdit.mock.calls[0]![2] as AbortSignal
    expect(signal.aborted).toBe(false)

    cleanup()

    expect(signal.aborted).toBe(true)
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

describe('SchemaPanel field context', () => {
  it('focuses a renamed stable field with its old type while preserving an unsaved inline edit', () => {
    const setup = setupController({ panelNodes: [{ id: 'title', name: 'heading', type: 'integer' }] })
    const props = { schema: setup.schema, onClearDraft: vi.fn(), sourceDocumentName: 'test.pdf' }
    const mounted = render(<SchemaPanel {...props} />)
    fireEvent.click(screen.getByTitle('Edit heading'))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'unsaved_name' } })
    const before = setup.schema.snapshot().draft
    mounted.rerender(<SchemaPanel {...props} fieldContext={{ extractionId: 'old-sample', schemaRevisionId: 'old-revision',
      revisionNumber: 1, nodeId: 'title', nodeType: 'string', resultPaths: [['records', 0, 'title']] }} />)
    expect(screen.getByDisplayValue('unsaved_name')).toBeInTheDocument()
    expect(screen.getByText(/From Extraction old-sample.*string.*heading \(integer\)/)).toBeInTheDocument()
    expect(setup.schema.snapshot().draft).toBe(before)
    expect(setup.edits).toEqual([])
    mounted.rerender(<SchemaPanel {...props} fieldContext={{ extractionId: 'old-sample', schemaRevisionId: 'old-revision',
      revisionNumber: 1, nodeId: 'removed', nodeType: 'string', resultPaths: [['records', 0, 'heading']] }} />)
    expect(screen.getByText(/This field was removed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View historical schema' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('unsaved_name')).toBeInTheDocument()
    expect(setup.edits).toEqual([])
  })
})

describe('SchemaPanel conflict recovery', () => {
  it('lets the researcher reload the winning Current Schema Revision', async () => {
    const acknowledged: AcknowledgedSchemaRevision = {
      schemaRevisionId: '51000000-0000-4000-8004-000000000001',
      extractionSchemaId: '51000000-0000-4000-8003-000000000001',
      revisionNumber: 1,
      recordDescription: 'One mine record.',
      recordScope: 'document',
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
      recordScope: acknowledged.recordScope,
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
          recordScope: winning.recordScope,
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

    chooseSchemaAction('Clear schema')
    expect(screen.getByText('Clear current schema?')).toBeInTheDocument()
    expect(onClearDraft).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Clear current schema?')).not.toBeInTheDocument()
    expect(onClearDraft).not.toHaveBeenCalled()
  })

  it('closes an armed clear confirmation when the draft is replaced', async () => {
    const setup = renderPanel()
    chooseSchemaAction('Clear schema')
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

    chooseSchemaAction('Clear schema')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear current schema' })).getByRole('button', { name: 'Clear schema' }))

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
    chooseSchemaAction('History')
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed')

    chooseSchemaAction('Clear schema')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear current schema' })).getByRole('button', { name: 'Clear schema' }))

    await waitFor(() => expect(setup.schema.snapshot().draft).toBeNull())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('No schema yet')).toBeVisible()
  })

  it('keeps the editor when the workspace cannot flush the schema', async () => {
    const onClearDraft = vi.fn(async () => {
      throw new Error('The Current Schema Revision has changed.')
    })
    renderPanel({}, { onClearDraft })

    chooseSchemaAction('Clear schema')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear current schema' })).getByRole('button', { name: 'Clear schema' }))

    await waitFor(() => expect(onClearDraft).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Clear current schema?')).toBeInTheDocument()
    expect(screen.getByTitle('Edit title')).toBeInTheDocument()
  })
})

describe('schema header (redesign §5)', () => {
  it('names the schema in the heading, switches Fields and Code, and offers the actions menu', () => {
    renderPanel({}, {
      schemaName: 'Places',
      onRenameSchema: vi.fn(async () => null),
      showRegenerate: true,
      onGenerateInstructions: vi.fn(),
    })
    expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName('Places')
    expect(screen.queryByText('Extraction Schema')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    expect(screen.getByText(/"_description": "One test record\."/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(
      ['Import from Excel codebook…', 'Edit as code', 'History', 'Regenerate from the document…', 'Clear schema'])
  })

  it('the actions menu opens the import dialog', () => {
    renderPanel({ durableScope: true })
    expect(screen.queryByRole('dialog', { name: 'Import from Excel codebook' })).not.toBeInTheDocument()
    chooseSchemaAction('Import from Excel codebook…')
    expect(screen.getByRole('dialog', { name: 'Import from Excel codebook' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Import from Excel codebook' })).not.toBeInTheDocument()

    cleanup()
    renderPanel({ durableScope: true, noSchema: true }, { schemaName: null })
    fireEvent.click(screen.getByRole('button', { name: 'Import from Excel codebook…' }))
    expect(screen.getByRole('dialog', { name: 'Import from Excel codebook' })).toBeInTheDocument()
  })

  it('the import action is disabled without a project to import into', () => {
    const setup = renderPanel()
    expect(setup.schema.operationScope()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
    expect(screen.getByRole('menuitem', { name: 'Import from Excel codebook…' })).toBeDisabled()

    cleanup()
    const empty = renderPanel({ noSchema: true }, { schemaName: null })
    expect(empty.schema.operationScope()).toBeNull()
    expect(screen.getByRole('heading', { name: 'No schema yet' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import from Excel codebook…' })).toBeDisabled()
  })

  it('says the saved record scope in words and saves a change at once', () => {
    const onChange = vi.fn()
    renderPanel({}, { recordScope: { value: 'document', onChange } })
    const scope = screen.getByLabelText('Record scope')
    expect(scope).toHaveValue('document')
    expect(screen.getByRole('option', { name: 'Catalog · a collection of records' })).toBeInTheDocument()
    fireEvent.change(scope, { target: { value: 'records' } })
    expect(onChange).toHaveBeenCalledWith('records')
  })

  it('asks for Article or Catalog while none is saved, and shows Boundaries only when given', () => {
    const { rerender } = renderPanel({}, { recordScope: { value: null, onChange: vi.fn() } })
    expect(screen.getByLabelText('Record scope')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Choose Article or Catalog' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Boundaries')).not.toBeInTheDocument()
    rerender({}, { recordScope: { value: 'records', onChange: vi.fn() },
      boundaries: { value: '', options: [{ id: 'numbered-catalogue-de@1', label: 'Numbered catalogue (German)' }], onChange: vi.fn() } })
    expect(screen.getByLabelText('Boundaries')).toHaveValue('')
  })

  it('labels the record description "What one record is" and saves it on blur', () => {
    const setup = renderPanel()
    const description = screen.getByLabelText('What one record is')
    fireEvent.change(description, { target: { value: 'One grave.' } })
    fireEvent.blur(description)
    expect(setup.schema.snapshot().draft?.recordDescription).toBe('One grave.')
    expect(screen.queryByText('Record description')).not.toBeInTheDocument()
  })

  it('the footer says the saved revision and never counts fields', () => {
    renderPanel({ durableScope: true })
    expect(screen.getByText('Saved · revision 2')).toBeInTheDocument()
    expect(screen.queryByText(/\d+ fields?\s*$/)).not.toBeInTheDocument()
  })

  it('the empty state offers Generate and Start blank; Start blank creates an empty schema named Untitled schema and focuses its description', async () => {
    const onRenameSchema = vi.fn(async () => null)
    const onGenerateInstructions = vi.fn()
    const setup = renderPanel({ durableScope: true, noSchema: true }, { onGenerateInstructions, onRenameSchema, schemaName: null })
    expect(screen.getByRole('heading', { name: 'No schema yet' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Generate from the document' }))
    expect(onGenerateInstructions).toHaveBeenCalledWith('')
    fireEvent.click(screen.getByRole('button', { name: 'Start blank' }))
    await waitFor(() => expect(setup.initialized).toEqual([{ recordDescription: 'Untitled record', schemaNodes: [] }]))
    await waitFor(() => expect(onRenameSchema).toHaveBeenCalledWith('Untitled schema'))
    const description = (await screen.findByLabelText('What one record is')) as HTMLTextAreaElement
    await waitFor(() => expect(description).toHaveFocus())
    expect(description.value.slice(description.selectionStart, description.selectionEnd)).toBe('Untitled record')
  })

  it('Start blank after a named schema was cleared keeps its name', async () => {
    const onRenameSchema = vi.fn(async () => null)
    const setup = renderPanel({ durableScope: true, noSchema: true }, { onRenameSchema, schemaName: 'Places' })
    fireEvent.click(screen.getByRole('button', { name: 'Start blank' }))
    await waitFor(() => expect(setup.initialized).toHaveLength(1))
    expect(await screen.findByLabelText('What one record is')).toHaveValue('Untitled record')
    expect(onRenameSchema).not.toHaveBeenCalled()
  })

  it('Start blank creates one schema however often it is clicked, and is absent from a read-only panel', async () => {
    const setup = renderPanel({ durableScope: true, noSchema: true }, { schemaName: null })
    const start = screen.getByRole('button', { name: 'Start blank' })
    fireEvent.click(start)
    fireEvent.click(start)
    await screen.findByLabelText('What one record is')
    expect(setup.initialized).toHaveLength(1)

    cleanup()
    renderPanel({ durableScope: true, noSchema: true }, { readOnly: true })
    expect(screen.getByRole('heading', { name: 'No schema yet' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start blank' })).not.toBeInTheDocument()
  })

  it('an imported first schema is named after the document, and a refused name shows as an error', async () => {
    const column = { id: 'stable-import-id', column: 1, name: 'site', type: 'string', include: true,
      examples: ['A'], kinds: ['text'], choices: [], suggestedType: 'string' }
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => Response.json({
      worksheets: ['Codebook'], columns: String(input).includes('worksheet=') ? [column] : [],
    })))
    try {
      const onRenameSchema = vi.fn(async () => 'That name is taken.')
      const setup = renderPanel({ durableScope: true, noSchema: true }, { onRenameSchema, schemaName: null, sourceDocumentName: 'Sites.pdf' })
      fireEvent.click(screen.getByRole('button', { name: 'Import from Excel codebook…' }))
      fireEvent.change(screen.getByLabelText('Excel codebook file'), { target: { files: [new File(['bytes'], 'codebook.xlsx')] } })
      await screen.findByRole('option', { name: 'Codebook' })
      fireEvent.change(screen.getByLabelText('Import worksheet'), { target: { value: 'Codebook' } })
      fireEvent.click(screen.getByRole('button', { name: 'Preview worksheet' }))
      fireEvent.change(await screen.findByLabelText('Imported record description'), { target: { value: 'One site.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Confirm schema' }))

      await waitFor(() => expect(setup.initialized).toHaveLength(1))
      await waitFor(() => expect(onRenameSchema).toHaveBeenCalledWith('Sites'))
      expect(await screen.findByRole('alert')).toHaveTextContent('That name is taken.')
      expect(screen.queryByRole('dialog', { name: 'Import from Excel codebook' })).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the Regenerate dialog cannot start a second generation, and closes when the draft is replaced', async () => {
    const onGenerateInstructions = vi.fn()
    const setup = renderPanel({}, { onGenerateInstructions })
    chooseSchemaAction('Regenerate from the document…')
    const dialog = screen.getByRole('dialog', { name: 'Regenerate from the document' })
    expect(within(dialog).getByRole('button', { name: /Regenerate schema/ })).toBeEnabled()

    let finish!: () => void
    act(() => {
      void setup.schema.generate(() => new Promise((resolve) => {
        finish = () => resolve({ _description: 'One test record.', title: 'string' })
      }))
    })
    expect(within(dialog).getByRole('button', { name: /Regenerate schema/ })).toBeDisabled()
    await act(async () => finish())

    act(() => {
      setup.schema.adoptDraft({ recordDescription: 'One replacement record.', schemaNodes: historicalNodes })
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Regenerate from the document' })).not.toBeInTheDocument())
    expect(onGenerateInstructions).not.toHaveBeenCalled()
  })

  it('History, Regenerate and Clear schema open dialogs from the actions menu', async () => {
    const onClearDraft = vi.fn(async () => undefined)
    const onGenerateInstructions = vi.fn()
    renderPanel({ durableScope: true }, { showRegenerate: true, onGenerateInstructions, onClearDraft })
    const open = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    open('History')
    expect(within(screen.getByRole('dialog', { name: 'Schema history' })).getByRole('button', { name: /Revision 2.*Current/ })).toBeInTheDocument()
    // Escape on a modal dialog fires `cancel`, which jsdom does not synthesize from the key.
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog', { name: 'Schema history' })).not.toBeInTheDocument()
    open('Regenerate from the document…')
    const dialog = screen.getByRole('dialog', { name: 'Regenerate from the document' })
    fireEvent.change(within(dialog).getByPlaceholderText(/Add a generation instruction/), { target: { value: 'Focus on dates' } })
    fireEvent.keyDown(within(dialog).getByPlaceholderText(/Add a generation instruction/), { key: 'Enter' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Regenerate schema/ }))
    expect(onGenerateInstructions).toHaveBeenCalledWith(expect.stringContaining('Focus on dates'))
    open('Clear schema')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear current schema' })).getByRole('button', { name: 'Clear schema' }))
    await waitFor(() => expect(onClearDraft).toHaveBeenCalledOnce())
  })
})

describe('field rows (redesign §6)', () => {
  it('shows the name in full beside word pills, keeps actions until hover or focus, and has no selection checkboxes', () => {
    renderPanel({ panelNodes: [...nodes, { id: 'dates', name: 'dates', type: 'array', itemType: 'date' },
      { id: 'sex', name: 'sex', type: 'string', allowedValues: ['f', 'm', 'unknown', 'child', 'adult', 'elder'] }] })
    const row = screen.getByRole('listitem', { name: 'sex' })
    expect(within(row).getByText('sex').className).toMatch(/shrink-0/)
    expect(within(row).getByText('sex').className).toMatch(/max-w-\[60%\]/)
    expect(within(row).getByText('6 values')).toBeInTheDocument()
    expect(within(row).getByTitle('Type: string — click to edit')).toBeInTheDocument()
    expect(within(screen.getByRole('listitem', { name: 'dates' })).getByTitle('Type: list of dates — click to edit')).toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    const actions = within(row).getByRole('button', { name: 'Delete sex' }).parentElement!
    expect(actions.className).toMatch(/group-hover:opacity-100/)
    expect(actions.className).toMatch(/group-focus-within:opacity-100/)
    expect(within(row).getByRole('button', { name: 'Delete sex' }).className).toMatch(/size-7/)
  })

  it('deletes a field in one click and Undo restores it in place', () => {
    const setup = renderPanel()
    fireEvent.click(within(screen.getByRole('listitem', { name: 'title' })).getByRole('button', { name: 'Delete title' }))
    expect(screen.queryByRole('listitem', { name: 'title' })).not.toBeInTheDocument()
    expect(setup.edits.at(-1)!.schemaNodes.map((node) => node.name)).toEqual(['gender'])
    expect(screen.getByText('Field removed')).toBeInTheDocument() // not getByRole('status'): the footer's save status has that role too
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(setup.edits.at(-1)!.schemaNodes.map((node) => node.name)).toEqual(['title', 'gender'])
    expect(screen.getByRole('listitem', { name: 'title' })).toBeInTheDocument()
  })

  it('Undo after the parent group was deleted says it could not restore', () => {
    const setup = renderPanel({ panelNodes: [{ id: 'g', name: 'grave', type: 'object', children: [{ id: 'g1', name: 'depth', type: 'number' }] }] })
    fireEvent.click(within(screen.getByRole('listitem', { name: 'depth' })).getByRole('button', { name: 'Delete depth' }))
    // The group goes by another route (the code view, a model edit) so that depth's Undo is still the toast on screen: a
    // second panel delete would replace it with the group's own Undo.
    act(() => { setup.schema.commit((current) => current.filter((node) => node.id !== 'g'), '') })
    expect(screen.queryByRole('listitem', { name: 'grave' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByText('Could not restore the field')).toBeInTheDocument()
    expect(screen.queryByRole('listitem', { name: 'depth' })).not.toBeInTheDocument()
  })

  it('a new field opens an empty edit form whose Save waits for a name', () => {
    const setup = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    const name = screen.getByPlaceholderText('field_name')
    expect(name).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(name, { target: { value: 'Grave goods' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setup.edits.at(-1)!.schemaNodes.at(-1)!.name).toBe('grave_goods')
    expect(screen.queryByText('nyt_felt')).not.toBeInTheDocument()
  })

  it('a note renders in full as a second line and opens the note form', () => {
    renderPanel()
    const row = screen.getByRole('listitem', { name: 'title' })
    expect(within(row).getByText('Research rule')).toBeInTheDocument()
    fireEvent.click(within(row).getByText('Research rule'))
    expect(screen.getByPlaceholderText('Add another note…')).toBeInTheDocument()
  })

  it('a group that first appears after mount shows its children without a click', () => {
    const setup = renderPanel()
    act(() => {
      setup.schema.commit((current) => [...current, { id: 'g', name: 'grave', type: 'object', children: [
        { id: 'g1', name: 'depth', type: 'number' },
        { id: 'g2', name: 'site', type: 'object', children: [{ id: 'g21', name: 'parish', type: 'string' }] },
      ] }], '✎ Schema updated')
    })
    expect(screen.getByRole('listitem', { name: 'depth' })).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: 'parish' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse grave' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keyboard: Enter edits, Delete removes with undo, Space toggles a group', () => {
    renderPanel({ panelNodes: [{ id: 'g', name: 'grave', type: 'object', children: [{ id: 'g1', name: 'depth', type: 'number' }] }, ...nodes] })
    const group = screen.getByRole('listitem', { name: 'grave' })
    expect(screen.getByRole('listitem', { name: 'depth' })).toBeInTheDocument()
    fireEvent.keyDown(group, { key: ' ' })
    expect(screen.queryByRole('listitem', { name: 'depth' })).not.toBeInTheDocument()
    expect(within(group).getByText(/object · 1 field$/)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'title' }), { key: 'Enter' })
    expect(screen.getByDisplayValue('title')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByDisplayValue('title'), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'gender' }), { key: 'Delete' })
    expect(screen.queryByRole('listitem', { name: 'gender' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    // Focus moves to the next row, else the previous row, else "+ Add field" — never to the page body.
    expect(screen.getByRole('listitem', { name: 'title' })).toHaveFocus()
    fireEvent.keyDown(group, { key: 'Delete' })
    expect(screen.getByRole('listitem', { name: 'title' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'title' }), { key: 'Delete' })
    expect(screen.getByRole('button', { name: '+ Add field' })).toHaveFocus()
  })

  it('read-only: a note is plain text, Enter and Delete do nothing, and Space still toggles a group', () => {
    const setup = renderPanel({ panelNodes: [{ id: 'g', name: 'grave', type: 'object', children: [{ id: 'g1', name: 'depth', type: 'number' }] }, ...nodes] }, { readOnly: true })
    expect(screen.getByText('Research rule').closest('button')).toBeNull()
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'title' }), { key: 'Delete' })
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'title' }), { key: 'Enter' })
    expect(setup.edits).toHaveLength(0)
    expect(screen.queryByPlaceholderText('field_name')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'grave' }), { key: ' ' })
    expect(screen.queryByRole('listitem', { name: 'depth' })).not.toBeInTheDocument()
  })

  it('Undo is refused when a sibling now has the field\'s name', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Delete title' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    fireEvent.change(screen.getByPlaceholderText('field_name'), { target: { value: 'title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByText('Could not restore the field')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem', { name: 'title' })).toHaveLength(1)
  })

  it('the Undo toast outlasts the default 2.6 s and goes after eight seconds', () => {
    vi.useFakeTimers()
    try {
      renderPanel()
      fireEvent.click(screen.getByRole('button', { name: 'Delete title' }))
      act(() => { vi.advanceTimersByTime(2_600) })
      expect(screen.getByText('Field removed')).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(5_400) })
      expect(screen.queryByText('Field removed')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a replaced draft dismisses a pending Undo', () => {
    const setup = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Delete title' }))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    act(() => { setup.schema.adoptDraft({ recordDescription: 'An imported record.', schemaNodes: [{ id: 'year', name: 'year', type: 'integer' }] }) })
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(screen.queryByText('Field removed')).not.toBeInTheDocument()
  })

  it('a proposal row whose change is only its allowed values still shows them', async () => {
    renderPanel()
    await send({
      status: 'proposed',
      fields: {
        title: { name: 'title', type: 'string', removed: false },
        gender: { name: 'gender', type: 'string', removed: false, allowedValues: ['woman', 'man', 'other'] },
      },
      additions: [],
      issues: [],
    })
    const row = screen.getByRole('listitem', { name: 'gender' })
    expect(within(row).getByRole('checkbox', { name: 'Accept change to gender' })).toBeInTheDocument()
    const values = within(row).getByText('3 values')
    expect(values).toHaveAttribute('title', 'Allowed values: woman, man, other')
    expect(values.closest('button')).toBeNull()
  })
})

describe('chat composer and drawer (redesign §7)', () => {
  const proposalResponse: SchemaEditResponse = {
    status: 'proposed',
    fields: {
      title: { name: 'heading', type: 'string', removed: false },
      gender: { name: 'gender', type: 'string', removed: false },
    },
    additions: [],
    issues: [],
  }

  it('is one composer line at rest, with no greeting, and expands on send', async () => {
    renderPanel({ durableScope: true })
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Edit through drag and drop/)).not.toBeInTheDocument()
    requestSchemaEdit.mockResolvedValueOnce(proposalResponse)
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Rename title to heading' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('region', { name: 'Conversation' })).toBeInTheDocument()
    expect(screen.getByText('Rename title to heading')).toBeInTheDocument()
    await screen.findByRole('button', { name: 'Apply changes' })
  })

  it('a pending proposal keeps the drawer open; the chevron hides it without discarding and the dot brings it back', async () => {
    renderPanel({ durableScope: true })
    requestSchemaEdit.mockResolvedValueOnce(proposalResponse)
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Rename title to heading' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByRole('button', { name: 'Apply changes' })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversation' }))
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show conversation' }))
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
  })

  it('before a schema exists the instructions conversation is open with Generate schema in its header', () => {
    const onGenerateInstructions = vi.fn()
    renderPanel({ durableScope: true, noSchema: true }, { onGenerateInstructions })
    const drawer = screen.getByRole('region', { name: 'Conversation' })
    expect(within(drawer).getByRole('button', { name: /^Generate schema/ })).toBeInTheDocument()
    const input = screen.getByPlaceholderText(/Add a generation instruction/)
    fireEvent.change(input, { target: { value: 'Focus on dates' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(within(drawer).getByText('Focus on dates')).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: /^Generate schema/ }))
    expect(onGenerateInstructions).toHaveBeenCalledWith('Focus on dates')
  })

  it('the new schema rests with one composer line, though instructions opened the drawer before it', async () => {
    const setup = renderPanel({ durableScope: true, noSchema: true }, { onGenerateInstructions: vi.fn() })
    const input = screen.getByPlaceholderText(/Add a generation instruction/)
    fireEvent.change(input, { target: { value: 'Focus on dates' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument()

    await act(async () => {
      await setup.schema.generate(async () => ({ _description: 'One test record.', title: 'string' }))
    })

    expect(await screen.findByPlaceholderText('Describe a change to the schema…')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
  })

  it('a collapsed instructions drawer comes back from the dot, with its instructions and Generate schema', () => {
    renderPanel({ durableScope: true, noSchema: true }, { onGenerateInstructions: vi.fn() })
    const input = screen.getByPlaceholderText(/Add a generation instruction/)
    fireEvent.change(input, { target: { value: 'Focus on dates' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversation' }))
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show conversation' }))
    const drawer = screen.getByRole('region', { name: 'Conversation' })
    expect(within(drawer).getByText('Focus on dates')).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: /^Generate schema/ })).toBeInTheDocument()
  })

  it('an empty instruction does not reopen the collapsed drawer', () => {
    renderPanel({ durableScope: true, noSchema: true }, { onGenerateInstructions: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversation' }))
    fireEvent.keyDown(screen.getByPlaceholderText(/Add a generation instruction/), { key: 'Enter' })
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
  })

  it('a proposal that arrives while the drawer is collapsed opens it with the Apply bar', async () => {
    let resolveResponse!: (response: SchemaEditResponse) => void
    requestSchemaEdit.mockReturnValueOnce(new Promise<SchemaEditResponse>((resolve) => {
      resolveResponse = resolve
    }))
    renderPanel({ durableScope: true })
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Rename title to heading' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByRole('button', { name: 'Stop schema edit request' })
    await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversation' }))
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()

    await act(async () => resolveResponse(proposalResponse))

    const drawer = await screen.findByRole('region', { name: 'Conversation' })
    expect(within(drawer).getByRole('button', { name: 'Apply changes' })).toBeVisible()
  })

  it('Discard closes the drawer', async () => {
    renderPanel({ durableScope: true })
    requestSchemaEdit.mockResolvedValueOnce(proposalResponse)
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Rename title to heading' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByRole('button', { name: 'Apply changes' })

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show conversation' })).toBeInTheDocument()
  })
})
