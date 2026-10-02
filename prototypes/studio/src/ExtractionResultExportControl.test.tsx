// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExtractionResultExportControl from './ExtractionResultExportControl'
import type { SchemaDefinition } from 'extraction/schema'

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

const onExport = vi.fn(async () => {})

afterEach(cleanup)

beforeEach(() => {
  onExport.mockReset()
  onExport.mockResolvedValue(undefined)
})

describe('ExtractionResultExportControl', () => {
  it('is unavailable while the caller has nothing to export', () => {
    render(
      <ExtractionResultExportControl
        schema={schema}
        disabled
        disabledReason="No successful Extraction Results are available to export."
        onExport={onExport}
      />,
    )

    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    expect(
      screen.getByText(
        'No successful Extraction Results are available to export.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('is unavailable without a schema to project through', () => {
    render(<ExtractionResultExportControl schema={null} onExport={onExport} />)

    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
  })

  it('blocks same-tick duplicate exports while the first export is pending', () => {
    let resolveExport: (() => void) | undefined
    onExport.mockImplementation(
      () => new Promise<void>((resolve) => { resolveExport = resolve }),
    )
    render(<ExtractionResultExportControl schema={schema} onExport={onExport} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    const csv = screen.getByRole('button', { name: 'CSV' })
    act(() => {
      csv.click()
      csv.click()
    })

    expect(onExport).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Exporting…' })).toHaveAttribute('aria-busy', 'true')

    return act(async () => resolveExport?.())
  })

  it('says beside the CSV option that it leaves contested fields empty, only when there are some', () => {
    const { rerender } = render(<ExtractionResultExportControl schema={schema} onExport={onExport} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(screen.queryByRole('note')).not.toBeInTheDocument()

    rerender(<ExtractionResultExportControl schema={schema} contestedCount={3} onExport={onExport} />)
    expect(screen.getByRole('note')).toHaveTextContent(
      'CSV leaves 3 contested fields empty; their candidates are only in the Excel Review notes sheet and in Studio.')
  })

  it('hands both schema-led choices to the chosen format', () => {
    render(<ExtractionResultExportControl schema={schema} onExport={onExport} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.change(screen.getByLabelText('Rows represent'), { target: { value: 'items' } })
    fireEvent.change(screen.getByLabelText('Other repeated fields'), { target: { value: 'omit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }))

    expect(onExport).toHaveBeenCalledWith('xlsx', {
      rowsRepresent: 'items',
      otherRepeatedFields: 'omit',
    })
  })

  it('shows export failures inline and allows an explicit retry', async () => {
    onExport
      .mockRejectedValueOnce(new Error('Spreadsheet creation failed.'))
      .mockResolvedValueOnce(undefined)
    render(<ExtractionResultExportControl schema={schema} onExport={onExport} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Spreadsheet creation failed.')
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
    expect(onExport).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
