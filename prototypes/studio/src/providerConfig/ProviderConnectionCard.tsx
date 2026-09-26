import type { ModelConnection, ProviderDescriptor } from '../../shared/modelConfig.contract'
import { Button, Pill } from '../ui'
import type { ProbeView } from './useProbeLifecycle'

export const providerFieldClass =
  'w-full rounded-lg border border-line-strong bg-canvas px-2.75 py-2 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent'
const tones = {
  ok: { pill: 'success', dot: 'bg-green', text: 'text-green' },
  warn: { pill: 'stale', dot: 'bg-stale', text: 'text-stale-ink' },
  err: { pill: 'danger', dot: 'bg-danger', text: 'text-danger' },
} as const

type Props = {
  connection: ModelConnection
  provider: ProviderDescriptor
  /** This browser holds a key for the connection's current provider and base, and the draft keeps it. */
  keySaved: boolean
  /** The key typed in this draft; '' when none. */
  typedKey: string
  /** The saved key is being replaced: the input shows instead of the saved-key line. */
  replacing: boolean
  probe: ProbeView
  onUpdate: (change: Partial<Pick<ModelConnection, 'name' | 'baseUrl'>>) => void
  onReplaceKey: () => void
  onKeyChange: (key: string) => void
  onRemoveKey: () => void
  onUseWithoutKey: () => void
  onRemove: () => void
}

export function ProviderConnectionCard({
  connection,
  provider,
  keySaved,
  typedKey,
  replacing,
  probe,
  onUpdate,
  onReplaceKey,
  onKeyChange,
  onRemoveKey,
  onUseWithoutKey,
  onRemove,
}: Props) {
  const tone = probe.phase === 'done' ? (probe.result.status === 'connected' ? 'ok' : 'err') : probe.phase === 'error' ? 'err' : 'warn'
  const statusText = probe.phase === 'checking'
    ? 'Checking…'
    : probe.phase === 'done'
      ? probe.result.message
      : probe.phase === 'error'
        ? probe.message
        : 'Not checked this session.'
  const showSavedKey = keySaved && !replacing && typedKey === ''

  return (
    <article className="rounded-xl border border-line bg-surface p-3.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <b className="text-[12.5px] text-ink">{provider.label}</b>
        <div className="flex items-center gap-2">
          <Pill tone={tones[tone].pill} className="gap-1"><span aria-hidden="true" className={`size-1.25 shrink-0 rounded-full ${tones[tone].dot}`} />{probe.phase === 'done' ? probe.result.status : probe.phase}</Pill>
          <button type="button" onClick={onRemove} aria-label={`Delete ${connection.name}`} className="text-danger">×</button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Display name</span>
          <input value={connection.name} onChange={(event) => onUpdate({ name: event.target.value })} className={providerFieldClass} />
        </label>
        {provider.transport === 'http' && (
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Provider base URL</span>
            <input value={connection.baseUrl ?? ''} onChange={(event) => onUpdate({ baseUrl: event.target.value })} className={`font-mono ${providerFieldClass}`} />
          </label>
        )}
      </div>
      {provider.authentication !== 'external' && (showSavedKey ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-ink-muted">Key saved in this browser</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onReplaceKey}>Replace</Button>
            <Button variant="secondary" size="sm" onClick={onRemoveKey}>Remove</Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-1 items-end gap-2 md:grid-cols-[1fr_auto]">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">{provider.authentication === 'managed' ? 'API key' : 'API key (optional)'}</span>
            <input type="password" autoComplete="off" data-1p-ignore value={typedKey} onChange={(event) => onKeyChange(event.target.value)} placeholder={connection.hasKey ? 'Enter a key' : 'Used without a key'} className={`font-mono ${providerFieldClass}`} />
          </label>
          {provider.authentication === 'optional' && connection.hasKey && !keySaved && typedKey === '' && (
            <Button variant="secondary" size="sm" onClick={onUseWithoutKey}>Use without a key</Button>
          )}
        </div>
      ))}
      <p className={`mt-2 whitespace-pre-line text-[11px] ${tones[tone].text}`}>{statusText}</p>
    </article>
  )
}
