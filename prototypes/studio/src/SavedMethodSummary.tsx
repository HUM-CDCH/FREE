import type { ExtractionMethodIntent } from 'extraction/extraction-method'
import { methodLines, modelsLine, settingsHeadline } from './methodSummary'
import type { SavedMethodState } from './savedMethod'

/** "Saved advanced settings" beside a start action: exactly what the start will submit and admission will pin. A
 *  refusal because the account's settings changed opens it with a refresh; nothing is started in between. */
export function SavedMethodSummary({ saved, method, conflict, onRefresh, variant }: {
  saved: SavedMethodState
  method: ExtractionMethodIntent | null
  conflict: string | null
  onRefresh: () => void
  variant: 'toolbar' | 'panel'
}) {
  const link = 'font-semibold text-accent hover:underline'
  if (saved.status === 'loading') return <p className="text-[11.5px] text-ink-muted">Loading saved advanced settings…</p>
  if (saved.status === 'error' || method === null)
    return (
      <p role="alert" className="text-[11.5px] text-danger">
        Saved advanced settings could not be read. Nothing can start until they load.{' '}
        <button type="button" className={link} onClick={onRefresh}>Retry</button>
      </p>
    )
  const lines = methodLines(method.settings)
  return (
    <details open={conflict !== null || undefined} className={variant === 'toolbar' ? 'relative shrink-0 text-xs' : 'text-[12px]'}>
      <summary className="cursor-pointer font-medium text-ink-muted">
        Saved advanced settings{variant === 'panel' ? `: ${settingsHeadline(method.settings)}` : ''}
      </summary>
      <div className={variant === 'toolbar'
        ? 'absolute right-0 z-20 mt-1 w-80 max-w-[90vw] rounded-md border border-line bg-surface p-3 shadow-float'
        : 'mt-1 rounded-md border border-line bg-surface p-3'}>
        {conflict && (
          <p role="alert" className="mb-2 text-[11.5px] text-danger">
            {conflict}{' '}<button type="button" className={link} onClick={onRefresh}>Refresh summary</button>
          </p>
        )}
        <p className="text-[12px] text-ink">{settingsHeadline(method.settings)}</p>
        <p className="text-[11.5px] text-ink-muted">{modelsLine(method.models)}</p>
        {lines.length > 0 && (
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
            {lines.map((line) => [<dt key={`${line.label}-t`} className="text-ink-muted">{line.label}</dt>, <dd key={`${line.label}-d`} className="text-ink">{line.value}</dd>])}
          </dl>
        )}
        <p className="mt-1 text-[10.5px] text-ink-faint">Change them on the Model Configuration page’s Advanced tab.</p>
      </div>
    </details>
  )
}
