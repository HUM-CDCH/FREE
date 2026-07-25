import { useEffect, useState } from 'react'
import type { CredentialState, ProviderDescriptor, ProviderKind } from '../../shared/modelConfig.contract'
import { Button, EmptyState, Overline } from '../ui'
import { ProviderConnectionCard, providerFieldClass } from './ProviderConnectionCard'
import { ProviderRoutesEditor } from './ProviderRoutesEditor'
import { ModelConfigApiError, getModelConfig, putModelConfig } from './providerConfig.data'
import { useProbeLifecycle } from './useProbeLifecycle'
import { useProviderConfigDraft } from './useProviderConfigDraft'

function publicError(error: unknown): string {
  return error instanceof ModelConfigApiError
    ? `${error.code}: ${error.message}`
    : 'unexpected_failure: An unexpected failure occurred.'
}


function ProviderConfigPage({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([])
  const [credentialStates, setCredentialStates] = useState<Record<string, CredentialState>>({})
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(new Set())
  const [newProvider, setNewProvider] = useState<ProviderKind>('ollama')
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { probes, canProbe, schedule, refresh, dispose } = useProbeLifecycle({
    providers,
    credentialStates,
  })
  const {
    draft,
    mode,
    credentialActions,
    descriptor,
    actionFor,
    initialize,
    replaceAfterApply,
    setMode,
    updateConnection,
    changeProvider,
    updateCredential,
    addConnection,
    removeConnection,
    setRoute,
    setRouteModel,
    setSingleConnection,
    setSingleModel,
    setRawNuextract,
  } = useProviderConfigDraft({
    providers,
    scheduleProbe: schedule,
    disposeProbe: dispose,
  })

  useEffect(() => {
    const controller = new AbortController()
    void getModelConfig(controller.signal)
      .then((state) => {
        initialize(state.config)
        setProviders(state.providers)
        setSavedIds(new Set(state.config.connections.map(({ id }) => id)))
        setCredentialStates(state.credentialStates)
        setNewProvider(state.providers[0]?.kind ?? 'ollama')
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(publicError(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount load; deliberately not re-run when draft helpers change identity
  }, [])

  async function apply(): Promise<void> {
    if (!draft || applying) return
    setApplying(true)
    setError(null)
    try {
      const state = await putModelConfig(draft, credentialActions)
      replaceAfterApply(state.config)
      setSavedIds(new Set(state.config.connections.map(({ id }) => id)))
      setCredentialStates(state.credentialStates)
      // Credential actions clear only inside replaceAfterApply after success.
    } catch (cause) {
      setError(publicError(cause))
    } finally {
      setApplying(false)
    }
  }

  if (loading) {
    return <div className="mx-auto max-w-4xl rounded-2xl border border-line bg-surface p-6 text-sm text-ink-muted">Loading model configuration…</div>
  }
  if (!draft) {
    return (
      <div className="mx-auto max-w-4xl rounded-2xl border border-danger/40 bg-surface p-6">
        <p className="text-sm font-semibold text-danger">Model configuration could not be loaded.</p>
        {error && <p role="alert" className="mt-2 font-mono text-xs text-danger">{error}</p>}
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      </div>
    )
  }


  return (
    <div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-line bg-surface-muted shadow-page">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.75">
        <b className="text-[13px] text-ink">Model Connections</b>
        <div className="flex items-center gap-3">
          <div role="group" aria-label="Configuration mode" className="flex gap-0.5 rounded-lg border border-line bg-surface-muted p-0.5">
            {(['single', 'routes'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={`rounded-md px-3 py-[5px] text-[10.5px] font-semibold ${mode === value ? 'bg-canvas text-accent shadow-sm' : 'text-ink-faint'}`}
              >
                {value === 'single' ? 'Single model' : 'Capability Routes'}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} aria-label="Close Model Connections" className="text-lg text-ink-faint hover:text-ink">×</button>
        </div>
      </header>

      {error && <p role="alert" className="m-4 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 font-mono text-xs text-danger">{error}</p>}

      <section className="border-b border-line bg-surface p-4.5">
        <ProviderRoutesEditor
          mode={mode}
          draft={draft}
          probes={probes}
          descriptor={descriptor}
          setRoute={setRoute}
          setRouteModel={setRouteModel}
          setSingleConnection={setSingleConnection}
          setSingleModel={setSingleModel}
          setRawNuextract={setRawNuextract}
        />
      </section>
      <section className="p-4.5">

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <Overline>Your connections</Overline>
          <div className="flex gap-2">
            <select value={newProvider} onChange={(event) => setNewProvider(event.target.value as ProviderKind)} aria-label="New connection provider" className={`${providerFieldClass} w-auto cursor-pointer`}>
              {providers.map((provider) => <option key={provider.kind} value={provider.kind}>{provider.label}</option>)}
            </select>
            <Button variant="primary" size="sm" onClick={() => addConnection(newProvider)}>+ New connection</Button>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {draft.connections.map((connection) => {
            const provider = descriptor(connection)
            if (!provider) return null
            const action = actionFor(connection.id)
            return (
              <ProviderConnectionCard
                key={connection.id}
                connection={connection}
                provider={provider}
                providers={providers}
                saved={savedIds.has(connection.id)}
                credentialState={credentialStates[connection.id] ?? 'absent'}
                credentialAction={action}
                probe={probes[connection.id] ?? { phase: 'idle' }}
                canProbe={canProbe(connection, action)}
                onUpdate={(change, probeInput) => updateConnection(connection, change, probeInput)}
                onProviderChange={(kind) => changeProvider(connection, kind)}
                onCredentialChange={(next) => updateCredential(connection, next)}
                onRemove={() => removeConnection(connection.id)}
                onRefresh={() => refresh(connection, action)}
              />
            )
          })}
          {draft.connections.length === 0 && <EmptyState title="No Model Connections yet." description="Add one, enter an exact model ID, and Apply." />}
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          <Button variant="primary" size="md" disabled={applying} onClick={() => void apply()}>{applying ? 'Applying…' : 'Apply'}</Button>
        </div>
      </section>
    </div>
  )
}

export default ProviderConfigPage
