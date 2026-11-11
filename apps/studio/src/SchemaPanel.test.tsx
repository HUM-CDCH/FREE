// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Profiler, useEffect, useState } from 'react'
import type { ModelOperation } from '../shared/modelOperation.contract'
import type { SchemaEditResponse } from '../shared/schemaEdit.contract'
import type { SchemaRevision, SchemaRevisionSummary } from '../shared/schemaRevision.contract'
import { nodesToTemplate, type SchemaDefinition, type SchemaNode } from 'extraction/schema'
import SchemaPanel from './SchemaPanel'
import { useSchemaProposalReview, type SchemaProposalReview } from './useSchemaProposalReview'
import { ProposalReviewBar } from './SchemaProposalReview'
import { deriveSchemaProposal } from '../shared/schemaChanges'
import { schemaAncestorIds } from './schemaEditorTree'
import * as schemaTree from './schemaEditorTree'
import { testSchemaPersistence } from './test/schemaPersistence'

let suppliedReview: SchemaProposalReview
let suppliedSchema: SchemaEditorController
/** Supplies review state to the actual editor; hosts own chat, routing and Regenerate. */
function EditorFixture(props: Omit<React.ComponentProps<typeof SchemaPanel>, 'proposalReview' | 'revealed'>) {
  const [messages, setMessages] = useState<string[]>([])
  const review = useSchemaProposalReview(props.schema, message => setMessages(current => [...current, message]))
  useEffect(() => { suppliedReview = review; suppliedSchema = props.schema }, [review, props.schema])
  const pending = review.pending
  const ids = new Set(pending?.changes.map(change => change.id) ?? [])
  return <><SchemaPanel {...props} proposalReview={review} revealed={{ seq: pending ? 1 : 0, ids: schemaAncestorIds(pending?.reviewNodes ?? [], ids) }} />
    {pending && <ProposalReviewBar proposal={pending} canApply={review.canApply} onApply={review.apply} onDiscard={review.discard} />}
    {messages.map((message, index) => <p key={index}>{message}</p>)}
  </>
}
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
const { listModelOperations } = vi.hoisted(() => ({
  listModelOperations: vi.fn<() => Promise<ModelOperation[]>>(async () => []),
}))
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
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
    stabilisedAt: null,
    summary: '1 renamed',
  },
  {
    schemaRevisionId: '51000000-0000-4000-8004-000000000001',
    extractionSchemaId: '51000000-0000-4000-8003-000000000001',
    revisionNumber: 1,
    origin: 'suggestion',
    recordScope: null,
    createdAt: '2026-08-01T12:00:00.000Z',
    stabilisedAt: null,
    summary: 'Initial template',
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
  let acknowledged: AcknowledgedSchemaRevision = {
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
    ...testSchemaPersistence(),
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
      return acknowledged = latest
        ? {
            ...acknowledged,
            revisionNumber: acknowledged.revisionNumber + edits.length,
            ...latest,
          }
        : acknowledged
    },
    saveState() {
      return !noSchema ? { status: 'saved', acknowledged, draft: acknowledged, recordScope: 'document' } : null
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

type PanelProps = Partial<React.ComponentProps<typeof EditorFixture>>

function renderPanel(
  setupOptions: Parameters<typeof setupController>[0] = {},
  renderProps: PanelProps = {},
): PanelSetup & {
  /** Renders the same controller with new props; the setup options of the first render stay. */
  rerender: (setupOptions: Parameters<typeof setupController>[0], renderProps: PanelProps) => void
} {
  const setup = setupController(setupOptions)
  const panel = (props: PanelProps) => (
    <EditorFixture
      schema={setup.schema}
      onClearDraft={() => setup.schema.reset()}
      sourceDocumentName="test.pdf"
      {...props}
    />
  )
  const { rerender } = render(panel(renderProps))
  return { ...setup, rerender: (_setupOptions, props) => rerender(panel(props)) }
}

/** The pointer leaving `from` for `to`, as a browser reports it: React derives every mouseleave and mouseenter from
 *  the `mouseout`'s relatedTarget, so only elements between the two change. (`fireEvent.mouseEnter` alone enters from
 *  outside the window, which re-enters every ancestor.) */
function pointerMove(from: Element, to: Element) {
  fireEvent.mouseOut(from, { relatedTarget: to })
  fireEvent.mouseOver(to, { relatedTarget: from })
}

/** Opens the header's "Schema actions" menu and chooses `name`. */
function chooseSchemaAction(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Template actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name }))
}

