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

  it('shows export failures inline', async () => {
    onExport.mockRejectedValue(new Error('Spreadsheet creation failed.'))
    render(<ExtractionResultExportControl schema={schema} onExport={onExport} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Spreadsheet creation failed.')
  })
})
