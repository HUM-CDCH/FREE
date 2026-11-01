// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  const all = { schema: schemaWithFields(), sourceDocumentName: 'letters.pdf', latest: null, onShowTab: vi.fn(), ...props }
  render(<Harness {...all} />)
  return all
}

describe('RailChat', () => {
  it('asks for Generate schema before the first schema and generates with the kept instructions', () => {
    const onGenerate = vi.fn()
    renderChat({ schema: createSchemaEditorController(localSchemaPersistence({ onEdit: () => {} })), onGenerate })
    // No source to ask about: a message is kept as an instruction directly.
    const input = screen.getByPlaceholderText(/Add a generation instruction/)
    fireEvent.change(input, { target: { value: 'Focus on senders' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const step = screen.getByRole('region', { name: 'Generate schema' })
    fireEvent.click(within(step).getByRole('button', { name: 'Generate schema (1 message)' }))
    expect(onGenerate).toHaveBeenCalledExactlyOnceWith('Focus on senders')
    expect(screen.getByText('Generate schema (1 message)', { selector: 'span' })).toBeInTheDocument()
  })

  it('saves the Record Scope from its step and folds the answer into the conversation', () => {
    const onChange = vi.fn()
    renderChat({ recordScope: { value: null, onChange } })
    fireEvent.click(screen.getByRole('button', { name: /^Catalog: many records per document/ }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('records')
    expect(screen.getByText('Choose Record Scope')).toBeInTheDocument()
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
    fireEvent.keyDown(screen.getByRole('region', { name: 'Run extraction' }), { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Run extraction' })).not.toBeInTheDocument()
    // The answer is in the collapsed conversation, which the composer's dot opens.
    fireEvent.click(screen.getByRole('button', { name: 'Show conversation' }))
    expect(screen.getByText(/Not yet/)).toBeInTheDocument()
  })

  it('shows the step while the conversation is collapsed', () => {
    renderChat({ recordScope: { value: null, onChange: vi.fn() } })
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Choose Record Scope' })).toBeVisible()
  })

  it('opens Results after a finished run', () => {
    const onShowTab = vi.fn()
    renderChat({
      onShowTab,
      recordScope: { value: 'records', onChange: vi.fn() },
      run: { start: vi.fn(), available: true, unavailableReason: null },
      latest: { extractionId: 'extraction-1', schemaRevisionId: 'missing', status: 'COMPLETED', progress: 'Completed · Catalog · 3 records', toCheck: 2 },
    })
    // The schema changed since that run (its revision is not this draft's): a new run is offered, not the review.
    expect(screen.getByRole('region', { name: 'Run extraction again' })).toBeInTheDocument()
    expect(onShowTab).not.toHaveBeenCalled()
  })
})
