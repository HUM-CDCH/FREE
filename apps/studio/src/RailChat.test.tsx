// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RailChat, { type RailChatProps } from './RailChat'
import { useSchemaChat } from './useSchemaChat'
import { createSchemaEditorController, localSchemaPersistence, type SchemaEditorController } from './currentSchemaRevision'

afterEach(cleanup)

function schemaWithFields(): SchemaEditorController {
  return createSchemaEditorController(localSchemaPersistence({ onEdit: () => {} }), {
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
  it('asks for Generate template before the first template and generates with the kept instructions', () => {
    const onGenerate = vi.fn()
    renderChat({ schema: createSchemaEditorController(localSchemaPersistence({ onEdit: () => {} })), onGenerate })
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
    const schema = createSchemaEditorController({ ...localSchemaPersistence({ onEdit: () => {} }),
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

  it('shows each instruction where it was said, between the steps answered around it', () => {
    renderChat({ schema: createSchemaEditorController(localSchemaPersistence({ onEdit: () => {} })), onGenerate: vi.fn() })
    const say = (text: string) => {
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: text } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    say('Focus on senders')
    fireEvent.keyDown(screen.getByRole('region', { name: 'Generate template' }), { key: 'Escape' })
    say('Also the dates')
    const first = screen.getByRole('note', { name: 'Instruction 1' })
    const step = screen.getByText('Generate template', { selector: 'span.font-semibold' })
    const second = screen.getByRole('note', { name: 'Instruction 2' })
    expect(first.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(step.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('takes an instruction typed into the composer the Generate template step carries, and Esc still closes it', () => {
    const onGenerate = vi.fn()
    renderChat({ schema: createSchemaEditorController(localSchemaPersistence({ onEdit: () => {} })), onGenerate })
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
    renderChat({ schema: createSchemaEditorController(localSchemaPersistence({ onEdit: () => {} })), onGenerate })
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
    // The answer is in the conversation, which is the rail's home.
    expect(screen.getByText(/Not yet/)).toBeInTheDocument()
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
