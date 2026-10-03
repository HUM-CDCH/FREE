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
    revisionNumber: 1, origin: 'researcher-edit' as const, createdAt: '2026-09-30T00:00:00Z', recordScope: null }))
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
    .toEqual(['Include', 'Name', 'Type', 'Allowed values', 'Examples'])
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
