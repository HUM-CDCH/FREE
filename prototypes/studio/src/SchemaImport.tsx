import { useRef, useState } from 'react'
import pluralize from 'pluralize'
import { SCALAR_FIELD_TYPES, type ScalarFieldType } from 'extraction/allowed-values'
import type { SchemaNode } from 'extraction/schema'
import type { SchemaEditorController } from './currentSchemaRevision'
import { IMPORT_LIMITS, importDefinition, type ImportColumn } from '../shared/schemaImport'
import { authenticatedFetch } from './auth/authenticatedFetch'
import { fieldTypeWords } from './fieldTypeWords'
import { Button, ModalDialog } from './ui'

/** Every field the import creates, with its full path: a nested column is listed by its leaf, never just its group. */
function importedFields(nodes: readonly SchemaNode[], separator: string, prefix = ''): Array<{ id: string; path: string; node: SchemaNode }> {
  return nodes.flatMap((node) => {
    const path = prefix ? `${prefix}${separator}${node.name}` : node.name
    return node.children ? importedFields(node.children, separator, path) : [{ id: node.id, path, node }]
  })
}

/** The Excel codebook import, as a dialog: renders nothing while closed. `onImported` runs once a confirmed import is
 *  the schema's definition; the dialog then closes through `onClose`. A preview in flight never blocks dismissal (its
 *  response is dropped and its request aborted); only the confirmation keeps the dialog open while it saves. */
