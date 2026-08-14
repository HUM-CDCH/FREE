// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportExtractionResult } from 'extraction-result-export'
import ExtractionResultExportControl from './ExtractionResultExportControl'
import type { SchemaDefinition } from '../shared/schemaNode'

vi.mock('extraction-result-export', async (importOriginal) => ({
  ...await importOriginal<typeof import('extraction-result-export')>(),
  exportExtractionResult: vi.fn(async () => {}),
}))

const schema: SchemaDefinition = {
  recordDescription: 'Report',
  schemaNodes: [
    { id: 'title', name: 'title', type: 'string' },
    {
      id: 'items', name: 'items', type: 'array',
      children: [{ id: 'name', name: 'name', type: 'string' }],
    },
  ],
}

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(exportExtractionResult).mockReset()
  vi.mocked(exportExtractionResult).mockResolvedValue(undefined)
})

describe('ExtractionResultExportControl', () => {
  it('is unavailable without a result', () => {
    render(
      <ExtractionResultExportControl
        result={null}
        schema={schema}
        sourceDocumentName="source.pdf"
      />,
    )

    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('blocks same-tick duplicate exports while the first export is pending', () => {
    let resolveExport: (() => void) | undefined
    vi.mocked(exportExtractionResult).mockImplementation(
      () => new Promise<void>((resolve) => { resolveExport = resolve }),
    )
    render(
      <ExtractionResultExportControl
        result={{ title: 'Report' }}
        schema={schema}
        sourceDocumentName="source.pdf"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    const csv = screen.getByRole('button', { name: 'CSV' })
    act(() => {
      csv.click()
      csv.click()
    })

    expect(exportExtractionResult).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Exporting…' })).toHaveAttribute('aria-busy', 'true')

    return act(async () => resolveExport?.())
  })

  it('exposes both schema-led choices to CSV and XLSX', () => {
    render(
      <ExtractionResultExportControl
        result={{ title: 'Report', items: [{ name: 'A' }] }}
        schema={schema}
        sourceDocumentName="source.pdf"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.change(screen.getByLabelText('Rows represent'), { target: { value: 'items' } })
    fireEvent.change(screen.getByLabelText('Other repeated fields'), { target: { value: 'omit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }))

    expect(exportExtractionResult).toHaveBeenCalledWith(
      { title: 'Report', items: [{ name: 'A' }] },
      {
        format: 'xlsx',
        filename: 'source.pdf',
        schemaNodes: schema.schemaNodes,
        choices: { rowsRepresent: 'items', otherRepeatedFields: 'omit' },
      },
    )
  })

  it('shows package failures inline', async () => {
    vi.mocked(exportExtractionResult).mockRejectedValue(new Error('Spreadsheet creation failed.'))
    render(
      <ExtractionResultExportControl
        result={{ title: 'Report' }}
        schema={schema}
        sourceDocumentName="source.pdf"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Spreadsheet creation failed.')
  })
})
