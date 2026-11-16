// @vitest-environment jsdom
import { testSchemaPersistence } from './test/schemaPersistence'

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RailChat, { type RailChatProps } from './RailChat'
import { useSchemaChat } from './useSchemaChat'
import { createSchemaEditorController, type SchemaEditorController } from './currentSchemaRevision'

afterEach(cleanup)

function schemaWithFields(): SchemaEditorController {
  return createSchemaEditorController(testSchemaPersistence(), {
    initialDraft: { recordDescription: 'One letter.', schemaNodes: [{ id: 'sender', name: 'sender', type: 'string' }] },
  })
}

function Harness(props: Omit<RailChatProps, 'chat'>) {
  const chat = useSchemaChat({ schema: props.schema })
  return <RailChat {...props} chat={chat} />
}

function renderChat(props: Partial<Omit<RailChatProps, 'chat'>> = {}) {
  const all = { schema: schemaWithFields(), sourceDocumentName: 'letters.pdf', latest: null, onShowView: vi.fn(), ...props }
  render(<Harness {...all} />)
  return all
}

describe('RailChat', () => {
  it.each(['reply', 'edit'] as const)('waits for a pending %s before offering Record Scope', (request) => {
    const props = { schema: schemaWithFields(), sourceDocumentName: 'letters.pdf', latest: null,
      onShowView: vi.fn(), recordScope: { value: null, onChange: vi.fn() } }
    function PendingRequest({ busy }: { busy: boolean }) {
      const chat = useSchemaChat({ schema: props.schema })
      return <RailChat {...props} chat={{ ...chat, loading: busy && request === 'edit',
        asking: busy && request === 'reply' ? 'make it simpler' : null }} />
    }
    const view = render(<PendingRequest busy={false} />)
    expect(screen.getByRole('region', { name: 'Choose Record Scope' })).toBeVisible()
    view.rerender(<PendingRequest busy />)
    expect(screen.queryByRole('region', { name: 'Choose Record Scope' })).not.toBeInTheDocument()
    view.rerender(<PendingRequest busy={false} />)
    expect(screen.getByRole('region', { name: 'Choose Record Scope' })).toBeVisible()
  })

  it('asks for Generate template before the first template and generates with the kept instructions', () => {
    const onGenerate = vi.fn()
    renderChat({ schema: createSchemaEditorController(testSchemaPersistence()), onGenerate })
    // No source to ask about: a message is kept as an instruction directly.
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Focus on senders' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const step = screen.getByRole('region', { name: 'Generate template' })
    fireEvent.click(within(step).getByRole('button', { name: 'Generate template (1 instruction)' }))
    expect(onGenerate).toHaveBeenCalledExactlyOnceWith('Focus on senders')
    expect(screen.getByText('Generate template (1 instruction)', { selector: 'span' })).toBeInTheDocument()
  })

  it('stops at Template ready once a generation finishes, until the researcher goes on', async () => {
    // A generation joins a durable chain: this one initializes it.
    const schema = createSchemaEditorController({ ...testSchemaPersistence(),
      initialize: async (definition) => ({ schemaRevisionId: 'revision-1', extractionSchemaId: 'schema-1', revisionNumber: 1, recordScope: null,
        origin: 'suggestion', createdAt: '2026-11-10T00:00:00.000Z', stabilisedAt: null, ...definition }) as never })
    const all = renderChat({ schema, onGenerate: vi.fn() })
    await act(async () => { await schema.generate(async () => ({ _description: 'One letter.', sender: 'string' })) })
    const step = screen.getByRole('region', { name: 'Template ready' })
    expect(within(step).getByText('Look at the template before going on?')).toBeVisible()
    // Viewing the template keeps the step; Continue ends it.
    fireEvent.click(within(step).getByRole('button', { name: /View template/ }))
    expect(all.onShowView).toHaveBeenCalledWith('schema')
    expect(screen.getByRole('region', { name: 'Template ready' })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('region', { name: 'Template ready' })).getByRole('button', { name: /Continue/ }))
    expect(screen.queryByRole('region', { name: 'Template ready' })).not.toBeInTheDocument()
     // Generated again over the template (the editor never leaves it), the chat stops there again.
    await act(async () => { await schema.generate(async () => ({ _description: 'One letter.', sender: 'string', date: 'string' })) })
    expect(screen.getByRole('region', { name: 'Template ready' })).toBeInTheDocument()
  })

  it('runs the current template again once the halted Extraction on an earlier one has stopped, once', async () => {
    const schema = createSchemaEditorController({ ...testSchemaPersistence(),
      initialize: async (definition) => ({ schemaRevisionId: 'revision-2', extractionSchemaId: 'schema-1', revisionNumber: 2, recordScope: null,
        origin: 'suggestion', createdAt: '2026-11-11T00:00:00.000Z', stabilisedAt: null, ...definition }) as never })
    const command = vi.fn()
    const start = vi.fn()
    const props = { schema, sourceDocumentName: 'letters.pdf', onShowView: vi.fn(), recordScope: { value: 'document' as const, onChange: vi.fn() },
      onGenerate: vi.fn(), control: { command, busy: false, continueBlocked: null, continueDescription: 'Continue.', pauseDescription: 'Pause.' } }
    const at = (status: 'FAILED' | 'STOPPING' | 'STOPPED', available = false) => ({
      ...props, run: { start, available, unavailableReason: null },
      latest: { extractionId: 'extraction-1', schemaRevisionId: 'revision-1', status, progress: null, toCheck: null } })
    const view = render(<Harness {...at('FAILED')} />)
    await act(async () => { await schema.generate(async () => ({ _description: 'One letter.', sender: 'string' })) })
    fireEvent.click(within(screen.getByRole('region', { name: 'Template ready' })).getByRole('button', { name: /Continue/ }))
    fireEvent.click(within(screen.getByRole('region', { name: 'Extraction' })).getByRole('button', { name: /Run again with the current template/ }))
    expect(command).toHaveBeenCalledExactlyOnceWith('stop')
    view.rerender(<Harness {...at('STOPPING')} />)
    expect(start).not.toHaveBeenCalled()
    view.rerender(<Harness {...at('STOPPED', true)} />)
    expect(start).toHaveBeenCalledOnce()
    view.rerender(<Harness {...at('STOPPED', true)} />)
    expect(start).toHaveBeenCalledOnce()
  })

  it('stops at Results ready once a run seen at work completes, until the researcher goes on', () => {
    const schema = schemaWithFields()
    const onShowView = vi.fn()
    const props = { schema, sourceDocumentName: 'letters.pdf', onShowView, recordScope: { value: 'document' as const, onChange: vi.fn() },
      run: { start: vi.fn(), available: true, unavailableReason: null } }
    const at = (status: 'RUNNING' | 'COMPLETED', extractionId = 'extraction-1') =>
      ({ extractionId, schemaRevisionId: 'revision-1', status, progress: null, toCheck: 2 })
    // A run already completed when the chat first sees it asks nothing.
    const view = render(<Harness {...props} latest={at('COMPLETED', 'extraction-0')} />)
    expect(screen.queryByRole('region', { name: 'Results ready' })).not.toBeInTheDocument()
    view.rerender(<Harness {...props} latest={at('RUNNING')} />)
    view.rerender(<Harness {...props} latest={at('COMPLETED')} />)
    const step = screen.getByRole('region', { name: 'Results ready' })
    expect(within(step).getByText('Look at the results? 2 values to check.')).toBeVisible()
    // Opening Results keeps the step; Continue ends it.
    fireEvent.click(within(step).getByRole('button', { name: /Open Results/ }))
    expect(onShowView).toHaveBeenCalledWith('results')
    fireEvent.click(within(screen.getByRole('region', { name: 'Results ready' })).getByRole('button', { name: /Continue/ }))
    expect(screen.queryByRole('region', { name: 'Results ready' })).not.toBeInTheDocument()
  })

  it('shows each instruction where it was said, between the replies around it', () => {
    renderChat({ schema: createSchemaEditorController(testSchemaPersistence()), onGenerate: vi.fn() })
    const say = (text: string) => {
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: text } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    say('Focus on senders')
    fireEvent.keyDown(screen.getByRole('region', { name: 'Generate template' }), { key: 'Escape' })
    say('Also the dates')
    const first = screen.getByRole('note', { name: 'Instruction 1' })
    // Setting the step aside is not noted, but the chat's reply to it is.
    const step = screen.getByText('If you need help, please use the chat box below.')
    const second = screen.getByRole('note', { name: 'Instruction 2' })
    expect(first.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(step.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('takes an instruction typed into the composer the Generate template step carries, and Esc still closes it', () => {
    const onGenerate = vi.fn()
    renderChat({ schema: createSchemaEditorController(testSchemaPersistence()), onGenerate })
    const step = screen.getByRole('region', { name: 'Generate template' })
    // The card carries the chat's composer as its last option: the only field there is, which its number focuses.
    const tell = within(step).getByRole('textbox', { name: 'Tell me what to focus on, or ask about the document…' })
    expect(screen.getAllByRole('textbox')).toEqual([tell])
    fireEvent.keyDown(step, { key: '2' })
    expect(tell).toHaveFocus()
    fireEvent.change(tell, { target: { value: 'Focus on senders' } })
    fireEvent.keyDown(tell, { key: 'Enter' })
    // Said in the conversation, and kept for the generation: no step answer is folded in for it.
    expect(screen.getByText('Focus on senders')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('')
    fireEvent.click(within(screen.getByRole('region', { name: 'Generate template' })).getByRole('button', { name: 'Generate template (1 instruction)' }))
    expect(onGenerate).toHaveBeenCalledExactlyOnceWith('Focus on senders')
    // A new instruction asked again; Esc closes the step until the next one.
    fireEvent.keyDown(within(screen.getByRole('region', { name: 'Generate template' })).getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Generate template' })).not.toBeInTheDocument()
    // Closed, the step folds to its title line: generating is still one click away, and the title brings it back.
    const folded = screen.getByRole('region', { name: 'Generate template, set aside' })
    expect(within(folded).getByText('· 1 instruction')).toBeInTheDocument()
    onGenerate.mockClear()
    fireEvent.click(within(folded).getByRole('button', { name: 'Generate template (1 instruction)' }))
    expect(onGenerate).toHaveBeenCalledExactlyOnceWith('Focus on senders')
    fireEvent.click(within(folded).getByRole('button', { name: 'Show the Generate template step' }))
    expect(screen.getByRole('region', { name: 'Generate template' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Generate template, set aside' })).not.toBeInTheDocument()
  })

  it('clears the whole conversation once confirmed, and the Generate template step asks afresh', async () => {
    const onGenerate = vi.fn()
    renderChat({ schema: createSchemaEditorController(testSchemaPersistence()), onGenerate })
    // Nothing said yet: nothing to clear.
    expect(screen.queryByRole('button', { name: 'Clear conversation' })).not.toBeInTheDocument()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Focus on senders' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(within(screen.getByRole('region', { name: 'Generate template' })).getByRole('textbox'), { key: 'Escape' })
    expect(screen.getByRole('region', { name: 'Generate template, set aside' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear conversation' }))
    const dialog = screen.getByRole('dialog', { name: 'Clear the conversation?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear conversation' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByText('Focus on senders')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear conversation' })).not.toBeInTheDocument()
    // The step set aside is asked again, now with no instruction kept.
    const step = screen.getByRole('region', { name: 'Generate template' })
    fireEvent.click(within(step).getByRole('button', { name: 'Generate template' }))
    expect(onGenerate).toHaveBeenCalledExactlyOnceWith('')
  })

  it('saves the Record Scope from its step and folds the answer into the conversation', () => {
    const onChange = vi.fn()
    renderChat({ recordScope: { value: null, onChange } })
    fireEvent.click(screen.getByRole('button', { name: /^Catalog: many records per document/ }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('records')
    // The step's title, and its answer folded into the open conversation.
    expect(screen.getAllByText('Choose Record Scope')).toHaveLength(2)
  })

  it('runs the extraction from its step, with keys 1 and Esc', () => {
    const start = vi.fn()
    renderChat({ recordScope: { value: 'records', onChange: vi.fn() }, run: { start, available: true, unavailableReason: null } })
    const step = screen.getByRole('region', { name: 'Run extraction' })
    fireEvent.keyDown(step, { key: '1' })
    expect(start).toHaveBeenCalledOnce()
  })

  it('keeps a dismissed step away', () => {
    renderChat({ recordScope: { value: 'records', onChange: vi.fn() }, run: { start: vi.fn(), available: true, unavailableReason: null } })
    fireEvent.click(within(screen.getByRole('region', { name: 'Run extraction' })).getByRole('button', { name: 'Not yet' }))
    expect(screen.queryByRole('region', { name: 'Run extraction' })).not.toBeInTheDocument()
    // Turning every option down does nothing, so it is not noted; the chat points to its box.
    expect(screen.queryByText(/Not yet/)).not.toBeInTheDocument()
    expect(screen.getByText('If you need help, please use the chat box below.')).toBeInTheDocument()
  })

  it('sets a step aside for what is typed instead, said in the conversation', () => {
    const start = vi.fn()
    renderChat({ recordScope: { value: 'records', onChange: vi.fn() }, run: { start, available: true, unavailableReason: null } })
    const step = screen.getByRole('region', { name: 'Run extraction' })
    const instead = within(step).getByRole('textbox', { name: 'Something else? Say what to do instead…' })
    fireEvent.keyDown(step, { key: '3' })
    expect(instead).toHaveFocus()
    fireEvent.change(instead, { target: { value: 'Add a recipient field first' } })
    fireEvent.keyDown(instead, { key: 'Enter' })
    expect(screen.queryByRole('region', { name: 'Run extraction' })).not.toBeInTheDocument()
    expect(screen.getByText('Add a recipient field first')).toBeInTheDocument()
    expect(screen.queryByText(/Not yet/)).not.toBeInTheDocument()
    expect(screen.queryByText(/If you need help/)).not.toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
  })

  it('shows the step and the composer under another view, and returns home to answer a message', () => {
    const { onShowView } = renderChat({ mode: 'step', recordScope: { value: null, onChange: vi.fn() } })
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
    // The step is folded to its title line with its options, leaving the view the rail's height; its title unfolds
    // it, ⌄ folds it back.
    const step = within(screen.getByRole('region', { name: 'Choose Record Scope' }))
    const question = 'Is each Source Document one record, or does it hold many?'
    expect(step.getByRole('button', { name: 'Catalog: many records per document' })).toBeVisible()
    expect(step.queryByText(question)).not.toBeInTheDocument()
    fireEvent.click(step.getByRole('button', { name: 'Show the Choose Record Scope step' }))
    expect(within(screen.getByRole('region', { name: 'Choose Record Scope' })).getByText(question)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Fold the step' }))
    expect(screen.queryByText(question)).not.toBeInTheDocument()
    const input = screen.getByPlaceholderText('Describe a change to the template…')
    fireEvent.change(input, { target: { value: 'Add a recipient' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onShowView).toHaveBeenCalledExactlyOnceWith('chat')
  })

  it('returns to the conversation for a choice that moves on under another view, never for one that opens a view', () => {
    const { onShowView } = renderChat({ mode: 'step', recordScope: { value: null, onChange: vi.fn() } })
    fireEvent.click(within(screen.getByRole('region', { name: 'Choose Record Scope' })).getByRole('button', { name: 'View template' }))
    expect(onShowView).toHaveBeenCalledExactlyOnceWith('schema')
    fireEvent.click(within(screen.getByRole('region', { name: 'Choose Record Scope' })).getByRole('button', { name: /Catalog: many records/ }))
    expect(onShowView).toHaveBeenLastCalledWith('chat')
  })

  it('leaves the view as it is for a run\'s controls', () => {
    const command = vi.fn()
    const { onShowView } = renderChat({ mode: 'step', recordScope: { value: 'records', onChange: vi.fn() },
      run: { start: vi.fn(), available: true, unavailableReason: null },
      control: { command, busy: false, continueBlocked: null, continueDescription: 'Continue.', pauseDescription: 'Pause.' },
      latest: { extractionId: 'extraction-1', schemaRevisionId: 'revision-1', status: 'RUNNING', progress: null, toCheck: null } })
    fireEvent.click(within(screen.getByRole('region', { name: 'Extraction' })).getByRole('button', { name: /Pause extraction/ }))
    expect(command).toHaveBeenCalledExactlyOnceWith('pause')
    expect(onShowView).not.toHaveBeenCalled()
  })

  it('opens Results after a finished run', () => {
    const onShowView = vi.fn()
    renderChat({
      onShowView,
      recordScope: { value: 'records', onChange: vi.fn() },
      run: { start: vi.fn(), available: true, unavailableReason: null },
      latest: { extractionId: 'extraction-1', schemaRevisionId: 'missing', status: 'COMPLETED', progress: 'Completed · Catalog · 3 records', toCheck: 2 },
    })
    // The schema changed since that run (its revision is not this draft's): a new run is offered, not the review.
    expect(screen.getByRole('region', { name: 'Run extraction again' })).toBeInTheDocument()
    expect(onShowView).not.toHaveBeenCalled()
  })
})

describe('the second trial', () => {
  afterEach(() => localStorage.clear())
  const member = (sourceDocumentId: string) => ({ extractionId: `extraction-${sourceDocumentId}`, sourceDocumentId,
    sourceRepresentationRevisionId: `source-${sourceDocumentId}`, executionStatus: 'COMPLETED' as const, completed: true, reviewable: true,
    currentReview: { snapshotVersion: 1, feedbackVersion: 0, createdAt: '2026-11-01T00:00:00.000Z', schemaRevisionId: 'revision-2' } })
  const project = () => ({
    guide: {
      summary: { phase: 'approve' as const, extractionCount: 2, extractedSourceDocumentCount: 2, reviewedSourceDocumentCount: 2,
        staleSourceDocumentCount: 0, pendingExtractionSourceDocumentCount: 1, currentSchemaRevisionId: 'revision-2', schemaStabilised: false,
        currentSchemaRevisionReviewed: true, lastActivityAt: '2026-11-01T00:00:00.000Z', runningBatch: null },
      documents: ['a', 'b', 'c'].map((id) => ({ id, name: `${id}.pdf` })), currentDocumentId: 'a',
      batches: [{ batchExtractionId: 'trial-1', projectContextId: 'project-1', schemaRevisionId: 'revision-2', extractionSchemaId: 'schema',
        extractionSchemaName: 'Letters', schemaRevisionNumber: 2, strategy: 'CATALOG' as const, executionStatus: 'COMPLETED' as const,
        createdAt: '2026-11-01T00:00:00.000Z', members: [member('a'), member('b')] }],
      latest: null, roundId: null, busy: false, error: null,
    },
    start: vi.fn(), approve: vi.fn(), stopBatch: vi.fn(), open: vi.fn(), export: vi.fn(), id: 'project-1', addDocuments: vi.fn(),
  })

  it('asks after the first trial\'s review, uploads and tries more documents, then asks for the approval, once per project', () => {
    const shown = project()
    renderChat({ recordScope: { value: 'records', onChange: vi.fn() }, project: shown })
    fireEvent.click(within(screen.getByRole('region', { name: 'Try more documents?' })).getByRole('button', { name: /Yes, try more documents/ }))
    const trial = screen.getByRole('region', { name: 'Try template on more documents' })
    expect(within(trial).getByRole('checkbox', { name: /c\.pdf/ })).toBeChecked()
    // Upload opens the file picker; the files chosen go to the project.
    const file = new File(['%PDF'], 'd.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByTestId('chat-upload'), { target: { files: [file] } })
    expect(shown.addDocuments).toHaveBeenCalledExactlyOnceWith([file])
    fireEvent.click(within(trial).getByRole('button', { name: /Try on 1 document/ }))
    expect(shown.start).toHaveBeenCalledExactlyOnceWith('pilot', ['c'])
    expect(screen.getByRole('region', { name: 'Approve template' })).toBeInTheDocument()
    // Another document of the project does not ask again.
    cleanup()
    renderChat({ recordScope: { value: 'records', onChange: vi.fn() }, project: project() })
    expect(screen.queryByRole('region', { name: 'Try more documents?' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Approve template' })).toBeInTheDocument()
  })

  it('goes on to the approval when the researcher declines', () => {
    renderChat({ recordScope: { value: 'records', onChange: vi.fn() }, project: project() })
    fireEvent.click(within(screen.getByRole('region', { name: 'Try more documents?' })).getByRole('button', { name: /No, go on to approval/ }))
    expect(screen.getByRole('region', { name: 'Approve template' })).toBeInTheDocument()
  })
})
