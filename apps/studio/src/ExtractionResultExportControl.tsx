import { useId, useRef, useState, type RefObject } from 'react'
import {
  createExtractionResultExportControl,
  ROOT_ROWS,
  type ExportChoices,
  type ExportFormat,
  type OtherRepeatedFields,
} from 'extraction-result-export'
import type { SchemaNode } from 'extraction/schema'
import { ModalDialog } from './ui'

/** What each format holds, said beside it in words a researcher without a technical background reads. */
export const WORKBOOK_NOTE = 'The values, plus where each one came from in the document and your review decisions.'
export const CSV_NOTE = 'The values only. Opens in any spreadsheet app.'
export const JSON_NOTE = 'The values nested as in the template: groups stay groups, lists stay lists.'

type ExtractionResultExportControlProps = {
  /** The fields the export projects through: the saved values' own producing fields, or a batch's pinned schema. */
  schemaNodes: readonly SchemaNode[]
  open: boolean
  /** The opener focus returns to once the dialog closes. */
  returnFocusRef?: RefObject<HTMLElement | null>
  onDismiss: () => void
  onExport: (format: ExportFormat, choices: ExportChoices) => void
}

/** A list the rows can follow, named as the researcher's fields: "sites[].finds[]" reads as "sites › finds". */
const listName = (label: string) => label.replaceAll('[]', '').split('.').join(' › ')
const rowsLabel = (option: { value: string; label: string }) =>
  option.value === ROOT_ROWS ? 'Each record' : `Each item in “${listName(option.label)}”`
const OTHER_LISTS: Record<OtherRepeatedFields, string> = { preserve: 'Keep them, one column per item', omit: 'Leave them out' }

/**
 * The researcher's export, in plain words: JSON, which keeps the template's nesting and needs no choice, then the
 * spreadsheet's options (what one row is: each record, or each item of one of its lists; what happens to the other
 * lists in a row) and its formats. The caller owns what is exported and how it runs,
 * so one Extraction's results, a whole Batch Extraction and the chat's export offer the same dialog. The choices
 * outlive a closed dialog, so a repeated export keeps them.
 */
export default function ExtractionResultExportControl({ schemaNodes, open, returnFocusRef, onDismiss, onExport }: ExtractionResultExportControlProps) {
  const [rowsRepresent, setRowsRepresent] = useState(ROOT_ROWS)
  const [otherRepeatedFields, setOtherRepeatedFields] = useState<OtherRepeatedFields>('preserve')
  const initialFocusRef = useRef<HTMLButtonElement>(null)
  const rowsHintId = useId(), excelNoteId = useId(), csvNoteId = useId(), jsonNoteId = useId()
  if (!open) return null
  const control = createExtractionResultExportControl(schemaNodes)
  const effectiveRows = control.rowsRepresent.options.some((option) => option.value === rowsRepresent) ? rowsRepresent : ROOT_ROWS
  const choices: ExportChoices = { rowsRepresent: effectiveRows, otherRepeatedFields }
  const repeated = control.rowsRepresent.options.length > 1
  const followed = control.rowsRepresent.options.find((option) => option.value === effectiveRows)!
  const rowsHint = effectiveRows === ROOT_ROWS
    ? 'One row for every record that was extracted.'
    : `One row for every item in “${listName(followed.label)}”; its record’s other values repeat on each of its rows.`
  const formatClass = 'block w-full cursor-pointer rounded px-2.5 py-1.5 text-left hover:bg-accent-soft'
  return (
    <ModalDialog
      ariaLabel="Export options"
      className="m-auto w-72 rounded-md border border-line bg-surface p-3 text-ink shadow-float backdrop:bg-ink/35"
      initialFocusRef={initialFocusRef}
      returnFocusRef={returnFocusRef}
      onDismiss={onDismiss}
    >
      <p className="mb-1 text-xs font-bold text-ink">Download the results</p>
      <button ref={initialFocusRef} className={`${formatClass} mb-1`} type="button" aria-label="JSON file" aria-describedby={jsonNoteId} onClick={() => onExport('json', choices)}>
        <span className="block text-[11px] font-semibold text-ink">JSON file</span>
        <span id={jsonNoteId} className="block text-[11px] leading-snug text-ink-muted">{JSON_NOTE}</span>
      </button>
      <p className="mb-1 border-t border-line pt-2 text-[11px] font-bold text-ink">Or as a spreadsheet</p>
      <label className="mb-1 block text-[11px] font-semibold text-ink-muted">
        One row per
        <select
          aria-describedby={rowsHintId}
          className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-ink"
          value={effectiveRows}
          onChange={(event) => setRowsRepresent(event.target.value)}
        >
          {control.rowsRepresent.options.map((option) => (
            <option key={option.value} value={option.value}>{rowsLabel(option)}</option>
          ))}
        </select>
      </label>
      <p id={rowsHintId} className="mb-2 text-[11px] leading-snug text-ink-muted">{rowsHint}</p>
      {repeated && (
        <label className="mb-2 block text-[11px] font-semibold text-ink-muted">
          Other lists in each row
          <select
            className="mt-1 block w-full rounded border border-line bg-canvas px-2 py-1 text-ink"
            value={otherRepeatedFields}
            onChange={(event) => setOtherRepeatedFields(event.target.value as OtherRepeatedFields)}
          >
            {control.otherRepeatedFields.options.map((option) => (
              <option key={option.value} value={option.value}>{OTHER_LISTS[option.value as OtherRepeatedFields]}</option>
            ))}
          </select>
        </label>
      )}
      <div className="border-t border-line pt-1">
        {([['xlsx', 'Excel workbook', WORKBOOK_NOTE, excelNoteId], ['csv', 'CSV file', CSV_NOTE, csvNoteId]] as const).map(([format, label, note, noteId]) => (
          <button key={format} className={formatClass} type="button" aria-label={label} aria-describedby={noteId} onClick={() => onExport(format, choices)}>
            <span className="block text-[11px] font-semibold text-ink">{label}</span>
            <span id={noteId} className="block text-[11px] leading-snug text-ink-muted">{note}</span>
          </button>
        ))}
      </div>
    </ModalDialog>
  )
}
