import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  createExtractionResultExportControl,
  deriveRowsRepresentOptions,
  ROOT_ROWS,
  type ExportChoices,
  type ExportFormat,
  type OtherRepeatedFields,
} from 'extraction-result-export'
import type { SchemaDefinition } from 'extraction/schema'
import { Button, ModalDialog } from './ui'

type ExtractionResultExportControlProps = {
  /** The schema the export projects through: pinned, or the current one. */
  schema: SchemaDefinition | null
  /** True while there is nothing to export yet. */
  disabled?: boolean
  /** Explains why an otherwise available export is disabled. */
  disabledReason?: string | null
  /** Fields the result leaves empty because their sources disagreed: a CSV cannot say so. */
  contestedCount?: number
  /** True when the Excel workbook carries the Extraction and Evidence sheets: one Extraction's export, with its
   *  claim accounting. Otherwise (a batch export) the note says the export holds values only. */
  evidenceSheets?: boolean
  onExport: (format: ExportFormat, choices: ExportChoices) => Promise<void>
  /** Opened from elsewhere (the Results rail's ⋯ menu): its own trigger is hidden and focus returns there. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  returnFocusRef?: RefObject<HTMLElement | null>
}

function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M10 3v8m0 0 3-3m-3 3-3-3M4 13.5v2c0 .55.45 1 1 1h10c.55 0 1-.45 1-1v-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** What a value-only CSV loses: said wherever a CSV of contested fields is offered or made. */
// eslint-disable-next-line react-refresh/only-export-components -- the batch export reports the same limit
export function contestedNotice(count: number): string {
  return `CSV leaves ${count} contested ${count === 1 ? 'field' : 'fields'} empty; their candidates are only in the Excel Review notes sheet and in Studio.`
}

/**
 * The researcher's spreadsheet export: the schema-led choices, then the format.
 * The caller owns what is exported, so one Extraction Result and a whole Batch
 * Extraction offer the same control.
 */
function ExtractionResultExportControl({
  schema,
  disabled = false,
  disabledReason = null,
  contestedCount = 0,
  evidenceSheets = false,
  onExport,
  open: openFromOutside,
  onOpenChange,
  returnFocusRef,
}: ExtractionResultExportControlProps) {
  const [ownOpen, setOwnOpen] = useState(false)
  const controlled = openFromOutside !== undefined
  const open = openFromOutside ?? ownOpen
  const setOpen = (next: boolean) => { if (controlled) onOpenChange?.(next); else setOwnOpen(next) }
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rowsRepresent, setRowsRepresent] = useState(ROOT_ROWS)
  const [otherRepeatedFields, setOtherRepeatedFields] = useState<OtherRepeatedFields>('preserve')
  const inFlight = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const initialFocusRef = useRef<HTMLSelectElement>(null)
  const restoreFocusAfterExport = useRef(false)
  const unavailable = disabled || schema === null
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

  useEffect(() => {
    if (pending || !restoreFocusAfterExport.current) return
    restoreFocusAfterExport.current = false
    ;(returnFocusRef ?? triggerRef).current?.focus()
  }, [pending, returnFocusRef])

  async function exportResult(format: ExportFormat): Promise<void> {
    if (unavailable || inFlight.current) return
    inFlight.current = true
    restoreFocusAfterExport.current = true
    setOpen(false)
    setPending(true)
    setError(null)
    try {
      await onExport(format, {
        rowsRepresent: effectiveRows,
        otherRepeatedFields,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not export the Extraction Result.')
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <div className="relative flex flex-col items-end gap-1">
      {!controlled && <Button
        ref={triggerRef}
        aria-busy={pending}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={unavailable || pending}
        onClick={() => setOpen(!open)}
      >
        <DownloadIcon />
        {pending ? 'Exporting…' : 'Export'}
      </Button>}
      {unavailable && disabledReason && (
        <p className="max-w-72 text-right text-[11.5px] leading-snug text-ink-muted">
          {disabledReason}
        </p>
      )}
      {open && control && !pending && (
        <ModalDialog
          ariaLabel="Export options"
          className="m-auto w-64 rounded-md border border-line bg-surface p-2 text-ink shadow-float backdrop:bg-ink/35"
          initialFocusRef={initialFocusRef}
          returnFocusRef={returnFocusRef ?? triggerRef}
          onDismiss={() => setOpen(false)}
        >
          <label className="mb-2 block text-[11px] font-semibold text-ink-muted">
            Rows represent
            <select
              ref={initialFocusRef}
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
                className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-[11px] font-semibold text-ink hover:bg-surface-muted"
                type="button"
                onClick={() => void exportResult(format)}
              >
                {label}
              </button>
            ))}
            <p role="note" className="px-2.5 pt-1 text-[11px] leading-snug text-ink-muted">
              {evidenceSheets
                ? 'CSV holds the values only. The Excel workbook adds an Extraction sheet (identities, versions, completion) and an Evidence sheet (extracted and reviewed values, verifier outcomes, evidence anchors).'
                : 'This export holds values only; contested fields are listed on the Excel Review notes sheet.'}
            </p>
            {contestedCount > 0 && (
              <p role="note" className="px-2.5 pt-1 text-[11px] leading-snug text-ink-muted">
                {contestedNotice(contestedCount)}
              </p>
            )}
          </div>
        </ModalDialog>
      )}
      {error && <p role="alert" className="text-[11.5px] leading-snug text-danger">{error}</p>}
    </div>
  )
}

export default ExtractionResultExportControl
