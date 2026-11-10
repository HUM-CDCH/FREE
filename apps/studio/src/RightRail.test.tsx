// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
import rawDocument from './assets/parsed_document.v2.json'
import RightRail from './RightRail'
import { DurableResults } from './DurableResults'
import { requestSchemaEdit } from './api'
import { createSelectionChannel, type SelectionChannel } from './selectionChannel'
import type { ExtractionController } from './useExtraction'
import type { ExtractionInspection, RailView } from './RightRail'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import type { ParsedEvidenceAnchor } from 'extraction/parsed-document'
import type { DurableReader } from './durableReader'
import type { CurrentResultSchema } from './resultSchema'
import {
  createSchemaEditorController,
  localSchemaPersistence,
  type SchemaEditorController,
} from './currentSchemaRevision'

vi.mock('./DurableResults', () => ({ DurableResults: vi.fn(() => <p>Durable results</p>) }))
vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), requestSchemaEdit: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.mocked(DurableResults).mockClear()
  vi.mocked(requestSchemaEdit).mockReset()
})

const defaultController: ExtractionController = {
  attempt: null,
  admitting: false,
  canRun: true,
  retryAdmission: null,
  acceptDurableStatus: () => {},
  runExtraction: async () => null,
  monitorError: null,
  reconnect: () => {},
}

const defaultInspection: ExtractionInspection = {
  attempt: null,
  cut: null,
  readOnly: false,
  parsedDocument: null,
  reader: null,
}

const attempt = {
  extractionId: 'extraction-1', sourceDocumentId: 'document-1', sourceRepresentationRevisionId: 'source-1',
  schemaRevisionId: 'revision-1', strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, requestedSettings: null,
  executionStatus: 'PAUSED', finalizedReview: null, batchExtractionId: null, createdAt: '2026-10-05T00:00:00.000Z',
} satisfies ExtractionAttempt

function testSchema(): SchemaEditorController {
  return createSchemaEditorController(
    localSchemaPersistence({ onEdit: () => {} }),
    {
      initialDraft: {
        recordDescription: 'One record.',
        schemaNodes: [
          { id: 'title', name: 'title', type: 'string' },
          { id: 'gender', name: 'gender', type: 'string' },
        ],
      },
    },
  )
}
/** The rail, and `setOpen` to collapse or expand that same rail as its toggle (or "Review now") does. */
function renderRail({
  open = true,
  view = 'chat',
  onViewChange = vi.fn(),
  inspection = defaultInspection,
  extraction = defaultController,
  latestReader = null,
  currentSchemaRevision = null,
  schema = testSchema(),
  onSelectEvidence = vi.fn(),
  selection = createSelectionChannel(),
  documentHistory,
  run = null,
  project = null,
}: {
  open?: boolean
  view?: RailView
  onViewChange?: (view: RailView) => void
  inspection?: ExtractionInspection
  extraction?: ExtractionController
  latestReader?: DurableReader | null
  currentSchemaRevision?: CurrentResultSchema | null
  schema?: SchemaEditorController
  onSelectEvidence?: (anchor: ParsedEvidenceAnchor) => void
  selection?: SelectionChannel
  documentHistory?: (visible: boolean) => ReactNode
  run?: { start: () => void; available: boolean } | null
  project?: ComponentProps<typeof RightRail>['project']
} = {}) {
  const rail = (open: boolean) => (
    <RightRail
      open={open}
      onToggle={vi.fn()}
      view={view}
      onViewChange={onViewChange}
      schema={schema}
      onClearDraft={vi.fn()}
      extraction={extraction}
      inspection={inspection}
      latestReader={latestReader}
      currentSchemaRevision={currentSchemaRevision}
      sourceDocumentName="test.pdf"
      sourceRepresentationId="source-representation"
      onSelectEvidence={onSelectEvidence}
      selection={selection}
      documentHistory={documentHistory}
      recordScope={{ value: 'document', onChange: vi.fn() }}
      run={run}
      project={project}
    />
  )
  const rendered = render(rail(open))
  return { ...rendered, setOpen: (next: boolean) => rendered.rerender(rail(next)) }
}
const results = () => vi.mocked(DurableResults).mock.lastCall![0]

