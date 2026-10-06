// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SchemaImport } from './SchemaImport'
import { createSchemaEditorController, durableSchemaPersistence } from './currentSchemaRevision'
import type { SchemaDefinition } from 'extraction/schema'

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }))
vi.mock('./auth/authenticatedFetch', () => ({ authenticatedFetch }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('preview and cancel save nothing; explicit confirmation keeps renamed IDs and uses ordinary initialization', async () => {
  const initialize = vi.fn(async (definition: SchemaDefinition) => ({ ...definition, extractionSchemaId: 'schema', schemaRevisionId: 'revision',
    revisionNumber: 1, origin: 'researcher-edit' as const, createdAt: '2026-09-30T00:00:00Z', recordScope: null,
    stabilisedAt: null }))
  const schema = createSchemaEditorController(durableSchemaPersistence({ projectContextId: 'project', initial: null,
    initialize, append: vi.fn(), listRevisions: async () => [], getRevision: vi.fn() }))
  const column = { id: 'stable-import-id', column: 1, name: 'filename', type: 'string', include: true,
    examples: ['0012'], kinds: ['text'], choices: ['A', 'B'], suggestedType: 'string' }
  authenticatedFetch.mockImplementation(async (_url: string) => Response.json({ worksheets: ['Codebook'],
    columns: _url.includes('worksheet=') ? [column] : [] }))
  const onClose = vi.fn(), onImported = vi.fn()
  render(<SchemaImport schema={schema} disabled={false} open onClose={onClose} onImported={onImported} />)
  expect(screen.getByRole('dialog', { name: 'Import from Excel codebook' })).toBeInTheDocument()
  const upload = async () => {
    fireEvent.change(screen.getByLabelText('Excel codebook file'), { target: { files: [new File(['bytes'], 'codebook.xlsx')] } })
    await screen.findByRole('option', { name: 'Codebook' })
    fireEvent.change(screen.getByLabelText('Import worksheet'), { target: { value: 'Codebook' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview worksheet' }))
    await screen.findByLabelText('Column 1 name')
  }
  await upload()
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(initialize).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Column 1 name')).not.toBeInTheDocument()
  onClose.mockClear()
  await upload()
  const table = screen.getByRole('table')
  expect(within(table).getAllByRole('columnheader').map((header) => header.textContent))
    .toEqual(['Include', 'Name', 'Type'])
  fireEvent.change(screen.getByLabelText('Imported record description'), { target: { value: 'One codebook record.' } })
  fireEvent.change(screen.getByLabelText('Column 1 name'), { target: { value: 'identifier' } })
  expect(within(screen.getByRole('list', { name: 'Fields to import' })).getByRole('listitem')).toHaveTextContent('identifier — string')
  expect(screen.getByRole('dialog').querySelector('pre')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm schema' }))
  await waitFor(() => expect(initialize).toHaveBeenCalledOnce())
  expect(initialize.mock.calls[0]![0]).toEqual({ recordDescription: 'One codebook record.',
    schemaNodes: [{ id: column.id, name: 'identifier', type: 'string' }] })
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(onImported).toHaveBeenCalledOnce()
  expect(schema.snapshot().extractableSchemaRevisionId).toBe('revision')
  schema.dispose()
})

it('renders nothing while closed', () => {
  const schema = createSchemaEditorController(durableSchemaPersistence({ projectContextId: 'project', initial: null,
    initialize: vi.fn(), append: vi.fn(), listRevisions: async () => [], getRevision: vi.fn() }))
  render(<SchemaImport schema={schema} disabled={false} open={false} onClose={vi.fn()} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  schema.dispose()
})

function previewSetup(
  schema = createSchemaEditorController(durableSchemaPersistence({ projectContextId: 'project', initial: null,
    initialize: vi.fn(), append: vi.fn(), listRevisions: async () => [], getRevision: vi.fn() })),
  columns: unknown[] = [{ id: 'stable-import-id', column: 1, name: 'filename', type: 'string', include: true,
    examples: ['0012'], kinds: ['text'], choices: [], suggestedType: 'string' }],
) {
  authenticatedFetch.mockImplementation(async (url: string) => Response.json({ worksheets: ['Codebook'],
    columns: url.includes('worksheet=') ? columns : [] }))
  const upload = async () => {
    fireEvent.change(screen.getByLabelText('Excel codebook file'), { target: { files: [new File(['bytes'], 'codebook.xlsx')] } })
    await screen.findByRole('option', { name: 'Codebook' })
    fireEvent.change(screen.getByLabelText('Import worksheet'), { target: { value: 'Codebook' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview worksheet' }))
    await screen.findByLabelText('Column 1 name')
  }
  return { schema, upload }
}

it('a dismissed import starts over with an empty record description, separator and header row 1', async () => {
  const { schema, upload } = previewSetup()
  const onClose = vi.fn()
  const view = render(<SchemaImport schema={schema} disabled={false} open onClose={onClose} />)
  await upload()
  fireEvent.change(screen.getByLabelText('Imported record description'), { target: { value: 'One codebook record.' } })
  fireEvent.change(screen.getByLabelText('Nesting separator'), { target: { value: '.' } })
  fireEvent.change(screen.getByLabelText('Header row'), { target: { value: '3' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  view.rerender(<SchemaImport schema={schema} disabled={false} open={false} onClose={onClose} />)
  view.rerender(<SchemaImport schema={schema} disabled={false} open onClose={onClose} />)
  await upload()
  expect(screen.getByLabelText('Imported record description')).toHaveValue('')
  expect(screen.getByLabelText('Nesting separator')).toHaveValue('')
  expect(screen.getByLabelText('Header row')).toHaveValue(1)
  schema.dispose()
})

it('a click inside the dialog content does not dismiss it; a backdrop click does', async () => {
  const { schema, upload } = previewSetup()
  const onClose = vi.fn()
  render(<SchemaImport schema={schema} disabled={false} open onClose={onClose} />)
  await upload()
  const dialog = screen.getByRole('dialog', { name: 'Import from Excel codebook' })
  const content = dialog.firstElementChild as HTMLElement
  expect(content.tagName).toBe('DIV')
  expect(content).toContainElement(screen.getByRole('heading', { name: 'Import from Excel codebook' }))
  expect(dialog).not.toHaveClass('p-4')
  fireEvent.click(content)
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Column 1 name')).toBeInTheDocument()
  fireEvent.click(dialog)
  expect(onClose).toHaveBeenCalledOnce()
  schema.dispose()
})

it('a preview still in flight can be dismissed with Cancel or Escape, and its late response changes nothing', async () => {
  const schema = createSchemaEditorController(durableSchemaPersistence({ projectContextId: 'project', initial: null,
    initialize: vi.fn(), append: vi.fn(), listRevisions: async () => [], getRevision: vi.fn() }))
  const held: Array<{ signal: AbortSignal | undefined; release: (response: Response) => void }> = []
  authenticatedFetch.mockImplementation((_url: string, init?: RequestInit) =>
    new Promise<Response>((release) => { held.push({ signal: init?.signal ?? undefined, release }) }))
  const onClose = vi.fn()
  const view = render(<SchemaImport schema={schema} disabled={false} open onClose={onClose} />)
  const choose = () => fireEvent.change(screen.getByLabelText('Excel codebook file'), { target: { files: [new File(['bytes'], 'codebook.xlsx')] } })

  choose()
  await waitFor(() => expect(held).toHaveLength(1))
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(held[0]!.signal?.aborted).toBe(true)
  view.rerender(<SchemaImport schema={schema} disabled={false} open={false} onClose={onClose} />)
  held[0]!.release(Response.json({ worksheets: ['Late sheet'], columns: [] }))
  view.rerender(<SchemaImport schema={schema} disabled={false} open onClose={onClose} />)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.queryByRole('option', { name: 'Late sheet' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Import worksheet')).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()

  // Escape, which jsdom does not synthesize from the key, fires the dialog's `cancel`.
  choose()
  await waitFor(() => expect(held).toHaveLength(2))
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(onClose).toHaveBeenCalledTimes(2)
  view.rerender(<SchemaImport schema={schema} disabled={false} open={false} onClose={onClose} />)
  held[1]!.release(new Response('{}', { status: 500 }))
  view.rerender(<SchemaImport schema={schema} disabled={false} open onClose={onClose} />)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  schema.dispose()
})

it('stays open while a confirmed import is being saved, its preview settings and Preview worksheet disabled', async () => {
  let finish!: () => void
  const initialize = vi.fn((definition: SchemaDefinition) => new Promise<never>((resolve) => {
    finish = () => resolve({ ...definition, extractionSchemaId: 'schema', schemaRevisionId: 'revision', revisionNumber: 1,
      origin: 'researcher-edit', createdAt: '2026-09-30T00:00:00Z', recordScope: null } as never)
  }))
  const schema = createSchemaEditorController(durableSchemaPersistence({ projectContextId: 'project', initial: null,
    initialize, append: vi.fn(), listRevisions: async () => [], getRevision: vi.fn() }))
  const { upload } = previewSetup(schema)
  const onClose = vi.fn()
  render(<SchemaImport schema={schema} disabled={false} open onClose={onClose} />)
  await upload()
  fireEvent.change(screen.getByLabelText('Imported record description'), { target: { value: 'One codebook record.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm schema' }))
  await waitFor(() => expect(initialize).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  // The preview shown is the definition being saved: nothing may change it or start another while it saves.
  expect(screen.getByLabelText('Import worksheet')).toBeDisabled()
  expect(screen.getByLabelText('Header row')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Preview worksheet' })).toBeDisabled()
  const previews = authenticatedFetch.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Preview worksheet' }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(authenticatedFetch).toHaveBeenCalledTimes(previews)
  expect(screen.getByLabelText('Column 1 name')).toBeInTheDocument()
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  fireEvent.click(screen.getByRole('dialog'))
  expect(onClose).not.toHaveBeenCalled()
  finish()
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  schema.dispose()
})

it('the Include checkbox toggles from its whole 24px label', async () => {
  const { schema, upload } = previewSetup()
  render(<SchemaImport schema={schema} disabled={false} open onClose={vi.fn()} />)
  await upload()
  const include = screen.getByRole('checkbox', { name: 'Include column 1' })
  const label = include.closest('label')!
  expect(label).not.toBeNull()
  expect(label.className).toMatch(/\bmin-h-6\b/)
  expect(label.className).toMatch(/\bmin-w-6\b/)
  expect(include).toBeChecked()
  fireEvent.click(label)
  expect(include).not.toBeChecked()
  schema.dispose()
})

it('before a record description it asks for one in words, never the raw validation issues', async () => {
  const { schema, upload } = previewSetup()
  render(<SchemaImport schema={schema} disabled={false} open onClose={vi.fn()} />)
  await upload()
  expect(screen.getByRole('alert')).toHaveTextContent(/^Add a record description to import these fields\.$/)
  expect(screen.queryByText(/\[\s*\{/)).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Imported record description'), { target: { value: 'One codebook record.' } })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('names the column an invalid field comes from', async () => {
  const { schema, upload } = previewSetup()
  render(<SchemaImport schema={schema} disabled={false} open onClose={vi.fn()} />)
  await upload()
  fireEvent.change(screen.getByLabelText('Imported record description'), { target: { value: 'One codebook record.' } })
  fireEvent.change(screen.getByLabelText('Column 1 name'), { target: { value: '' } })
  expect(screen.getByRole('alert')).toHaveTextContent(/^Column 1: /)
  expect(screen.getByRole('alert').textContent).not.toMatch(/[[{]/)
})

it('previews every nested field with its full path and type', async () => {
  const columns = [
    { id: 'name-id', column: 1, name: 'person.name', type: 'string', include: true, examples: ['Ane'], kinds: ['text'], choices: [], suggestedType: 'string' },
    { id: 'year-id', column: 2, name: 'person.birth.year', type: 'integer', include: true, examples: ['1790'], kinds: ['number'], choices: [], suggestedType: 'number' },
    { id: 'site-id', column: 3, name: 'site', type: 'string', include: true, examples: ['Ellekilde'], kinds: ['text'], choices: [], suggestedType: 'string' },
  ]
  const { schema, upload } = previewSetup(undefined, columns)
  render(<SchemaImport schema={schema} disabled={false} open onClose={vi.fn()} />)
  await upload()
  fireEvent.change(screen.getByLabelText('Imported record description'), { target: { value: 'One person.' } })
  fireEvent.change(screen.getByLabelText('Nesting separator'), { target: { value: '.' } })
  expect(within(screen.getByRole('list', { name: 'Fields to import' })).getAllByRole('listitem').map((item) => item.textContent))
    .toEqual(['person.name — string', 'person.birth.year — integer', 'site — string'])
})
