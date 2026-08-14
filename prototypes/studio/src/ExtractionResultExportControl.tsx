import { useRef, useState } from 'react'
import { exportExtractionResult, type ExportFormat } from 'extraction-result-export'
import type { SchemaDefinition, SchemaNode } from '../shared/schemaNode'
import { Button } from './ui'

type ExtractionResultExportControlProps = {
  result: unknown | null
  schema: SchemaDefinition | null
  sourceDocumentName: string
}

function exportColumnsFor(nodes: readonly SchemaNode[], parent: readonly string[] = []): string[] {
  return nodes.flatMap((node) => {
    const escaped = node.name.replaceAll('\\', '\\\\').replaceAll('.', '\\.')
    const path = [...parent, /^\d+$/.test(node.name) ? `\\${escaped}` : escaped]
    const itemPath = node.type === 'array' ? [...path, '0'] : path
    if (!node.children) return [itemPath.join('.')]
    return node.children.length > 0
      ? exportColumnsFor(node.children, itemPath)
      : [path.join('.')]
  })
}

function ExtractionResultExportControl({
  result,
  schema,
  sourceDocumentName,
}: ExtractionResultExportControlProps) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const unavailable = result === null

  async function exportResult(format: ExportFormat): Promise<void> {
    if (unavailable || inFlight.current) return
    inFlight.current = true
    setOpen(false)
    setPending(true)
    setError(null)
    try {
      await exportExtractionResult(result, {
        format,
        filename: sourceDocumentName,
        columns: schema ? exportColumnsFor(schema.schemaNodes) : [],
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
        aria-haspopup="menu"
        disabled={unavailable || pending}
        onClick={() => setOpen((current) => !current)}
      >
        {pending ? 'Exporting…' : 'Export'}
      </Button>
      {open && !unavailable && !pending && (
        <div
          role="menu"
          aria-label="Export format"
          className="absolute right-0 top-full z-10 mt-1 min-w-28 rounded-md border border-line bg-surface p-1 shadow-float"
        >
          {([
            ['xlsx', 'Excel'],
            ['csv', 'CSV'],
          ] as const).map(([format, label]) => (
            <button
              key={format}
              className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-[11px] font-semibold text-ink hover:bg-accent-soft"
              role="menuitem"
              type="button"
              onClick={() => void exportResult(format)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-[11.5px] leading-snug text-danger">{error}</p>}
    </div>
  )
}

export default ExtractionResultExportControl
