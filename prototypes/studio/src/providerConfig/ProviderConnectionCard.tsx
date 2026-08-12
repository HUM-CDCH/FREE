import type { CredentialState, ModelConnection, ProviderDescriptor, ProviderKind } from '../../shared/modelConfig.contract'
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
  providers: readonly ProviderDescriptor[]
  saved: boolean
  credentialState: CredentialState
  credentialAction: string | null | undefined
  probe: ProbeView
  onUpdate: (change: Partial<Pick<ModelConnection, 'name' | 'baseUrl'>>, probeInput: boolean) => void
  onProviderChange: (kind: ProviderKind) => void
  onCredentialChange: (action: string | null | undefined) => void
  onRemove: () => void
}

export function ProviderConnectionCard({
  connection,
  provider,
  providers,
  saved,
  credentialState,
  credentialAction,
  probe,
  onUpdate,
  onProviderChange,
  onCredentialChange,
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
          <input value={connection.name} onChange={(event) => onUpdate({ name: event.target.value }, false)} className={providerFieldClass} />
        </label>
        {!saved && (
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Provider</span>
            <select aria-label={`${connection.name} provider`} value={connection.provider} onChange={(event) => onProviderChange(event.target.value as ProviderKind)} className={`${providerFieldClass} cursor-pointer`}>
              {providers.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
            </select>
          </label>
        )}
        {provider.transport === 'http' && (
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Provider base URL</span>
            <input value={connection.baseUrl ?? ''} onChange={(event) => onUpdate({ baseUrl: event.target.value }, true)} className={`font-mono ${providerFieldClass}`} />
          </label>
        )}
      </div>
      {provider.authentication !== 'external' && (
        <div className="mt-2 grid grid-cols-1 items-end gap-2 md:grid-cols-[1fr_auto]">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">{provider.authentication === 'managed' ? 'API credential' : 'API credential (optional)'}</span>
            <input type="text" autoComplete="off" data-1p-ignore value={typeof credentialAction === 'string' ? credentialAction : ''} onChange={(event) => onCredentialChange(event.target.value || undefined)} placeholder={credentialState === 'present' ? 'Stored credential will be preserved' : 'Enter a credential'} className={`font-mono [-webkit-text-security:disc] ${providerFieldClass}`} />
          </label>
          <div className="flex gap-2">
            {credentialState === 'present' && credentialAction !== null && <Button variant="secondary" size="sm" onClick={() => onCredentialChange(null)}>Remove credential</Button>}
            {credentialAction !== undefined && <Button variant="secondary" size="sm" onClick={() => onCredentialChange(undefined)}>Preserve stored value</Button>}
          </div>
          {credentialState === 'unavailable' && <p className="text-[11px] text-danger">Credential store unavailable.</p>}
        </div>
      )}
      <p className={`mt-2 whitespace-pre-line text-[11px] ${tones[tone].text}`}>{statusText}</p>
    </article>
  )
}
