import { useRef, useState } from 'react'
import {
  createExtractionResultExportControl,
  deriveRowsRepresentOptions,
  exportExtractionResult,
  ROOT_ROWS,
  type ExportFormat,
  type OtherRepeatedFields,
} from 'extraction-result-export'
import type { SchemaDefinition } from '../shared/schemaNode'
import { Button } from './ui'

type ExtractionResultExportControlProps = {
  result: unknown | null
  schema: SchemaDefinition | null
  sourceDocumentName: string
}

function ExtractionResultExportControl({
  result,
  schema,
  sourceDocumentName,
}: ExtractionResultExportControlProps) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rowsRepresent, setRowsRepresent] = useState(ROOT_ROWS)
  const [otherRepeatedFields, setOtherRepeatedFields] = useState<OtherRepeatedFields>('preserve')
  const inFlight = useRef(false)
  const unavailable = result === null || schema === null
  const rowOptions = schema ? deriveRowsRepresentOptions(schema.schemaNodes) : []
  const effectiveRows = rowOptions.some((option) => option.value === rowsRepresent)
    ? rowsRepresent
    : ROOT_ROWS
  const control = schema
    ? createExtractionResultExportControl(schema.schemaNodes, {
        rowsRepresent: effectiveRows,
        otherRepeatedFields,
      })
    : null

  async function exportResult(format: ExportFormat): Promise<void> {
    if (result === null || schema === null || inFlight.current) return
    inFlight.current = true
    setOpen(false)
    setPending(true)
    setError(null)
    try {
      await exportExtractionResult(result, {
        format,
        filename: sourceDocumentName,
        schemaNodes: schema.schemaNodes,
        choices: { rowsRepresent: effectiveRows, otherRepeatedFields },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not export the Extraction Result.')
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <div className="relative flex flex-col items-end gap-1" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }} onKeyDown={(event) => {
      if (event.key === 'Escape') setOpen(false)
    }}>
      <Button
        aria-busy={pending}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={unavailable || pending}
        onClick={() => setOpen((current) => !current)}
      >
        {pending ? 'Exporting…' : 'Export'}
      </Button>
      {open && control && !pending && (
        <div
          role="dialog"
          aria-label="Export options"
          className="absolute right-0 top-full z-10 mt-1 w-64 rounded-md border border-line bg-surface p-2 shadow-float"
        >
          <label className="mb-2 block text-[11px] font-semibold text-ink-muted">
            Rows represent
            <select
              className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-ink"
              value={control.rowsRepresent.value}
              onChange={(event) => setRowsRepresent(event.target.value)}
            >
              {control.rowsRepresent.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="mb-2 block text-[11px] font-semibold text-ink-muted">
            Other repeated fields
            <select
              className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-ink"
              value={control.otherRepeatedFields.value}
              onChange={(event) => setOtherRepeatedFields(event.target.value as OtherRepeatedFields)}
            >
              {control.otherRepeatedFields.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <div className="border-t border-line pt-1">
            {([
              ['xlsx', 'Excel'],
              ['csv', 'CSV'],
            ] as const).map(([format, label]) => (
              <button
                key={format}
                className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-[11px] font-semibold text-ink hover:bg-accent-soft"
                type="button"
                onClick={() => void exportResult(format)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-[11.5px] leading-snug text-danger">{error}</p>}
    </div>
  )
}

export default ExtractionResultExportControl
