// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SchemaImport } from './SchemaImport'
import { createSchemaEditorController, durableSchemaPersistence } from './currentSchemaRevision'
import type { SchemaDefinition } from 'extraction/schema'

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }))
vi.mock('./auth/authenticatedFetch', () => ({ authenticatedFetch }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('preview and cancel save nothing; explicit confirmation keeps renamed IDs and uses ordinary initialization', async () => {
  const initialize = vi.fn(async (definition: SchemaDefinition) => ({ ...definition, extractionSchemaId: 'schema', schemaRevisionId: 'revision',
    revisionNumber: 1, origin: 'researcher-edit' as const, createdAt: '2026-09-30T00:00:00Z' }))
  const schema = createSchemaEditorController(durableSchemaPersistence({ projectContextId: 'project', initial: null,
    initialize, append: vi.fn(), listRevisions: async () => [], getRevision: vi.fn() }))
  const column = { id: 'stable-import-id', column: 1, name: 'filename', type: 'string', include: true,
    examples: ['0012'], kinds: ['text'], choices: ['A', 'B'], suggestedType: 'string' }
  authenticatedFetch.mockImplementation(async (_url: string) => Response.json({ worksheets: ['Codebook'],
    columns: _url.includes('worksheet=') ? [column] : [] }))
  render(<SchemaImport schema={schema} disabled={false} />)
  const upload = async () => {
    fireEvent.change(screen.getByLabelText('Import Excel codebook'), { target: { files: [new File(['bytes'], 'codebook.xlsx')] } })
    await screen.findByRole('option', { name: 'Codebook' })
    fireEvent.change(screen.getByLabelText('Import worksheet'), { target: { value: 'Codebook' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview worksheet' }))
    await screen.findByLabelText('Column 1 name')
  }
  await upload()
  expect(initialize).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }))
  expect(initialize).not.toHaveBeenCalled()
  await upload()
  fireEvent.change(screen.getByLabelText('Imported record description'), { target: { value: 'One codebook record.' } })
  fireEvent.change(screen.getByLabelText('Column 1 name'), { target: { value: 'identifier' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm schema' }))
  await waitFor(() => expect(initialize).toHaveBeenCalledOnce())
  expect(initialize.mock.calls[0]![0]).toEqual({ recordDescription: 'One codebook record.',
    schemaNodes: [{ id: column.id, name: 'identifier', type: 'string' }] })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel import' })).not.toBeInTheDocument())
  expect(schema.snapshot().extractableSchemaRevisionId).toBe('revision')
  schema.dispose()
})
