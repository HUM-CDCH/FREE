// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportExtractionResult } from 'extraction-result-export'
import ExtractionResultExportControl from './ExtractionResultExportControl'

vi.mock('extraction-result-export', () => ({
  exportExtractionResult: vi.fn(async () => {}),
}))

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
        schema={null}
        sourceDocumentName="source.pdf"
      />,
    )

    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('blocks same-tick duplicate exports while the first export is pending', () => {
    let resolveExport: (() => void) | undefined
    vi.mocked(exportExtractionResult).mockImplementation(
      () => new Promise<void>((resolve) => { resolveExport = resolve }),
    )
    render(
      <ExtractionResultExportControl
        result={{ title: 'Report' }}
        schema={null}
        sourceDocumentName="source.pdf"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    const csv = screen.getByRole('menuitem', { name: 'CSV' })
    act(() => {
      csv.click()
      csv.click()
    })

    expect(exportExtractionResult).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Exporting…' })).toHaveAttribute('aria-busy', 'true')

    return act(async () => resolveExport?.())
  })

  it('shows package failures inline', async () => {
    vi.mocked(exportExtractionResult).mockRejectedValue(new Error('Spreadsheet creation failed.'))
    render(
      <ExtractionResultExportControl
        result={{ title: 'Report' }}
        schema={null}
        sourceDocumentName="source.pdf"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'CSV' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Spreadsheet creation failed.')
  })
})