describe('RightRail Results', () => {
  it('passes the acknowledged template summary and labels retained results during a new admission',()=>{
    const currentSchemaRevision={schemaRevisionId:'revision-14',revisionNumber:14,recordScope:'document' as const}
    renderRail({view:'results',currentSchemaRevision,inspection:{...defaultInspection,attempt},
      extraction:{...defaultController,attempt,admitting:true}})
    expect(screen.getByText('A new extraction has not been acknowledged yet. These are previous results.')).toBeVisible()
    expect(results().currentSchema).toEqual(currentSchemaRevision)
    expect(results().controlled).toBe(true)
  })
  it('reviews every Extraction with the durable reader, at the live cut unless an explicit one is named', () => {
    const selection = createSelectionChannel()
    renderRail({ view: 'results', extraction: { ...defaultController, attempt }, selection })
    expect(screen.getByText('Durable results')).toBeVisible()
    expect(vi.mocked(DurableResults).mock.lastCall![0]).toMatchObject({ attempt, initialCut: null, readOnly: false })
    // The workspace's one channel, passed through.
    expect(vi.mocked(DurableResults).mock.lastCall![0].selection).toBe(selection)
    cleanup()
    const cut = { snapshotVersion: 1, feedbackVersion: 2 }
    renderRail({ view: 'results', inspection: { ...defaultInspection, attempt, cut, readOnly: true } })
    expect(vi.mocked(DurableResults).mock.lastCall![0]).toMatchObject({ attempt, initialCut: cut, readOnly: true })
  })

  it('gives guidance and saved versions their own History view, only when there is an Extraction', () => {
    renderRail({ view: 'history' })
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Project chat' })).toBeInTheDocument()
    cleanup()
    renderRail({ view: 'history', extraction: { ...defaultController, attempt } })
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'History' })).toContainElement(vi.mocked(DurableResults).mock.lastCall![0].historySlot as HTMLElement)
    expect(vi.mocked(DurableResults).mock.lastCall![0].historyShown).toBe(true)
  })

  it('puts the document History above the shown Extraction’s, told when it is visible', () => {
    const documentHistory = vi.fn((visible: boolean) => <p>Document history {String(visible)}</p>)
    renderRail({ view: 'history', extraction: { ...defaultController, attempt }, documentHistory })
    const panel = screen.getByRole('region', { name: 'History' })
    expect(panel.firstElementChild).toHaveTextContent('Document history true')
    expect(panel.lastElementChild).toBe(vi.mocked(DurableResults).mock.lastCall![0].historySlot)
    cleanup()
    renderRail({ view: 'results', extraction: { ...defaultController, attempt }, documentHistory })
    expect(documentHistory).toHaveBeenLastCalledWith(false)
  })

  it('keeps the document History when no Extraction is shown, e.g. all read an earlier source text', () => {
    renderRail({ view: 'history', documentHistory: (visible) => <p>Document history {String(visible)}</p> })
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'History' })).toHaveTextContent('Document history true')
    cleanup()
    renderRail({ view: 'history' })
    expect(screen.queryByRole('heading', { name: 'History' })).not.toBeInTheDocument()
  })

  it('says how to start when there is no Extraction, and offers Reconnect for an unanswered admission', () => {
    const reconnect = vi.fn()
    renderRail({ view: 'results', extraction: { ...defaultController, monitorError: 'Unable to update status. The extraction may still be running.', reconnect } })
    expect(screen.getByText('No results yet')).toBeVisible()
    expect(screen.getByText('The chat offers Run extraction as its next step.')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('may still be running')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(reconnect).toHaveBeenCalledOnce()
    expect(DurableResults).not.toHaveBeenCalled()
  })

  it('sends Reconnect to the error\'s owner: admission while it is uncertain, else the latest reader', () => {
    const refresh = vi.fn(async () => {}), reconnect = vi.fn()
    const reading = { error: 'Extraction status is unavailable.' }
    const latestReader = { subscribe: () => () => {}, snapshot: () => reading, refresh } as unknown as DurableReader
    renderRail({ extraction: { ...defaultController, attempt, reconnect }, latestReader })
    expect(screen.getByRole('alert')).toHaveTextContent('Extraction status is unavailable.')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(refresh).toHaveBeenCalledOnce()
    cleanup()
    renderRail({ extraction: { ...defaultController, attempt, reconnect, monitorError: 'Unable to update status.' }, latestReader })
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to update status.')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(reconnect).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('names the template and the shown Extraction\'s lifecycle under the chat, each opening its view and leading back', () => {
    const onViewChange = vi.fn()
    renderRail({ extraction: { ...defaultController, attempt }, onViewChange })
    const context = screen.getByRole('navigation', { name: 'Template and results' })
    fireEvent.click(within(context).getByRole('button', { name: 'Open results: test.pdf · paused' }))
    expect(onViewChange).toHaveBeenLastCalledWith('results')
    fireEvent.click(within(context).getByRole('button', { name: 'Open template: 2 fields · Article' }))
    expect(onViewChange).toHaveBeenLastCalledWith('schema')
    cleanup()
    renderRail({ view: 'schema', onViewChange })
    expect(screen.queryByRole('navigation', { name: 'Template and results' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(onViewChange).toHaveBeenLastCalledWith('chat')
  })
})

describe('RightRail developer UI visibility', () => {
  it('hides the Evidence view by default', () => {
    renderRail({ open: true })

    expect(screen.queryByRole('button', { name: 'Evidence' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Open template/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Open results/ })).toBeInTheDocument()
  })

  it('falls back to the chat when the hidden Evidence view was selected', () => {
    renderRail({ open: true, view: 'evidence' })

    expect(screen.getByRole('heading', { name: 'Project chat' })).toBeInTheDocument()
  })

  it('names the view in the collapsed strip', () => {
    renderRail({ open: false })
    // The strip's word, beside the hidden header that keeps its own.
    expect(screen.getByText('Project chat', { selector: 'span' })).toBeVisible()
    cleanup()
    renderRail({ open: false, view: 'results' })
    expect(screen.getByText('Project chat · Results')).toBeInTheDocument()
  })

  it('restores the Evidence view when VITE_SHOW_DEVELOPER_UI=true', () => {
    vi.stubEnv('VITE_SHOW_DEVELOPER_UI', 'true')
    const onViewChange = vi.fn()
    renderRail({ open: true, onViewChange })

    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }))
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith('evidence')
  })
})