export function SchemaImport({ schema, disabled, open, onClose, onImported }: {
  schema: SchemaEditorController
  disabled: boolean
  open: boolean
  onClose: () => void
  onImported?: () => void
}) {
  const [file, setFile] = useState<File | null>(null), [worksheets, setWorksheets] = useState<string[]>([])
  const [worksheet, setWorksheet] = useState(''), [header, setHeader] = useState(1), [separator, setSeparator] = useState('')
  const [columns, setColumns] = useState<ImportColumn[]>([]), [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false)
  const [groups] = useState(() => new Map<string, string>())
  const base = useRef(0), request = useRef(0), previewAbort = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const project = schema.operationScope()?.projectContextId
  if (!project || !open) return null
  let definition: ReturnType<typeof importDefinition> | null = null, validation: string | null = null
  if (columns.length) try { definition = importDefinition(columns, description, separator, groups) }
  catch (error) { validation = error instanceof Error ? error.message : 'Invalid schema.' }
  // A later request or a dismissal invalidates a preview in flight: its response is ignored and its request aborted.
  const close = () => {
    request.current++; previewAbort.current?.abort(); previewAbort.current = null
    setFile(null); setColumns([]); setWorksheets([]); setWorksheet(''); setError(null); setBusy(false)
  }
  async function preview(upload: File, sheet: string | null) {
    const id = ++request.current
    previewAbort.current?.abort()
    const abort = new AbortController()
    previewAbort.current = abort
    setBusy(true); setError(null)
    try {
      if (upload.size > IMPORT_LIMITS.compressed || !/\.xlsx$/i.test(upload.name)) throw new Error('Choose an .xlsx workbook of at most 5 MiB.')
      const query = new URLSearchParams({ projectContextId: project!, filename: upload.name, headerRow: String(header) })
      if (sheet !== null) query.set('worksheet', sheet)
      const response = await authenticatedFetch(`/api/schema_import_preview?${query}`, { method: 'POST', body: upload, signal: abort.signal })
      const data = await response.json() as { worksheets: string[]; columns: ImportColumn[]; error?: { message?: string } }
      if (!response.ok) throw new Error(data.error?.message ?? 'Workbook could not be read.')
      if (request.current !== id) return
      setWorksheets(data.worksheets); setColumns(data.columns)
      if (sheet !== null) groups.clear()
    } catch (error) { if (request.current === id) setError(error instanceof Error ? error.message : 'Workbook could not be read.') }
    finally { if (request.current === id) { setBusy(false); previewAbort.current = null } }
  }
  /** Closing the dialog also forgets the import's settings, so a later import starts from the defaults. */
  const dismiss = () => { close(); setDescription(''); setSeparator(''); setHeader(1); onClose() }
  return (
    <ModalDialog ariaLabel="Import from Excel codebook" onDismiss={dismiss} dismissDisabled={confirming}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl rounded-card border border-line bg-surface text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]">
      {/* The padding sits on this wrapper: a click on the dialog element itself is a backdrop click and dismisses. */}
      <div className="p-4">
        <h2 className="text-content font-semibold">Import from Excel codebook</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-secondary">
          <Button onClick={() => fileInput.current?.click()} disabled={disabled || busy || confirming}>Choose workbook…</Button>
          <input ref={fileInput} className="sr-only" type="file" accept=".xlsx" aria-label="Excel codebook file" disabled={disabled || busy || confirming}
            onChange={(event) => {
              const upload = event.target.files?.[0]; if (!upload) return
              close(); base.current = schema.snapshot().draftVersion; setFile(upload); void preview(upload, null); event.target.value = ''
            }} />
          <span className="min-w-0 truncate text-ink-muted">{file ? file.name : 'An .xlsx workbook of at most 5 MiB'}</span>
        </div>
        {file && <>
          <p className="mt-2 text-compact text-ink-muted">The workbook and column data are transient. Closing or reloading an unconfirmed preview requires re-upload.</p>
          <div className="mt-2 flex flex-wrap items-end gap-3 text-secondary">
            <label className="flex items-center gap-1">Worksheet <select aria-label="Import worksheet" className="rounded-[3px] border border-line px-1 py-0.5" value={worksheet} disabled={busy}
              onChange={(event) => { setWorksheet(event.target.value); setColumns([]) }}>
              <option value="">Choose a worksheet</option>{worksheets.map((sheet) => <option key={sheet}>{sheet}</option>)}
            </select></label>
            <label className="flex items-center gap-1">Header row <input aria-label="Header row" className="w-16 rounded-[3px] border border-line px-1 py-0.5" type="number" min="1" max="5000"
              value={header} disabled={busy} onChange={(event) => { setHeader(Number(event.target.value)); setColumns([]) }} /></label>
            <Button disabled={!worksheet || busy} onClick={() => void preview(file, worksheet)}>Preview worksheet</Button>
          </div>
          {columns.length > 0 && <fieldset disabled={busy || confirming} className="mt-3 flex flex-col gap-2 text-secondary">
            <label className="flex items-center gap-1">Record description <input aria-label="Imported record description" className="min-w-0 flex-1 rounded-[3px] border border-line px-1 py-0.5"
              value={description} onChange={(event) => setDescription(event.target.value)} /></label>
            <label className="flex items-center gap-1">Nesting separator <input aria-label="Nesting separator" className="w-32 rounded-[3px] border border-line px-1 py-0.5"
              value={separator} placeholder="Blank = flat fields" onChange={(event) => setSeparator(event.target.value)} /></label>
            <p className="text-compact text-ink-muted">Flat mode keeps separators literal. In nested mode rename literal separators into unambiguous paths. Types are hints; allowed values require choosing each field.</p>
            <table className="w-full table-fixed text-compact">
                <thead><tr className="text-left text-overline font-bold uppercase tracking-[0.12em] text-ink-muted">
                  <th className="py-1">Include</th><th>Name</th><th>Type</th><th>Allowed values</th><th>Examples</th>
                </tr></thead>
                <tbody>{columns.map((column, index) => {
                  const update = (change: Partial<ImportColumn>) => setColumns((current) => current.map((field, at) => at === index ? { ...field, ...change } : field))
                  return <tr key={column.id} className="border-t border-line align-top">
                    <td className="py-1"><label className="inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center"><input type="checkbox" aria-label={`Include column ${column.column}`} checked={column.include} onChange={(event) => update({ include: event.target.checked })} /></label></td>
                    <td><input aria-label={`Column ${column.column} name`} className="w-full rounded-[3px] border border-line px-1 font-mono" value={column.name} onChange={(event) => update({ name: event.target.value })} /></td>
                    <td><select aria-label={`Column ${column.column} type`} className="rounded-[3px] border border-line px-1" value={column.type}
                      onChange={(event) => update({ type: event.target.value as ScalarFieldType, enum: false })}>
                      {SCALAR_FIELD_TYPES.map((type) => <option key={type}>{type}</option>)}
                    </select></td>
                    <td><label className="inline-flex min-h-6 items-center gap-1"><input type="checkbox" aria-label={`Column ${column.column} allowed values`}
                      disabled={column.choices.length < 2} checked={column.enum ?? false}
                      onChange={(event) => update({ enum: event.target.checked, type: 'string' })} />{pluralize('value', column.choices.length, true)}</label>
                      <span className="line-clamp-2 break-words text-ink-muted" title={column.choices.join(', ')}>{column.choices.join(', ')}</span></td>
                    <td className="break-words text-ink-muted">{column.kinds.join(', ')} · suggested {column.suggestedType} · {column.examples.join(' | ')}</td>
                  </tr>
                })}</tbody>
              </table>
            {validation && <p role="alert" className="text-danger">{validation}</p>}
            {definition && <ul aria-label="Fields to import" className="rounded-[3px] border border-line bg-canvas p-2 font-mono text-compact">
              {importedFields(definition.schemaNodes, separator).map(({ id, path, node }) => <li key={id}>{path} — {fieldTypeWords(node)}</li>)}
            </ul>}
          </fieldset>}
        </>}
        {error && <p role="alert" className="mt-2 text-compact text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={dismiss} disabled={confirming}>Cancel</Button>
          {file && columns.length > 0 && (
            <Button variant="positive" disabled={!definition || busy || confirming || disabled} onClick={async () => {
              if (!definition) return
              if (schema.snapshot().draftVersion !== base.current) { setError('The editor changed during preview. Close and re-upload to keep those edits.'); return }
              setConfirming(true); setError(null)
              try { await schema.confirmDefinition(definition); setConfirming(false); onImported?.(); dismiss() }
              catch (error) { setError(error instanceof Error ? error.message : 'Schema could not be confirmed.'); setConfirming(false) }
            }}>{schema.snapshot().extractionSchemaId ? 'Confirm as a new revision of the selected schema' : 'Confirm schema'}</Button>
          )}
        </div>
      </div>
    </ModalDialog>
  )
}
