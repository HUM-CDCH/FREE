// @vitest-environment jsdom

import type { ReactNode } from 'react'
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
import type { ExtractionInspection, RailTab } from './RightRail'
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
  tab = 'schema',
  inspection = defaultInspection,
  extraction = defaultController,
  latestReader = null,
  currentSchemaRevision = null,
  schema = testSchema(),
  onSelectEvidence = vi.fn(),
  selection = createSelectionChannel(),
  documentHistory,
}: {
  open?: boolean
  tab?: RailTab
  inspection?: ExtractionInspection
  extraction?: ExtractionController
  latestReader?: DurableReader | null
  currentSchemaRevision?: CurrentResultSchema | null
  schema?: SchemaEditorController
  onSelectEvidence?: (anchor: ParsedEvidenceAnchor) => void
  selection?: SelectionChannel
  documentHistory?: (visible: boolean) => ReactNode
} = {}) {
  const rail = (open: boolean) => (
    <RightRail
      open={open}
      onToggle={vi.fn()}
      tab={tab}
      onTabChange={vi.fn()}
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
    />
  )
  const view = render(rail(open))
  return { ...view, setOpen: (next: boolean) => view.rerender(rail(next)) }
}
const results = () => vi.mocked(DurableResults).mock.lastCall![0]

describe('RightRail Results', () => {
  it('passes the acknowledged schema summary and labels retained results during a new admission',()=>{
    const currentSchemaRevision={schemaRevisionId:'revision-14',revisionNumber:14,recordScope:'document' as const}
    renderRail({tab:'results',currentSchemaRevision,inspection:{...defaultInspection,attempt},
      extraction:{...defaultController,attempt,admitting:true}})
    expect(screen.getByText('A new extraction has not been acknowledged yet. These are previous results.')).toBeVisible()
    expect(results().currentSchema).toEqual(currentSchemaRevision)
    expect(results().controlled).toBe(true)
  })
  it('reviews every Extraction with the durable reader, at the live cut unless an explicit one is named', () => {
    const selection = createSelectionChannel()
    renderRail({ tab: 'results', extraction: { ...defaultController, attempt }, selection })
    expect(screen.getByText('Durable results')).toBeVisible()
    expect(vi.mocked(DurableResults).mock.lastCall![0]).toMatchObject({ attempt, initialCut: null, readOnly: false })
    // The workspace's one channel, passed through.
    expect(vi.mocked(DurableResults).mock.lastCall![0].selection).toBe(selection)
    cleanup()
    const cut = { snapshotVersion: 1, feedbackVersion: 2 }
    renderRail({ tab: 'results', inspection: { ...defaultInspection, attempt, cut, readOnly: true } })
    expect(vi.mocked(DurableResults).mock.lastCall![0]).toMatchObject({ attempt, initialCut: cut, readOnly: true })
  })

  it('gives guidance and saved versions their own History tab, only when there is an Extraction', () => {
    renderRail({ tab: 'history' })
    expect(screen.queryByRole('tab', { name: 'History' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Schema/i })).toHaveAttribute('aria-selected', 'true')
    cleanup()
    renderRail({ tab: 'history', extraction: { ...defaultController, attempt } })
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toContainElement(vi.mocked(DurableResults).mock.lastCall![0].historySlot as HTMLElement)
    expect(vi.mocked(DurableResults).mock.lastCall![0].historyShown).toBe(true)
  })

  it('puts the document History above the shown Extraction’s, told when it is visible', () => {
    const documentHistory = vi.fn((visible: boolean) => <p>Document history {String(visible)}</p>)
    renderRail({ tab: 'history', extraction: { ...defaultController, attempt }, documentHistory })
    const panel = screen.getByRole('tabpanel')
    expect(panel.firstElementChild).toHaveTextContent('Document history true')
    expect(panel.lastElementChild).toBe(vi.mocked(DurableResults).mock.lastCall![0].historySlot)
    cleanup()
    renderRail({ tab: 'results', extraction: { ...defaultController, attempt }, documentHistory })
    expect(documentHistory).toHaveBeenLastCalledWith(false)
  })

  it('keeps the document History when no Extraction is shown, e.g. all read an earlier source text', () => {
    renderRail({ tab: 'history', documentHistory: (visible) => <p>Document history {String(visible)}</p> })
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Document history true')
    cleanup()
    renderRail({ tab: 'history' })
    expect(screen.queryByRole('tab', { name: 'History' })).not.toBeInTheDocument()
  })

  it('says how to start when there is no Extraction, and offers Reconnect for an unanswered admission', () => {
    const reconnect = vi.fn()
    renderRail({ tab: 'results', extraction: { ...defaultController, monitorError: 'Unable to update status. The extraction may still be running.', reconnect } })
    expect(screen.getByText('No results yet')).toBeVisible()
    expect(screen.getByText('Press ▶ Run extraction above.')).toBeVisible()
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

  it('names the shown Extraction\'s lifecycle in a badge that stays on one line', () => {
    renderRail({ extraction: { ...defaultController, attempt } })
    const results = screen.getByRole('tab', { name: /^Results\s*paused$/ })
    const badge = within(results).getByRole('img', { name: 'paused' })
    expect(badge.className).toMatch(/(^|\s)whitespace-nowrap(\s|$)/)
    expect(within(results).getByText('Results').className).toMatch(/(^|\s)min-w-0(\s|$)/)
  })
})

describe('RightRail developer UI visibility', () => {
  it('hides the Evidence tab by default', () => {
    renderRail({ open: true })

    expect(screen.queryByRole('tab', { name: /Evidence/i })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Schema/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Results/i })).toBeInTheDocument()
  })

  it('falls back to Schema when the hidden Evidence tab was selected', () => {
    renderRail({ open: true, tab: 'evidence' })

    expect(screen.getByRole('tab', { name: /Schema/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('displays collapsed strip without Evidence by default', () => {
    renderRail({ open: false })

    expect(screen.getByText('Schema · Results')).toBeInTheDocument()
    expect(screen.queryByText('Evidence · Schema · Results')).not.toBeInTheDocument()
  })

  it('restores the Evidence tab when VITE_SHOW_DEVELOPER_UI=true', () => {
    vi.stubEnv('VITE_SHOW_DEVELOPER_UI', 'true')
    renderRail({ open: true })

    expect(screen.getByRole('tab', { name: /Evidence/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Schema/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Results/i })).toBeInTheDocument()
  })

  it('displays collapsed strip with Evidence when VITE_SHOW_DEVELOPER_UI=true', () => {
    vi.stubEnv('VITE_SHOW_DEVELOPER_UI', 'true')
    renderRail({ open: false })

    expect(screen.getByText('Evidence · Schema · Results')).toBeInTheDocument()
  })
})

describe('RightRail collapsed', () => {
  it('keeps every body mounted, hidden beside the strip, and the same nodes once expanded', () => {
    const view = renderRail({ tab: 'results', extraction: { ...defaultController, attempt } })
    const body = screen.getByText('Durable results'), chat = screen.getByPlaceholderText('Describe a change to the schema…')
    const slot = results().historySlot
    view.setOpen(false)
    expect(screen.getByText('Schema · Results · History')).toBeVisible()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(body).toBeInTheDocument()
    expect(body).not.toBeVisible()
    expect(chat).not.toBeVisible()
    expect(results().railOpen).toBe(false)
    expect(results().historySlot).toBe(slot)
    view.setOpen(true)
    // Nothing was mounted again: one-by-one, drafts, an input edit, an export and a chat request go on.
    expect(screen.getByText('Durable results')).toBe(body)
    expect(screen.getByText('Durable results')).toBeVisible()
    expect(screen.getByPlaceholderText('Describe a change to the schema…')).toBe(chat)
    expect(screen.queryByText('Schema · Results · History')).not.toBeInTheDocument()
    expect(results().railOpen).toBe(true)
    expect(results().historySlot).toBe(slot)
  })

  it('reads History\'s saved versions only while History shows', () => {
    const view = renderRail({ tab: 'history', extraction: { ...defaultController, attempt } })
    expect(results().historyShown).toBe(true)
    view.setOpen(false)
    expect(results().historyShown).toBe(false)
    view.setOpen(true)
    expect(results().historyShown).toBe(true)
  })

  it('moves nothing on the document while collapsed', () => {
    const parsedDocument = decodeParsedDocument(rawDocument), anchor = parsedDocument.evidence_index.anchors[0]!
    const onSelectEvidence = vi.fn()
    const view = renderRail({ tab: 'results', extraction: { ...defaultController, attempt }, inspection: { ...defaultInspection, parsedDocument }, onSelectEvidence })
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

  it('keeps a schema chat request running through a collapse', async () => {
    const schema = testSchema()
    vi.spyOn(schema, 'requestModelEdit').mockResolvedValue({ projectContextId: 'project', extractionSchemaId: 'schema', schemaRevisionId: 'revision' })
    vi.mocked(requestSchemaEdit).mockReturnValue(new Promise(() => {}))
    const view = renderRail({ schema })
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
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
