import { useRef, useState, type RefObject } from 'react'
import {
  createExtractionResultExportControl,
  ROOT_ROWS,
  type ExportChoices,
  type ExportFormat,
  type OtherRepeatedFields,
} from 'extraction-result-export'
import type { SchemaNode } from 'extraction/schema'
import { ModalDialog } from './ui'

/** What a CSV leaves out, said beside the format buttons. */
export const WORKBOOK_NOTE =
  'CSV holds the values only. The Excel workbook adds an Extraction sheet (identities and versions) and an Evidence sheet (extracted and reviewed values, decisions, Evidence links).'

type ExtractionResultExportControlProps = {
  /** The fields the export projects through: the saved values' own producing fields, or a batch's pinned schema. */
  schemaNodes: readonly SchemaNode[]
  open: boolean
  /** The opener focus returns to once the dialog closes. */
  returnFocusRef?: RefObject<HTMLElement | null>
  onDismiss: () => void
  onExport: (format: ExportFormat, choices: ExportChoices) => void
}

/**
 * The researcher's spreadsheet export options: the schema-led choices ("Rows represent", "Other repeated fields"),
 * then the format. The caller owns what is exported and how it runs, so one Extraction's results and a whole Batch
 * Extraction offer the same dialog. The choices outlive a closed dialog, so a repeated export keeps them.
 */
export default function ExtractionResultExportControl({ schemaNodes, open, returnFocusRef, onDismiss, onExport }: ExtractionResultExportControlProps) {
  const [rowsRepresent, setRowsRepresent] = useState(ROOT_ROWS)
  const [otherRepeatedFields, setOtherRepeatedFields] = useState<OtherRepeatedFields>('preserve')
  const initialFocusRef = useRef<HTMLSelectElement>(null)
  if (!open) return null
  const control = createExtractionResultExportControl(schemaNodes)
  const effectiveRows = control.rowsRepresent.options.some((option) => option.value === rowsRepresent) ? rowsRepresent : ROOT_ROWS
  const choices: ExportChoices = { rowsRepresent: effectiveRows, otherRepeatedFields }
  const repeated = control.rowsRepresent.options.length > 1
  return (
    <ModalDialog
      ariaLabel="Export options"
      className="m-auto w-64 rounded-md border border-line bg-surface p-2 text-ink shadow-float backdrop:bg-ink/35"
      initialFocusRef={initialFocusRef}
      returnFocusRef={returnFocusRef}
      onDismiss={onDismiss}
    >
      <label className="mb-2 block text-[11px] font-semibold text-ink-muted">
        Rows represent
        <select
          ref={initialFocusRef}
          className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-ink"
          value={effectiveRows}
          onChange={(event) => setRowsRepresent(event.target.value)}
        >
          {control.rowsRepresent.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      {repeated && (
        <label className="mb-2 block text-[11px] font-semibold text-ink-muted">
          Other repeated fields
          <select
            className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-ink"
            value={otherRepeatedFields}
            onChange={(event) => setOtherRepeatedFields(event.target.value as OtherRepeatedFields)}
          >
            {control.otherRepeatedFields.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      )}
      <div className="border-t border-line pt-1">
        {([['xlsx', 'Excel'], ['csv', 'CSV']] as const).map(([format, label]) => (
          <button
            key={format}
            className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-[11px] font-semibold text-ink hover:bg-accent-soft"
            type="button"
            onClick={() => onExport(format, choices)}
          >
            {label}
          </button>
        ))}
        <p role="note" className="px-2.5 pt-1 text-[11px] leading-snug text-ink-muted">{WORKBOOK_NOTE}</p>
      </div>
    </ModalDialog>
  )
}