async function send(response: Extract<SchemaEditResponse, { status: 'proposed' }>) {
  const snap = suppliedSchema.snapshot()
  const original = snap.draft!.schemaNodes
  const proposal = deriveSchemaProposal(original, response)
  await act(async () => suppliedReview.start(proposal, original, snap.draftVersion, snap.extractableSchemaRevisionId, null))
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe.sequential('SchemaPanel template proposal review', () => {
  it('shows and selectively accepts a scalar note-only proposal, then flushes that note in the saved definition', async () => {
    const setup = renderPanel()
    await send({
      status: 'proposed',
      fields: { title: { name: 'title', type: 'string', removed: false, description: 'Copy the full heading exactly.' } },
      additions: [], issues: [],
    })
    expect(screen.getByLabelText('Previous note')).toHaveTextContent('Research rule')
    expect(screen.getByLabelText('Proposed note')).toHaveTextContent('Copy the full heading exactly.')
    expect(setup.edits).toHaveLength(0)
    const accept = screen.getByRole('checkbox', { name: 'Accept change to title' })
    fireEvent.click(accept)
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled()
    fireEvent.click(accept)
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))
    expect(setup.edits).toHaveLength(1)
    expect(setup.edits[0]).toEqual({ recordDescription: 'One test record.', schemaNodes: [
      { ...nodes[0], description: 'Copy the full heading exactly.' }, nodes[1],
    ] })
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('listitem', { name: 'title' })).getByText('Copy the full heading exactly.')).toBeInTheDocument()
    await act(async () => {
      expect(await setup.schema.flush()).toMatchObject(setup.edits[0])
    })
    expect(setup.schema.snapshot().draft?.schemaNodes).toEqual(setup.edits[0].schemaNodes)
  })

  it('shows a proposed scalar note clear before it can be applied', async () => {
    const setup = renderPanel()
    await send({
      status: 'proposed',
      fields: { title: { name: 'title', type: 'string', removed: false, description: '' } },
      additions: [], issues: [],
    })
    expect(screen.getByLabelText('Previous note')).toHaveTextContent('Research rule')
    expect(screen.getByText('Note removed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))
    expect(setup.edits[0].schemaNodes[0]).toEqual({ id: 'title', name: 'title', type: 'string' })
  })


  it('renames the durable template from the schema/chat header', async () => {
    const onRenameSchema = vi.fn(async () => null)
    const setup = renderPanel({}, { schemaName: 'Places', onRenameSchema })

    fireEvent.click(screen.getByRole('button', { name: 'Rename template Places' }))
    fireEvent.change(screen.getByLabelText('Template name for Places'), {
      target: { value: 'Historic places' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save template name' }))

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
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Template history' })).getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByText('historical_place')).toBeInTheDocument()

    expect(setup.events).toEqual(['load'])
    expect(setup.edits).toHaveLength(0)
    expect(loadRevision).toHaveBeenCalledWith('51000000-0000-4000-8004-000000000001')
    expect(screen.queryByRole('button', { name: '+ Add field' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Template actions' })).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Create Current Template Revision' }),
    )
    await waitFor(() => expect(setup.edits).toHaveLength(1))
    expect(setup.events).toEqual(['load', 'flush', 'edit', 'flush'])
    expect(setup.edits[0]).toEqual({
      recordDescription: 'One historical record.',
      schemaNodes: historicalNodes,
    })
    expect(screen.getByText('historical_year')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add field' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Template actions' })).toBeInTheDocument()
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
    expect(screen.getByText('Regenerating. The current saved template remains available.').parentElement)
      .toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Template actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Regenerate from the document…' })).not.toBeInTheDocument()

    await act(async () => {
      rejectGeneration(new Error('Model unavailable'))
      await generation
    })

    expect(screen.getByText('title')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Regeneration failed: Model unavailable The current saved template is unchanged.',
    )
    expect(screen.getByRole('button', { name: 'Edit title' })).toBeEnabled()
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

  it('keeps the current template when loading or pre-creation flushing fails', async () => {
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
      screen.getByRole('button', { name: 'Create Current Template Revision' }),
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
      screen.getByRole('button', { name: 'Create Current Template Revision' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Append failed')
    expect(setup.edits).toHaveLength(1)
    expect(setup.edits[0]).toEqual({
      recordDescription: 'One historical record.',
      schemaNodes: historicalNodes,
    })
    expect(screen.getByText('historical_place')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add field' })).toBeInTheDocument()
    expect(setup.schema.snapshot().draft?.schemaNodes).toEqual(historicalNodes)
    expect(screen.queryByRole('button', { name: 'Close preview' })).not.toBeInTheDocument()
  })

  it('shows the description button for a leaf field and accumulates its notes', async () => {
    const setup = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Add note to title' }))
    const editor = screen.getByRole('textbox', { name: 'Field notes' })
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue('Research rule')
    fireEvent.change(editor, { target: { value: 'Research rule\nSecond note' } })
    expect(setup.edits).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setup.schema.snapshot().draft?.schemaNodes[0].description).toBe('Research rule\nSecond note')
  })

  it('clears every accumulated note on a field in one action', async () => {
    const setup = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Add note to title' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Field notes' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setup.schema.snapshot().draft?.schemaNodes[0].description).toBeUndefined()
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit leaf' }))
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
      expect(within(screen.getByRole('list', { name: 'Template fields' })).getAllByRole('listitem')
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit nyt_felt' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Edit gender' }))
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

  it('the values pill opens the edit form focused on its allowed values; the type pill and Edit on the name', () => {
    renderPanel()
    fireEvent.click(screen.getByTitle('Allowed values — click to edit: woman, man'))
    expect(screen.getByRole('textbox', { name: 'Add allowed value' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel field edit' }))

    fireEvent.click(within(screen.getByRole('listitem', { name: 'title' })).getByTitle('Type: string — click to edit'))
    expect(screen.getByDisplayValue('title')).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel field edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit gender' }))
    expect(screen.getByDisplayValue('gender')).toHaveFocus()
  })

  it('counts one allowed value as "1 value"', () => {
    renderPanel({ panelNodes: [{ id: 'kind', name: 'kind', type: 'string', allowedValues: ['grave'] }] })
    expect(screen.getByTitle('Allowed values — click to edit: grave')).toHaveTextContent(/^1 value$/)
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
    const setup = renderPanel({ panelNodes: [{ id: 'dates', name: 'dates', type: 'array', itemType: 'date' }, { id: 'title', name: 'title', type: 'string' }] })
    const title = screen.getByRole('listitem', { name: 'title' })
    fireEvent.mouseDown(title.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseEnter(screen.getByRole('listitem', { name: 'dates' }))
    fireEvent.mouseMove(window, { clientX: 1, clientY: 30 }); fireEvent.mouseUp(window)
    expect(setup.edits).toHaveLength(0)
    expect(setup.schema.snapshot().draft?.schemaNodes[0]).toMatchObject({ type: 'array', itemType: 'date' })
  })

  it('preserves the complete template when a nested field is moved into a sibling array', async () => {
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
    fireEvent.mouseMove(window, { clientX: 1, clientY: 30 }); fireEvent.mouseUp(window)

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

  it('does not truncate the template when a group is dropped into its own contents', async () => {
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
    fireEvent.mouseMove(window, { clientX: 1, clientY: 30 }); fireEvent.mouseUp(window)

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot move field into its own contents.')
    expect(setup.edits).toHaveLength(0)
    expect(screen.getByText('grave')).toBeInTheDocument()
    expect(screen.getByText('year')).toBeInTheDocument()
    expect(screen.getByText('new_field')).toBeInTheDocument()
  })

  it('re-renders nothing for a mouse move while no field is dragged', async () => {
    const setup = setupController()
    const onRender = vi.fn()
    render(
      <Profiler id="schema" onRender={onRender}>
        <EditorFixture schema={setup.schema} onClearDraft={() => setup.schema.reset()} sourceDocumentName="test.pdf" />
      </Profiler>,
    )
    await act(async () => {})
    const commits = onRender.mock.calls.length
    fireEvent.mouseMove(window, { clientX: 10, clientY: 20 })
    fireEvent.mouseMove(window, { clientX: 30, clientY: 40 })
    expect(onRender).toHaveBeenCalledTimes(commits)
  })

  it('a drag from the slot above an open group into its header drops the field into the group', async () => {
    const setup = renderPanel({ panelNodes: [
      { id: 'title', name: 'title', type: 'string' },
      { id: 'grave', name: 'grave', type: 'object', children: [{ id: 'depth', name: 'depth', type: 'number' }] },
    ] })
    const titleRow = screen.getByRole('listitem', { name: 'title' })
    const graveRow = screen.getByRole('listitem', { name: 'grave' })
    const slot = graveRow.previousElementSibling!

    fireEvent.mouseDown(titleRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 0, clientY: 26 })
    pointerMove(titleRow, slot)
    fireEvent.mouseMove(window, { clientX: 0, clientY: 36 })
    pointerMove(slot, graveRow)
    expect(within(graveRow).getByText('into grave')).toBeInTheDocument()
    fireEvent.mouseMove(window, { clientX: 1, clientY: 30 }); fireEvent.mouseUp(window)

    await waitFor(() => expect(setup.edits).toHaveLength(1))
    expect(setup.edits[0].schemaNodes).toStrictEqual([
      { id: 'grave', name: 'grave', type: 'object', children: [
        { id: 'depth', name: 'depth', type: 'number' }, { id: 'title', name: 'title', type: 'string' },
      ] },
    ])
  })

  it('a drag from a child row up into its parent header drops the field into the parent', async () => {
    const setup = renderPanel({ panelNodes: [
      { id: 'grave', name: 'grave', type: 'object', children: [
        { id: 'depth', name: 'depth', type: 'number' }, { id: 'width', name: 'width', type: 'number' },
      ] },
      { id: 'title', name: 'title', type: 'string' },
    ] })
    const titleRow = screen.getByRole('listitem', { name: 'title' })
    const widthRow = screen.getByRole('listitem', { name: 'width' })
    const graveRow = screen.getByRole('listitem', { name: 'grave' })

    fireEvent.mouseDown(titleRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 0, clientY: 70 })
    pointerMove(titleRow, widthRow)
    // A scalar under the pointer is still a target that would become a group (unchanged).
    expect(within(widthRow).getByText('into width')).toBeInTheDocument()
    fireEvent.mouseMove(window, { clientX: 0, clientY: 10 })
    pointerMove(widthRow, graveRow)
    expect(within(graveRow).getByText('into grave')).toBeInTheDocument()
    expect(within(widthRow).queryByText('into width')).not.toBeInTheDocument()
    fireEvent.mouseMove(window, { clientX: 1, clientY: 30 }); fireEvent.mouseUp(window)

    await waitFor(() => expect(setup.edits).toHaveLength(1))
    expect(setup.edits[0].schemaNodes).toStrictEqual([
      { id: 'grave', name: 'grave', type: 'object', children: [
        { id: 'depth', name: 'depth', type: 'number' }, { id: 'width', name: 'width', type: 'number' },
        { id: 'title', name: 'title', type: 'string' },
      ] },
    ])
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
    fireEvent.mouseMove(window, { clientX: 1, clientY: 30 }); fireEvent.mouseUp(window)

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot move field')
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
    fireEvent.mouseMove(window, { clientX: 1, clientY: 30 }); fireEvent.mouseUp(window)

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
    expect(screen.getByText(/"name": "surname"/)).toBeInTheDocument()
    expect(screen.getByText(/"name": "name"/)).toBeInTheDocument()
  })

  it('shows one row per node, mixed counts, metadata reach, and applies atomically', async () => {
    const setup = renderPanel()
    await send({
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
    expect(setup.schema.snapshot().editingBlockedReason).toContain('pending proposal')

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
    await send({ status: 'proposed', fields: { title: { name: 'heading', type: 'string', removed: false }, gender: { name: 'heading', type: 'string', removed: false } }, additions: [], issues: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))
    expect(setup.edits).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
    expect(setup.schema.snapshot().useBlockedReason).toContain('pending proposal')
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

  it('discards the proposal without changing the template', async () => {
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



  it('discards a proposal when the record description changes during review', async () => {
    const setup = renderPanel()
    await send({ status: 'proposed', fields: { title: { name: 'heading', type: 'string', removed: false }, gender: { name: 'gender', type: 'string', removed: false } }, additions: [], issues: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }))
    expect(setup.schema.snapshot().input).toBeNull()
    expect(setup.edits).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }))
    expect(screen.getByRole('textbox', { name: 'What one record is' })).toHaveValue('One test record.')
  })












})


describe('SchemaPanel conflict recovery', () => {
  it('lets the researcher reload the winning Current Template Revision', async () => {
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
      stabilisedAt: null,
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
    ...testSchemaPersistence(),
      ...testSchemaPersistence(),
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
      <EditorFixture
        schema={schema}
        onClearDraft={() => undefined}
        sourceDocumentName="test.pdf"
      />,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Reload Current Template Revision',
      }),
    )

    await waitFor(() => expect(screen.getByText('rival')).toBeVisible())
    expect(schema.snapshot().save?.status).toBe('saved')
    expect(schema.snapshot().extractableSchemaRevisionId).toBe(
      winning.schemaRevisionId,
    )
  })
})

describe('SchemaPanel clear current template', () => {
  it('requires confirmation before resetting the template', () => {
    const onClearDraft = vi.fn(async () => {})
    renderPanel({}, { onClearDraft })

    chooseSchemaAction('Clear template')
    expect(screen.getByText('Clear current template?')).toBeInTheDocument()
    expect(onClearDraft).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Clear current template?')).not.toBeInTheDocument()
    expect(onClearDraft).not.toHaveBeenCalled()
  })

  it('closes an armed clear confirmation when the draft is replaced', async () => {
    const setup = renderPanel()
    chooseSchemaAction('Clear template')
    expect(screen.getByText('Clear current template?')).toBeInTheDocument()

    act(() => {
      setup.schema.replaceDraft({
        recordDescription: 'One replacement record.',
        schemaNodes: historicalNodes,
      }, 'replacement')
    })

    await waitFor(() =>
      expect(
        screen.queryByText('Clear current template?'),
      ).not.toBeInTheDocument(),
    )
    expect(screen.getByText('historical_place')).toBeVisible()
  })

  it('clears local template state after the workspace accepts the reset', async () => {
    const setup = renderPanel()
    const onClearDraft = vi.fn(async () => {
      await setup.schema.reset()
    })
    cleanup()
    render(<EditorFixture
      schema={setup.schema}
      onClearDraft={onClearDraft}
      sourceDocumentName="test.pdf"
    />)

    chooseSchemaAction('Clear template')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear current template' })).getByRole('button', { name: 'Clear template' }))

    expect(onClearDraft).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(setup.schema.snapshot().draft).toBeNull())
    await waitFor(() =>
      expect(screen.queryByText('Clear current template?')).not.toBeInTheDocument(),
    )
    expect(screen.queryByText(nodes[0].name)).not.toBeInTheDocument()
    expect(screen.getByText('No template yet')).toBeInTheDocument()
  })

  it('clears a history failure after a successful template reset', async () => {
    const setup = renderPanel({
      getRevision: async () => {
        throw new Error('Load failed')
      },
    })
    chooseSchemaAction('History')
    fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed')

    chooseSchemaAction('Clear template')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear current template' })).getByRole('button', { name: 'Clear template' }))

    await waitFor(() => expect(setup.schema.snapshot().draft).toBeNull())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('No template yet')).toBeVisible()
  })

  it('keeps the editor when the workspace cannot flush the template', async () => {
    const onClearDraft = vi.fn(async () => {
      throw new Error('The Current Template Revision has changed.')
    })
    renderPanel({}, { onClearDraft })

    chooseSchemaAction('Clear template')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear current template' })).getByRole('button', { name: 'Clear template' }))

    await waitFor(() => expect(onClearDraft).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Clear current template?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit title' })).toBeInTheDocument()
  })
})

describe('template header (redesign §5)', () => {

  it('the actions menu opens the import dialog', () => {
    renderPanel({ durableScope: true })
    expect(screen.queryByRole('dialog', { name: 'Import from Excel codebook' })).not.toBeInTheDocument()
    chooseSchemaAction('Import from Excel codebook…')
    expect(screen.getByRole('dialog', { name: 'Import from Excel codebook' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Import from Excel codebook' })).not.toBeInTheDocument()
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

  it('a historical preview shows its own record scope, read-only, and choosing a scope there saves nothing', async () => {
    const onChange = vi.fn()
    const setup = renderPanel({
      getRevision: async () => ({ ...schemaHistory[1], recordScope: 'document', recordDescription: 'One historical record.', schemaNodes: historicalNodes }),
    }, { recordScope: { value: 'records', onChange } })
    expect(screen.getByLabelText('Record scope')).toHaveDisplayValue('Catalog · a collection of records')
    chooseSchemaAction('History')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Template history' })).getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByText('historical_place')).toBeInTheDocument()

    const scope = screen.getByLabelText('Record scope')
    expect(scope).toHaveDisplayValue('Article · one object for the document')
    expect(scope).toBeDisabled()
    fireEvent.change(scope, { target: { value: 'records' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(setup.edits).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(screen.getByLabelText('Record scope')).toHaveDisplayValue('Catalog · a collection of records')
    expect(screen.getByLabelText('Record scope')).toBeEnabled()
  })

  it('a historical preview saved without a scope asks for one, still read-only', async () => {
    renderPanel({}, { recordScope: { value: 'records', onChange: vi.fn() } })
    chooseSchemaAction('History')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Template history' })).getByRole('button', { name: /Revision 1/ }))
    expect(await screen.findByText('historical_place')).toBeInTheDocument()
    expect(screen.getByLabelText('Record scope')).toHaveDisplayValue('Choose Article or Catalog')
    expect(screen.getByLabelText('Record scope')).toBeDisabled()
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

  it('the record description grows with its wrapped text from two rows to six, not only with line breaks', () => {
    // jsdom has no layout: a description's height is its length in 40-character lines of 19.5px, plus 8px padding.
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLTextAreaElement) { return Math.max(1, Math.ceil(this.value.length / 40)) * 19.5 + 8 })
    try {
      renderPanel()
      fireEvent.click(screen.getByRole('button', { name: 'Edit description' }))
    const description = screen.getByLabelText('What one record is') as HTMLTextAreaElement
      expect(description.rows).toBe(2)
      fireEvent.change(description, { target: { value: 'One grave '.repeat(16) } }) // 160 characters, one line: four rows
      expect(description.rows).toBe(4)
      fireEvent.change(description, { target: { value: 'One grave '.repeat(60) } })
      expect(description.rows).toBe(6)
      fireEvent.change(description, { target: { value: 'One grave.' } })
      expect(description.rows).toBe(2)
    } finally {
      scrollHeight.mockRestore()
    }
  })

  it('the record description re-measures when its width changes (a rail resize, a tab shown again), not when only its height does', async () => {
    // jsdom has no layout: the text wraps at `perLine` characters, each line 19.5px, plus 8px padding.
    let perLine = 40
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLTextAreaElement) { return Math.max(1, Math.ceil(this.value.length / perLine)) * 19.5 + 8 })
    type Observed = { callback: ResizeObserverCallback; targets: Element[]; disconnected: boolean; observer: ResizeObserver }
    const observed: Observed[] = []
    vi.stubGlobal('ResizeObserver', class {
      record: Observed
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: [], disconnected: false, observer: this as unknown as ResizeObserver }
        observed.push(this.record)
      }
      observe(target: Element) { this.record.targets.push(target) }
      unobserve() {}
      disconnect() { this.record.disconnected = true }
    })
    try {
      renderPanel()
      fireEvent.click(screen.getByRole('button', { name: 'Edit description' }))
    const description = screen.getByLabelText('What one record is') as HTMLTextAreaElement
      const watching = observed.filter((record) => record.targets.includes(description))
      expect(watching).toHaveLength(1)
      // A notification, then the next frame, where the measurement runs.
      const resize = async (width: number, height: number) => {
        act(() => watching[0]!.callback(
          [{ target: description, contentRect: { width, height } } as unknown as ResizeObserverEntry], watching[0]!.observer))
        await act(() => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) }))
      }
      fireEvent.change(description, { target: { value: 'One grave '.repeat(16) } }) // 160 characters: four rows
      expect(description.rows).toBe(4)
      await resize(300, 86)
      // Narrower: the same text wraps into more rows, with no keystroke.
      perLine = 32
      await resize(240, 86)
      expect(description.rows).toBe(5)
      // A height-only notification (the rows just set) is not a reason to measure.
      perLine = 80
      await resize(240, 105)
      expect(description.rows).toBe(5)
      // Hidden (0px wide) and shown again at a new width: measured once it shows.
      await resize(0, 0)
      expect(description.rows).toBe(5)
      await resize(480, 105)
      expect(description.rows).toBe(2)
      cleanup()
      expect(watching[0]!.disconnected).toBe(true)
    } finally {
      scrollHeight.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('Edit as code opens the code view ready to edit; long lines scroll sideways in both modes', () => {
    renderPanel()
    chooseSchemaAction('Edit as code')
    const editor = screen.getByRole('textbox', { name: 'Template code' }) as HTMLTextAreaElement
    expect(editor.value).toContain('"title"')
    expect(editor).toHaveAttribute('wrap', 'off')
    expect(editor.className).toMatch(/\boverflow-x-auto\b/)
    expect(editor.className).toMatch(/\bwhitespace-pre\b/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    const code = screen.getByText(/"recordDescription"/).closest('pre')!
    expect(code.className).toMatch(/\boverflow-x-auto\b/)
    expect(code.className).toMatch(/\bwhitespace-pre\b/)
  })

  it('Code keeps invalid raw input until Cancel, then starts a new edit from the saved definition', () => {
    renderPanel()
    chooseSchemaAction('Edit as code')
    const editor = () => screen.getByRole('textbox', { name: 'Template code' })
    const edited = (editor() as HTMLTextAreaElement).value.replace('"title"', '"report_title"')
    fireEvent.change(editor(), { target: { value: edited } })
    expect(editor()).toHaveValue(edited)
    // An error stays with the code it describes.
    fireEvent.change(editor(), { target: { value: '{ "unfinished": ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText(/Unexpected end of JSON input/)).toBeInTheDocument()
    expect(editor()).toHaveValue('{ "unfinished": ')
    expect(screen.getByText(/Unexpected end of JSON input/)).toBeInTheDocument()
    // Cancel ends the session: the next Edit as code starts from the saved definition.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    chooseSchemaAction('Edit as code')
    expect((editor() as HTMLTextAreaElement).value).toContain('"title"')
    expect((editor() as HTMLTextAreaElement).value).not.toContain('report_title')
  })

  it('refuses to save a code draft over field edits made since it was opened', async () => {
    const setup = renderPanel()
    chooseSchemaAction('Edit as code')
    const editor = screen.getByRole('textbox', { name: 'Template code' })
    fireEvent.change(editor, { target: { value: '{ unfinished' } })
    expect(setup.schema.snapshot().editingBlockedReason).toContain('Save or Cancel')
    expect(setup.schema.commit(() => [], 'late').ok).toBe(false)
    expect(editor).toHaveValue('{ unfinished')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Edit gender' })).not.toBeDisabled()
  })


  it('a history preview banner stacks its text above its commands, which wrap, so both fit the 264px rail', async () => {
    renderPanel()
    chooseSchemaAction('History')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Template history' })).getByRole('button', { name: /Revision 1/ }))
    await screen.findByText('historical_place')
    const text = screen.getByText(/Viewing historical Template Revision 1/)
    const banner = text.closest('[role="status"]')!
    expect(banner.className).toMatch(/(^|\s)flex-col(\s|$)/)
    expect(text.className).toMatch(/(^|\s)min-w-0(\s|$)/)
    const commands = screen.getByRole('button', { name: 'Close preview' }).parentElement!
    expect(commands.className).toMatch(/(^|\s)flex-wrap(\s|$)/)
    expect(commands).toContainElement(screen.getByRole('button', { name: 'Create Current Template Revision' }))
    expect(text.compareDocumentPosition(commands) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })


  it('labels the record description "What one record is" and saves it explicitly after blur', () => {
    const setup = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }))
    const description = screen.getByLabelText('What one record is')
    fireEvent.change(description, { target: { value: 'One grave.' } })
    fireEvent.blur(description)
    expect(setup.edits).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setup.schema.snapshot().draft?.recordDescription).toBe('One grave.')
    expect(screen.queryByText('Record description')).not.toBeInTheDocument()
  })

  it('the footer says the saved revision and never counts fields', () => {
    renderPanel({ durableScope: true })
    expect(screen.getByText('Saved · revision 2')).toBeInTheDocument()
    expect(screen.queryByText(/\d+ fields?\s*$/)).not.toBeInTheDocument()
  })



})

describe('field rows (redesign §6)', () => {
  // Geometry (264px and 344px rails, nested rows, a long name with six values, Tab) is measured in a real browser:
  // e2e/field-row-widths.spec.ts. These are the class contract and the DOM interactions jsdom can check.
  it('shows the name in full beside word pills that wrap under it, overlays the actions on hover or focus, and has no selection checkboxes', () => {
    renderPanel({ panelNodes: [...nodes, { id: 'dates', name: 'dates', type: 'array', itemType: 'date' },
      { id: 'sex', name: 'sex', type: 'string', allowedValues: ['f', 'm', 'unknown', 'child', 'adult', 'elder'] }] })
    const row = screen.getByRole('listitem', { name: 'sex' })
    const name = within(row).getByText('sex')
    expect(name.className).toMatch(/\bshrink-0\b/)
    expect(name.parentElement!.className).toMatch(/\bflex-wrap\b/)
    // The pills' line keeps the actions' constant 140px clear, so the pills wrap before the actions; the name alone may
    // run under them, up to the whole line. A row line under 296px starts the pills on the line below the name instead,
    // at full width (the row line is the size container).
    expect(name.parentElement!.className).toMatch(/(^|\s)pr-\[140px\](\s|$)/)
    expect(name.parentElement!.className).toMatch(/(^|\s)@max-\[296px\]:pr-0(\s|$)/)
    expect(name.parentElement!.parentElement!.className).toMatch(/(^|\s)@container(\s|$)/)
    expect(name.className).toMatch(/(^|\s)max-w-\[calc\(100%_\+_140px\)\](\s|$)/)
    expect(name.className).toMatch(/(^|\s)@max-\[296px\]:basis-full(\s|$)/)
    // From 240px, where the actions still overlay the first line, that line is as tall as the overlay (28px) so the pills
    // start below it; a line height, never a flex name, which would stop a long name's ellipsis.
    expect(name.className).toMatch(/(^|\s)@min-\[240px\]:@max-\[296px\]:min-h-7(\s|$)/)
    expect(name.className).toMatch(/(^|\s)@min-\[240px\]:@max-\[296px\]:leading-7(\s|$)/)
    expect(name.className).not.toMatch(/(^|\s)(@[^\s]*:)?flex(\s|$)/)
    expect(within(row).getByText('6 values')).toBeInTheDocument()
    expect(within(row).getByTitle('Type: string — click to edit')).toBeInTheDocument()
    expect(within(screen.getByRole('listitem', { name: 'dates' })).getByTitle('Type: list of dates — click to edit')).toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    const actions = within(row).getByRole('button', { name: 'Delete sex' }).parentElement!
    // An overlay on the row's right edge reserves no width at rest.
    expect(actions.className).toMatch(/\babsolute\b/)
    expect(actions.className).toMatch(/\bright-0\b/)
    expect(actions.className).toMatch(/\bbg-surface\b/)
    expect(actions.className).toMatch(/(^|\s)opacity-0\b/)
    expect(actions.className).toMatch(/group-hover:opacity-100/)
    expect(actions.className).toMatch(/group-focus-within:opacity-100/)
    // Hidden, it takes no hits: a tap at the row's right end at rest never reaches an unseen action.
    expect(actions.className).toMatch(/(^|\s)pointer-events-none(\s|$)/)
    expect(actions.className).toMatch(/(^|\s)group-hover:pointer-events-auto(\s|$)/)
    expect(actions.className).toMatch(/(^|\s)group-focus-within:pointer-events-auto(\s|$)/)
    // At least the 140px the pills keep clear, wider when a fallback font or a larger text size needs it (never wrapping
    // a word or overflowing leftwards).
    expect(actions.className).toMatch(/(^|\s)w-max(\s|$)/)
    expect(actions.className).toMatch(/(^|\s)min-w-\[140px\](\s|$)/)
    // Worded, not icons explained by tooltips (decision 11): Edit, Note, Delete, 28px tall, the names kept.
    const worded = [['Edit sex', 'Edit'], ['Add note to sex', 'Note'], ['Delete sex', 'Delete']] as const
    for (const [label, text] of worded) {
      const action = within(row).getByRole('button', { name: label })
      expect(action).toHaveTextContent(text)
      expect(action).not.toHaveAttribute('title')
      expect(action.className).toMatch(/(^|\s)h-7(\s|$)/)
      expect(action.className).toMatch(/(^|\s)min-w-7(\s|$)/)
      expect(action.className).toMatch(/(^|\s)text-compact(\s|$)/)
      expect(action.className).toMatch(/(^|\s)font-semibold(\s|$)/)
      expect(action.className).toMatch(/(^|\s)whitespace-nowrap(\s|$)/)
      expect(action.querySelector('svg')).toBeNull()
    }
    expect(within(row).getByRole('button', { name: 'Delete sex' }).className).toMatch(/(^|\s)text-danger(\s|$)/)
    expect(actions.className).toMatch(/(^|\s)gap-1(\s|$)/)
    // On a row line under 240px (the 264px rail) the actions are no overlay: they take their own line in the pills'
    // flow, below the pills, shown on hover or focus within, so the name and the disclosure stay in view. The line keeps
    // its place at rest (no collapse, so no row moves under a click).
    expect(name.parentElement!).toContainElement(actions)
    for (const narrow of ['@max-[240px]:static', '@max-[240px]:basis-full', '@max-[240px]:justify-start', '@max-[240px]:w-auto'])
      expect(actions.className.split(/\s+/)).toContain(narrow)
    expect(actions.className).not.toMatch(/h-0\b/)
  })

  it('while a field is dragged every row keeps its actions line in place, hidden and out of reach', () => {
    renderPanel()
    const titleRow = screen.getByRole('listitem', { name: 'title' })
    const genderRow = screen.getByRole('listitem', { name: 'gender' })
    const restingActions = within(titleRow).getByRole('button', { name: 'Delete title' }).parentElement!
    expect(restingActions.className.split(/\s+/)).not.toContain('invisible')
    expect(restingActions).not.toHaveAttribute('inert')
    // A grip pressed and not yet moved: on a narrow row line the actions span is the row's reserved line, so it keeps
    // its layout box (mounted, `invisible`, not removed), and `inert` keeps its buttons from focus and the accessibility tree.
    fireEvent.mouseDown(genderRow.querySelector('span')!, { button: 0, clientX: 0, clientY: 0 })
    for (const [row, name] of [[titleRow, 'title'], [genderRow, 'gender']] as const) {
      const actions = row.querySelector<HTMLElement>('[data-row-actions]')
      expect(actions).not.toBeNull()
      expect(actions!.className.split(/\s+/)).toContain('invisible')
      expect(actions).toHaveAttribute('inert')
      expect(within(actions!).getByText('Edit')).toBeInTheDocument()
      expect(within(actions!).getByText('Note')).toBeInTheDocument()
      expect(within(actions!).getByText('Delete')).toBeInTheDocument()
      // jsdom implements neither `inert` (focus, accessibility tree) nor the stylesheet behind `invisible`, so the attribute
      // and the class are the contract here; e2e/field-row-widths.spec.ts measures the real browser.
      expect(within(actions!).getByText('Delete')).toHaveAttribute('aria-label', `Delete ${name}`)
    }
    fireEvent.mouseMove(window, { clientX: 1, clientY: 30 }); fireEvent.mouseUp(window)
    const after = within(screen.getByRole('listitem', { name: 'title' })).getByRole('button', { name: 'Delete title' }).parentElement!
    expect(after.className.split(/\s+/)).not.toContain('invisible')
    expect(after).not.toHaveAttribute('inert')
  })


  it('Tab reaches the row actions after its pills, and their focus is focus within the row', () => {
    renderPanel()
    const row = screen.getByRole('listitem', { name: 'title' })
    const tabOrder = Array.from(row.querySelectorAll<HTMLElement>('button, [tabindex]'))
      .filter((element) => element !== row && !element.hasAttribute('disabled') && element.tabIndex >= 0)
      .map((element) => element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent)
    expect(tabOrder).toEqual(['Type: string — click to edit', 'Edit title', 'Add note to title', 'Delete title', 'Research rule'])
    const edit = within(row).getByRole('button', { name: 'Edit title' })
    edit.focus()
    expect(edit).toHaveFocus()
    // What `group-focus-within:` and `focus-within:` match: the overlay shows while one of its actions has focus.
    expect(row.matches(':focus-within')).toBe(true)
    expect(edit.parentElement!.matches(':focus-within')).toBe(true)
    // While a pill has keyboard focus the overlay steps aside instead of covering it.
    expect(within(row).getByTitle('Type: string — click to edit')).toHaveAttribute('data-row-pill')
    expect(edit.parentElement!.className).toMatch(/group-has-\[\[data-row-pill\]:focus-visible\]:opacity-0/)
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

  it('Undo saves the complete original tree, a surviving group\'s extraction metadata included', () => {
    const original: SchemaNode[] = [
      { id: 'grave', name: 'grave', type: 'object', valueSource: 'document', evidencePolicy: 'derived', children: [
        { id: 'depth', name: 'depth', type: 'number' }, { id: 'width', name: 'width', type: 'number' },
      ] },
      { id: 'title', name: 'title', type: 'string' },
    ]
    const setup = renderPanel({ panelNodes: original })
    fireEvent.click(within(screen.getByRole('listitem', { name: 'depth' })).getByRole('button', { name: 'Delete depth' }))
    expect(setup.edits.at(-1)!.schemaNodes).toStrictEqual([
      { ...original[0], children: [{ id: 'width', name: 'width', type: 'number' }] }, original[1],
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(setup.edits.at(-1)!.schemaNodes).toStrictEqual(original)
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
    expect(screen.getByRole('textbox', { name: 'Field notes' })).toBeInTheDocument()
  })

  it('a group that first appears after mount shows its children without a click', () => {
    const setup = renderPanel()
    act(() => {
      setup.schema.commit((current) => [...current, { id: 'g', name: 'grave', type: 'object', children: [
        { id: 'g1', name: 'depth', type: 'number' },
        { id: 'g2', name: 'site', type: 'object', children: [{ id: 'g21', name: 'parish', type: 'string' }] },
      ] }], '✎ Template updated')
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
    act(() => { setup.schema.replaceDraft({ recordDescription: 'An imported record.', schemaNodes: [{ id: 'year', name: 'year', type: 'integer' }] }, 'replacement') })
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

it('full Code preserves identity and metadata, assigns new IDs and rejects duplicate IDs without losing text', () => {
  const setup = renderPanel({ panelNodes: [{ id: 'stable', name: 'title', type: 'string', description: 'All notes', valueSource: 'source-filename', evidencePolicy: 'unverified' }] })
  chooseSchemaAction('Edit as code')
  const editor = screen.getByRole('textbox', { name: 'Template code' })
  const value = JSON.parse((editor as HTMLTextAreaElement).value)
  value.schemaNodes[0].name = 'heading'
  value.schemaNodes.push({ name: 'year', type: 'integer' })
  fireEvent.change(editor, { target: { value: JSON.stringify(value) } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const saved = setup.schema.snapshot().draft!
  expect(saved.schemaNodes[0]).toEqual({ id: 'stable', name: 'heading', type: 'string', description: 'All notes', valueSource: 'source-filename', evidencePolicy: 'unverified' })
  expect(saved.schemaNodes[1].id).toBeTruthy()
  chooseSchemaAction('Edit as code')
  value.schemaNodes[1].id = 'stable'
  const text = JSON.stringify(value)
  fireEvent.change(screen.getByRole('textbox', { name: 'Template code' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.getByRole('alert')).toHaveTextContent('IDs must be unique')
  expect(screen.getByRole('textbox', { name: 'Template code' })).toHaveValue(text)
  expect(setup.edits).toHaveLength(1)
})

it('an open form defers Undo without consuming it', () => {
  const setup = renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Delete title' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit gender' }))
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  expect(setup.schema.snapshot().draft?.schemaNodes.map(node => node.name)).toEqual(['gender'])
  fireEvent.click(screen.getByRole('button', { name: 'Cancel field edit' }))
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(setup.schema.snapshot().draft?.schemaNodes.map(node => node.name)).toEqual(['title', 'gender'])
})

it('Move offers root and group slots and preserves compatible metadata', () => {
  const setup = renderPanel({ panelNodes: [
    { id: 'group', name: 'grave', type: 'object', children: [] },
    { id: 'title', name: 'title', type: 'string', description: 'Keep this note.', evidencePolicy: 'quoted' },
  ] })
  fireEvent.click(screen.getByText('Move title'))
  fireEvent.change(screen.getByLabelText('Destination parent'), { target: { value: 'group' } })
  fireEvent.click(screen.getByRole('button', { name: 'Move' }))
  expect(setup.schema.snapshot().draft?.schemaNodes).toEqual([
    { id: 'group', name: 'grave', type: 'object', children: [
      { id: 'title', name: 'title', type: 'string', description: 'Keep this note.', evidencePolicy: 'quoted' },
    ] },
  ])
  fireEvent.click(screen.getByText('Move title'))
  fireEvent.change(screen.getByLabelText('Destination parent'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Insertion position'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Move' }))
  expect(setup.schema.snapshot().draft?.schemaNodes.map(node => node.id)).toEqual(['group', 'title'])
})

it('History uses the header presentation selector and renders just one Code control', async () => {
  renderPanel()
  chooseSchemaAction('History')
  fireEvent.click(screen.getByRole('button', { name: /Revision 1/ }))
  await screen.findByText('historical_place')
  expect(screen.getAllByRole('button', { name: 'Code' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Code' }))
  expect(screen.getByText(/"recordDescription": "One historical record\."/)).toBeInTheDocument()
  expect(screen.queryByRole('list', { name: 'Template fields' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
  expect(screen.getByRole('listitem', { name: 'historical_place' })).toBeInTheDocument()
})

it('closes Move when its draft is replaced', () => {
  const setup = renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Move title' }))
  expect(screen.getByRole('dialog', { name: 'Move field' })).toBeVisible()
  act(() => setup.schema.replaceDraft({ recordDescription: 'Replacement.', schemaNodes: [{ id: 'new', name: 'new', type: 'string' }] }, ''))
  expect(screen.queryByRole('dialog', { name: 'Move field' })).not.toBeInTheDocument()
  expect(screen.getByRole('listitem', { name: 'new' })).toBeVisible()
})

it('does no speculative Move transformations until one field is selected, regardless of schema size', () => {
  const transform = vi.spyOn(schemaTree, 'moveSchemaNodes')
  try {
    renderPanel({ panelNodes: Array.from({ length: 50 }, (_, index) => ({ id: `field-${index}`, name: `field_${index}`, type: 'string' as const })) })
    expect(transform).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Move field' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Move field_0' }))
    expect(transform).toHaveBeenCalledTimes(1)
    const dialog = screen.getByRole('dialog', { name: 'Move field' })
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(2)
    expect(within(dialog).getAllByRole('option')).toHaveLength(52)
    fireEvent.change(within(dialog).getByLabelText('Insertion position'), { target: { value: '50' } })
    expect(transform).toHaveBeenCalledTimes(2)
    expect(within(dialog).getByRole('button', { name: 'Move' })).toBeEnabled()
  } finally { transform.mockRestore() }
})

it('Move applies to the current tree when an independent accepted edit precedes its click in the same turn', () => {
  const setup = renderPanel({ panelNodes: [{ id: 'a', name: 'first', type: 'string' }, { id: 'b', name: 'second', type: 'string' }] })
  fireEvent.click(screen.getByRole('button', { name: 'Move first' }))
  fireEvent.change(screen.getByLabelText('Insertion position'), { target: { value: '2' } })
  const apply = within(screen.getByRole('dialog', { name: 'Move field' })).getByRole('button', { name: 'Move' })
  act(() => {
    setup.schema.commit(nodes => [...nodes, { id: 'c', name: 'third', type: 'string' }], 'independent edit')
    fireEvent.click(apply)
  })
  expect(setup.schema.snapshot().draft?.schemaNodes.map(node => node.id)).toEqual(['b', 'a', 'c'])
})
