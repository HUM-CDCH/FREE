import { useRef, useState } from 'react'
import { SCALAR_FIELD_TYPES, type ScalarFieldType } from 'extraction/allowed-values'
import { schemaDefinitionToTemplate } from 'extraction/schema'
import type { SchemaEditorController } from './currentSchemaRevision'
import { IMPORT_LIMITS, importDefinition, type ImportColumn } from '../shared/schemaImport'
import { authenticatedFetch } from './auth/authenticatedFetch'
import { Button } from './ui'

/** `onImported` runs once a confirmed import is the schema's definition. */
export function SchemaImport({ schema, disabled, onImported }: {
  schema: SchemaEditorController
  disabled: boolean
  onImported?: () => void
}) {
  const [file, setFile] = useState<File | null>(null), [worksheets, setWorksheets] = useState<string[]>([])
  const [worksheet, setWorksheet] = useState(''), [header, setHeader] = useState(1), [separator, setSeparator] = useState('')
  const [columns, setColumns] = useState<ImportColumn[]>([]), [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false)
  const [groups] = useState(() => new Map<string, string>())
  const base = useRef(0), request = useRef(0)
  const project = schema.operationScope()?.projectContextId
  if (!project) return null
  let definition: ReturnType<typeof importDefinition> | null = null, validation: string | null = null
  if (columns.length) try { definition = importDefinition(columns, description, separator, groups) }
  catch (error) { validation = error instanceof Error ? error.message : 'Invalid schema.' }
  const close = () => { request.current++; setFile(null); setColumns([]); setWorksheets([]); setWorksheet(''); setError(null); setBusy(false) }
  async function preview(upload: File, sheet: string | null) {
    const id = ++request.current
    setBusy(true); setError(null)
    try {
      if (upload.size > IMPORT_LIMITS.compressed || !/\.xlsx$/i.test(upload.name)) throw new Error('Choose an .xlsx workbook of at most 5 MiB.')
      const query = new URLSearchParams({ projectContextId: project!, filename: upload.name, headerRow: String(header) })
      if (sheet !== null) query.set('worksheet', sheet)
      const response = await authenticatedFetch(`/api/schema_import_preview?${query}`, { method: 'POST', body: upload })
      const data = await response.json() as { worksheets: string[]; columns: ImportColumn[]; error?: { message?: string } }
      if (!response.ok) throw new Error(data.error?.message ?? 'Workbook could not be read.')
      if (request.current !== id) return
      setWorksheets(data.worksheets); setColumns(data.columns)
      if (sheet !== null) groups.clear()
    } catch (error) { if (request.current === id) setError(error instanceof Error ? error.message : 'Workbook could not be read.') }
    finally { if (request.current === id) setBusy(false) }
  }
  return <div className="border-b border-line p-2 text-xs">
    <label>Import Excel codebook <input type="file" accept=".xlsx" disabled={disabled || busy} onChange={(event) => {
      const upload = event.target.files?.[0]; if (!upload) return
      close(); base.current = schema.snapshot().draftVersion; setFile(upload); void preview(upload, null); event.target.value = ''
    }} /></label>
    {file && <>
      <p>The workbook and column data are transient. Closing or reloading an unconfirmed preview requires re-upload.</p>
      <label>Worksheet <select aria-label="Import worksheet" value={worksheet} disabled={busy} onChange={(event) => { setWorksheet(event.target.value); setColumns([]) }}>
        <option value="">Choose a worksheet</option>{worksheets.map((sheet) => <option key={sheet}>{sheet}</option>)}
      </select></label>
      <label>Header row <input aria-label="Header row" type="number" min="1" max="5000" value={header} disabled={busy}
        onChange={(event) => { setHeader(Number(event.target.value)); setColumns([]) }} /></label>
      <Button disabled={!worksheet || busy} onClick={() => void preview(file, worksheet)}>Preview worksheet</Button>
      {columns.length > 0 && <fieldset disabled={busy}>
        <label>Record description <input aria-label="Imported record description" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label>Nesting separator <input aria-label="Nesting separator" value={separator} placeholder="Blank = flat fields" onChange={(event) => setSeparator(event.target.value)} /></label>
        <p>Flat mode keeps separators literal. In nested mode rename literal separators into unambiguous paths. Types are hints; enum constraints require choosing each field.</p>
        {columns.map((column, index) => {
          const update = (change: Partial<ImportColumn>) => setColumns((current) => current.map((field, at) => at === index ? { ...field, ...change } : field))
          return <div key={column.id} className="my-1 border border-line p-1">
            <label><input type="checkbox" checked={column.include} onChange={(event) => update({ include: event.target.checked })} />Column {column.column}</label>
            <input aria-label={`Column ${column.column} name`} value={column.name} onChange={(event) => update({ name: event.target.value })} />
            <select aria-label={`Column ${column.column} type`} value={column.type} onChange={(event) => update({ type: event.target.value as ScalarFieldType, enum: false })}>
              {SCALAR_FIELD_TYPES.map((type) => <option key={type}>{type}</option>)}
            </select>
            <p>{column.kinds.join(', ')} · suggested {column.suggestedType} · examples: {column.examples.join(' | ')}</p>
            <label><input type="checkbox" disabled={column.choices.length < 2} checked={column.enum ?? false} onChange={(event) => update({ enum: event.target.checked, type: 'string' })} />Use these allowed values: {column.choices.join(', ')}</label>
          </div>
        })}
        {validation && <p role="alert">{validation}</p>}
        {definition && <pre className="max-h-48 overflow-auto">{JSON.stringify(schemaDefinitionToTemplate(definition), null, 2)}</pre>}
        <Button disabled={!definition || busy || disabled} variant="positive" onClick={async () => {
          if (!definition) return
          if (schema.snapshot().draftVersion !== base.current) { setError('The editor changed during preview. Close and re-upload to keep those edits.'); return }
          setBusy(true); setError(null)
          try { await schema.confirmDefinition(definition); close(); onImported?.() }
          catch (error) { setError(error instanceof Error ? error.message : 'Schema could not be confirmed.'); setBusy(false) }
        }}>{schema.snapshot().extractionSchemaId ? 'Confirm as a new revision of the selected schema' : 'Confirm schema'}</Button>
      </fieldset>}
      <Button onClick={close} disabled={busy}>Cancel import</Button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>
}