describe('RightRail collapsed', () => {
  it('keeps every body mounted, hidden beside the strip, and the same nodes once expanded', () => {
    const view = renderRail({ view: 'results', extraction: { ...defaultController, attempt } })
    const body = screen.getByText('Durable results'), chat = screen.getByPlaceholderText('Describe a change to the template…')
    const slot = results().historySlot
    view.setOpen(false)
    expect(screen.getByText('Project chat · Results')).toBeVisible()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(body).toBeInTheDocument()
    expect(body).not.toBeVisible()
    expect(chat).not.toBeVisible()
    expect(results().railOpen).toBe(false)
    expect(results().historySlot).toBe(slot)
    view.setOpen(true)
    // Nothing was mounted again: one-by-one, drafts, an input edit, an export and a chat request go on.
    expect(screen.getByText('Durable results')).toBe(body)
    expect(screen.getByText('Durable results')).toBeVisible()
    expect(screen.getByPlaceholderText('Describe a change to the template…')).toBe(chat)
    expect(screen.queryByText('Project chat · Results')).not.toBeInTheDocument()
    expect(results().railOpen).toBe(true)
    expect(results().historySlot).toBe(slot)
  })

  it('reads History\'s saved versions only while History shows', () => {
    const view = renderRail({ view: 'history', extraction: { ...defaultController, attempt } })
    expect(results().historyShown).toBe(true)
    view.setOpen(false)
    expect(results().historyShown).toBe(false)
    view.setOpen(true)
    expect(results().historyShown).toBe(true)
  })

  it('moves nothing on the document while collapsed', () => {
    const parsedDocument = decodeParsedDocument(rawDocument), anchor = parsedDocument.evidence_index.anchors[0]!
    const onSelectEvidence = vi.fn()
    const view = renderRail({ view: 'results', extraction: { ...defaultController, attempt }, inspection: { ...defaultInspection, parsedDocument }, onSelectEvidence })
    view.setOpen(false)
    results().onEvidence(anchor.anchor_id)
    expect(onSelectEvidence).not.toHaveBeenCalled()
    view.setOpen(true)
    results().onEvidence(anchor.anchor_id)
    expect(onSelectEvidence).toHaveBeenCalledExactlyOnceWith(anchor, undefined)
  })

  it('mounts the status banner only while open, so expanding announces its alert', () => {
    const reading = { error: 'Extraction status is unavailable.' }
    const latestReader = { subscribe: () => () => {}, snapshot: () => reading, refresh: vi.fn() } as unknown as DurableReader
    const view = renderRail({ extraction: { ...defaultController, attempt }, latestReader })
    view.setOpen(false)
    expect(screen.queryByText('Extraction status is unavailable.')).not.toBeInTheDocument()
    view.setOpen(true)
    expect(screen.getByRole('alert')).toHaveTextContent('Extraction status is unavailable.')
  })

  it('passes the focus to the other toggle on each collapse and expand, and moves none on mount', () => {
    const view = renderRail()
    expect(document.body).toHaveFocus()
    view.setOpen(false)
    expect(screen.getByTitle('Expand panel')).toHaveFocus()
    view.setOpen(true)
    expect(screen.getByTitle('Collapse panel')).toHaveFocus()
  })

  it('keeps the template chat\'s composer under every view, not only the chat', () => {
    renderRail({ view: 'results', extraction: { ...defaultController, attempt } })
    expect(document.getElementById('rail-panel-schema')).not.toBeVisible()
    expect(screen.getByPlaceholderText('Describe a change to the template…')).toBeVisible()
  })

  it('keeps a template chat request running through a collapse', async () => {
    const schema = testSchema()
    vi.spyOn(schema, 'requestModelEdit').mockResolvedValue({ projectContextId: 'project', extractionSchemaId: 'schema', schemaRevisionId: 'revision' })
    vi.mocked(requestSchemaEdit).mockReturnValue(new Promise(() => {}))
    const view = renderRail({ schema })
    const input = screen.getByPlaceholderText('Describe a change to the template…')
    fireEvent.change(input, { target: { value: 'Check fields' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(requestSchemaEdit).toHaveBeenCalledOnce())
    const signal = vi.mocked(requestSchemaEdit).mock.calls[0]![2]!
    view.setOpen(false)
    view.setOpen(true)
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
  })
})

describe('RightRail asked to extract in the chat', () => {
  const summary = { phase: 'pilot' as const, extractionCount: 0, extractedSourceDocumentCount: 0, reviewedSourceDocumentCount: 0,
    staleSourceDocumentCount: 0, pendingExtractionSourceDocumentCount: 3, schemaDraftCount: 0, currentSchemaRevisionId: 'revision',
    schemaStabilised: false, currentSchemaRevisionReviewed: false, lastActivityAt: '2026-11-01T00:00:00.000Z', runningBatch: null }
  const documents = [{ id: 'here', name: 'test.pdf' }, { id: 'b', name: 'b.pdf' }, { id: 'c', name: 'c.pdf' }]

  async function ask(text: string) {
    const input = screen.getByPlaceholderText('Describe a change to the template…')
    fireEvent.change(input, { target: { value: text } })
    fireEvent.keyDown(input, { key: 'Enter' })
    return screen.findByRole('region', { name: 'Extract' })
  }

  it('lets the researcher run this document alone, and offers the project\'s documents only once the template is saved', async () => {
    const schema = testSchema()
    // The model context names the revision the draft stands on, so the reply is not taken as stale.
    vi.spyOn(schema, 'requestModelEdit').mockResolvedValue({ projectContextId: 'project', extractionSchemaId: 'schema',
      schemaRevisionId: schema.snapshot().extractableSchemaRevisionId as string })
    vi.mocked(requestSchemaEdit).mockResolvedValue({ status: 'requested', action: 'extract' })
    const run = { start: vi.fn(), available: true }
    const project = { guide: { summary, documents, currentDocumentId: 'here', batches: [], latest: null, roundId: null, busy: false, error: null },
      start: vi.fn(), approve: vi.fn(), stopBatch: vi.fn(), open: vi.fn(), export: vi.fn() }
    renderRail({ schema, run, project })

    let step = await ask('Generate the results')
    expect(screen.getByText('Choose what to extract below.')).toBeInTheDocument()
    fireEvent.click(within(step).getByRole('button', { name: /^Only this document/ }))
    expect(run.start).toHaveBeenCalledOnce()
    expect(screen.queryByRole('region', { name: 'Extract' })).not.toBeInTheDocument()

    // This draft has no saved revision yet, so nothing of the project can run on it; Esc ends the request.
    step = await ask('Now extract the others too')
    expect(within(step).queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.keyDown(step, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Extract' })).not.toBeInTheDocument()
    expect(project.start).not.toHaveBeenCalled()
  })

  it('leaves the template as it is for a message that changes nothing, and says how to extract', async () => {
    const schema = testSchema()
    // The model context names the revision the draft stands on, so the reply is not taken as stale.
    vi.spyOn(schema, 'requestModelEdit').mockResolvedValue({ projectContextId: 'project', extractionSchemaId: 'schema',
      schemaRevisionId: schema.snapshot().extractableSchemaRevisionId as string })
    vi.mocked(requestSchemaEdit).mockResolvedValue({ status: 'proposed', fields: {}, additions: [], issues: [] })
    renderRail({ schema })
    const input = screen.getByPlaceholderText('Describe a change to the template…')
    fireEvent.change(input, { target: { value: 'keep it' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText(/That leaves the template as it is/)).toBeInTheDocument()
  })
})
