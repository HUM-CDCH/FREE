// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import ExtractionResultExportControl, { CSV_NOTE, WORKBOOK_NOTE } from './ExtractionResultExportControl'

const nodes: SchemaNode[] = [
  { id: 'title', name: 'title', type: 'string' },
  { id: 'items', name: 'items', type: 'array', children: [{ id: 'name', name: 'name', type: 'string' }] },
]

afterEach(cleanup)

describe('ExtractionResultExportControl', () => {
  it('renders nothing while closed', () => {
    render(<ExtractionResultExportControl schemaNodes={nodes} open={false} onDismiss={vi.fn()} onExport={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers each record or each item of a list, in plain words, and hands both choices to the chosen format', () => {
    const onExport = vi.fn()
    render(<ExtractionResultExportControl schemaNodes={nodes} open onDismiss={vi.fn()} onExport={onExport} />)
    expect(screen.getByRole('dialog', { name: 'Export options' })).toBeInTheDocument()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Each record', 'Each item in “items”',
      'Keep them, one column per item', 'Leave them out'])
    expect(screen.getByRole('button', { name: 'Excel workbook' })).toHaveAccessibleDescription(WORKBOOK_NOTE)
    expect(screen.getByRole('button', { name: 'CSV file' })).toHaveAccessibleDescription(CSV_NOTE)
    expect(screen.getByLabelText('One row per')).toHaveAccessibleDescription('One row for every record that was extracted.')
    fireEvent.click(screen.getByRole('button', { name: 'CSV file' }))
    expect(onExport).toHaveBeenLastCalledWith('csv', { rowsRepresent: '$', otherRepeatedFields: 'preserve' })
    fireEvent.change(screen.getByLabelText('One row per'), { target: { value: 'items' } })
    expect(screen.getByLabelText('One row per')).toHaveAccessibleDescription(/^One row for every item in “items”/)
    fireEvent.change(screen.getByLabelText('Other lists in each row'), { target: { value: 'omit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Excel workbook' }))
    expect(onExport).toHaveBeenLastCalledWith('xlsx', { rowsRepresent: 'items', otherRepeatedFields: 'omit' })
  })

  it('offers no repeated-field choice when the fields hold none, and dismisses on Escape', () => {
    const onDismiss = vi.fn()
    render(<ExtractionResultExportControl schemaNodes={[nodes[0]!]} open onDismiss={onDismiss} onExport={vi.fn()} />)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Each record'])
    expect(screen.queryByLabelText('Other lists in each row')).not.toBeInTheDocument()
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('falls back to root rows when the fields no longer declare the chosen path', () => {
    const onExport = vi.fn()
    const { rerender } = render(<ExtractionResultExportControl schemaNodes={nodes} open onDismiss={vi.fn()} onExport={onExport} />)
    fireEvent.change(screen.getByLabelText('One row per'), { target: { value: 'items' } })
    rerender(<ExtractionResultExportControl schemaNodes={[nodes[0]!]} open onDismiss={vi.fn()} onExport={onExport} />)
    fireEvent.click(screen.getByRole('button', { name: 'CSV file' }))
    expect(onExport).toHaveBeenLastCalledWith('csv', { rowsRepresent: '$', otherRepeatedFields: 'preserve' })
  })
})
