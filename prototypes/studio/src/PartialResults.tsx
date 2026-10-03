import type { SchemaNode } from 'extraction/schema'
import type { PartialRecord, PartialResult } from '../shared/extraction.contract'
import { partialHeadline, partialValueState } from './partialResult'
import ResultValue, { RecordHeader, singularItemLabel } from './ui/ResultValue'
import { ProgressBar } from './ui'

/** Before the values call returns, only the pinned schema's record-level fields are placeholders (Ruling 2). */
function placeholderFor(schemaNodes: readonly SchemaNode[]): Record<string, null> {
  return Object.fromEntries(schemaNodes.filter((node) => node.valueSource === undefined).map((node) => [node.name, null]))
}

/** The record supplies the field/container shape; Part A's leaf metadata supplies the displayed text and state.
 *  Missing metadata never permits raw record text, and empty/contested states never display a winner (Ruling 8). */
function presentationValue(value: unknown, path: string[], record: PartialRecord): unknown {
  if (Array.isArray(value)) return value.map((item, index) => presentationValue(item, [...path, String(index)], record))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, presentationValue(child, [...path, name], record)]))
  }
  const leaf = record.values[JSON.stringify(path)]
  return leaf?.state === 'grounded' || leaf?.state === 'checking' ? leaf.value : null
}

/** Server-ordered progress, with Evidence and labelled candidates but no review controls during extraction. */
export default function PartialResults({ partial, schemaNodes = [], onSelectEvidence }: {
  partial: PartialResult
  schemaNodes?: readonly SchemaNode[]
  onSelectEvidence?: (anchorId: string) => void
}) {
  const placeholder = placeholderFor(schemaNodes)
  const fraction = partial.discovered > 0 ? partial.finished / partial.discovered : 0
  return (
    <section aria-label="Extraction in progress" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
        <p role="status" className="text-secondary font-semibold text-ink">{partialHeadline(partial)}</p>
        <ProgressBar fraction={fraction} className="mt-1.5" aria-label="Records read" />
      </div>
      <div role="list" aria-label="Records being read" className="bg-canvas px-3 py-2">
        {partial.records.map((record) => {
          const label = record.label ?? singularItemLabel('records', record.index)
          const fields = record.state === 'queued' ? null : Object.entries(record.record ?? placeholder)
          const linkByPath = new Map(record.evidenceLinks.map((link) => [JSON.stringify(link.resultPath.slice(2).map(String)), link]))
          return (
            <div key={record.index} role="listitem" aria-label={label} data-record-state={record.state} className="mb-2">
              <RecordHeader label={label} page={record.page} />
              {fields?.map(([name, value]) => (
                <ResultValue
                  key={name}
                  name={name}
                  value={presentationValue(value, [name], record)}
                  path={[name]}
                  defaultExpanded={false}
                  getValueState={(path) => partialValueState(record, path)}
                  getContested={(path) => {
                    const leaf = record.values[JSON.stringify(path)]
                    return leaf?.state === 'contested' ? leaf.candidates ?? [] : undefined
                  }}
                  getEvidenceAnchorId={(path) => record.values[JSON.stringify(path)]?.state === 'grounded'
                    ? linkByPath.get(JSON.stringify(path))?.evidenceAnchorId : undefined}
                  onSelectEvidence={onSelectEvidence}
                />
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}
