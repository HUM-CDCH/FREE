import { legacyCatalogOverrides, METHOD_MESSAGES, type ExtractionMethodIntent } from 'extraction/extraction-method'
import { methodLines, modelsLine, settingsHeadline } from './methodSummary'
import type { SavedMethodState } from './savedMethod'

/** "Saved advanced settings" beside a start action: exactly what the start will submit and admission will pin. A
 *  refusal because the account's settings changed opens it with a refresh; nothing is started in between. */
export function SavedMethodSummary({ saved, method, conflict, onRefresh }: {
  saved: SavedMethodState
  method: ExtractionMethodIntent | null
  conflict: string | null
  onRefresh: () => void
}) {
  const link = 'font-semibold text-accent hover:underline'
  if (saved.status === 'loading') return <p className="text-compact text-ink-muted">Loading saved advanced settings…</p>
  if (saved.status === 'error' || method === null)
    return (
      <p role="alert" className="text-compact text-danger">
        Saved advanced settings could not be read. Nothing can start until they load.{' '}
        <button type="button" className={link} onClick={onRefresh}>Retry</button>
      </p>
    )
  const lines = methodLines(method.settings)
  // Retired Catalog controls are never converted: until the unified settings are applied, a Catalog start is refused.
  const migration = 'unified' in method.settings && legacyCatalogOverrides(saved.config.extractionSettings)
  return (
    <details open={conflict !== null || migration || undefined} className="text-secondary">
      <summary className="cursor-pointer font-medium text-ink-muted">
        {`Saved advanced settings: ${settingsHeadline(method.settings)}`}
      </summary>
      <div className="mt-1 rounded-md border border-line bg-surface p-3">
        {migration && (
          <p role="alert" className="mb-2 text-compact text-danger">
            {METHOD_MESSAGES.migration} Your saved Catalog settings still use retired character limits or recipe
            factors: open Model configuration, Advanced, Catalog.
          </p>
        )}
        {conflict && (
          <p role="alert" className="mb-2 text-compact text-danger">
            {conflict}{' '}<button type="button" className={link} onClick={onRefresh}>Refresh summary</button>
          </p>
        )}
        <p className="text-secondary text-ink">{settingsHeadline(method.settings)}</p>
        <p className="text-compact text-ink-muted">{modelsLine(method.models)}</p>
        {lines.length > 0 && (
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-compact">
            {lines.map((line) => [<dt key={`${line.label}-t`} className="text-ink-muted">{line.label}</dt>, <dd key={`${line.label}-d`} className="text-ink">{line.value}</dd>])}
          </dl>
        )}
        <p className="mt-1 text-overline text-ink-faint">Change them on the Model Configuration page’s Advanced tab.</p>
      </div>
    </details>
  )
}
