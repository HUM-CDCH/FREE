import { useEffect, useState } from 'react'
import type {
  CredentialActions,
  CredentialState,
  ModelConfig,
  ModelConnection,
  ProviderDescriptor,
  ProviderKind,
  RouteKey,
} from '../../shared/modelConfig.contract'
import { Button, EmptyState, Overline, Pill } from '../ui'
import { ModelConfigApiError, ROUTABLE_TASKS, getModelConfig, putModelConfig } from './providerConfig.data'
import { useProbeLifecycle, type ProbeView } from './useProbeLifecycle'

const fieldClass =
  'w-full rounded-lg border border-line-strong bg-canvas px-2.75 py-2 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent'
const tones = {
  ok: { pill: 'success', dot: 'bg-green', text: 'text-green' },
  warn: { pill: 'stale', dot: 'bg-stale', text: 'text-stale-ink' },
  err: { pill: 'danger', dot: 'bg-danger', text: 'text-danger' },
} as const


function Dot({ tone }: { tone: keyof typeof tones }) {
  return <span aria-hidden="true" className={`size-1.25 shrink-0 rounded-full ${tones[tone].dot}`} />
}

function publicError(error: unknown): string {
  return error instanceof ModelConfigApiError ? `${error.code}: ${error.message}` : 'unexpected_failure: An unexpected failure occurred.'
}


function configurationMode(config: ModelConfig): 'single' | 'routes' {
  const { extraction, interaction } = config.routes
  if (extraction === null && interaction === null) return 'single'
  if (extraction === null || interaction === null) return 'routes'
  return extraction.connectionId === interaction.connectionId &&
    extraction.modelId === interaction.modelId &&
    !('nuextractRaw' in extraction && extraction.nuextractRaw)
    ? 'single'
    : 'routes'
}

function statusTone(view: ProbeView): keyof typeof tones {
  if (view.phase === 'done') return view.result.status === 'connected' ? 'ok' : 'err'
  return view.phase === 'error' ? 'err' : 'warn'
}

function ProviderConfigPage({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<ModelConfig | null>(null)
  const [providers, setProviders] = useState<ProviderDescriptor[]>([])
  const [credentialStates, setCredentialStates] = useState<Record<string, CredentialState>>({})
  const [credentialActions, setCredentialActions] = useState<CredentialActions>({})
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(new Set())
  const [mode, setMode] = useState<'single' | 'routes'>('single')
  const [newProvider, setNewProvider] = useState<ProviderKind>('ollama')
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void getModelConfig(controller.signal)
      .then((state) => {
        setDraft(state.config)
        setMode(configurationMode(state.config))
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
  }, [])


  const descriptor = (connection: ModelConnection) =>
    providers.find(({ kind }) => kind === connection.provider)

  const actionFor = (connectionId: string): string | null | undefined =>
    Object.hasOwn(credentialActions, connectionId) ? credentialActions[connectionId] : undefined
  const { probes, canProbe, schedule, refresh, dispose } = useProbeLifecycle({
    providers,
    credentialStates,
  })


  function updateConnection(
    connection: ModelConnection,
    change: Partial<Pick<ModelConnection, 'name' | 'baseUrl'>>,
    probeInput: boolean,
  ): void {
    if (!draft) return
    const next = { ...connection, ...change }
    setDraft({
      ...draft,
      connections: draft.connections.map((item) => (item.id === connection.id ? next : item)),
    })
    if (probeInput) schedule(next, actionFor(next.id))
  }

  /**
   * Draft connections only: the backend rejects a provider change on a saved
   * connection, so `savedIds` gates the control.
   */
  function changeProvider(connection: ModelConnection, kind: ProviderKind): void {
    if (!draft) return
    const provider = providers.find((item) => item.kind === kind)
    if (!provider) return
    const next: ModelConnection = {
      ...connection,
      provider: kind,
      name: connection.name === descriptor(connection)?.label ? provider.label : connection.name,
      baseUrl: provider.transport === 'http' ? (provider.defaultBaseUrl ?? '') : null,
    }
    const routes = { ...draft.routes }
    const { extraction } = routes
    if (extraction?.connectionId === connection.id && !provider.supportsNuextractRaw) {
      routes.extraction = { connectionId: extraction.connectionId, modelId: extraction.modelId }
    }
    setDraft({
      connections: draft.connections.map((item) => (item.id === connection.id ? next : item)),
      routes,
    })
    // An external provider has no FREE-managed credential, and the probe rejects
    // one, so a pending action for it is dropped rather than sent.
    const action = provider.authentication === 'external' ? undefined : actionFor(connection.id)
    if (provider.authentication === 'external' && Object.hasOwn(credentialActions, connection.id)) {
      const actions = { ...credentialActions }
      delete actions[connection.id]
      setCredentialActions(actions)
    }
    schedule(next, action)
  }

  function updateCredential(connection: ModelConnection, action: string | null | undefined): void {
    const next = { ...credentialActions }
    if (action === undefined) delete next[connection.id]
    else next[connection.id] = action
    setCredentialActions(next)
    schedule(connection, action)
  }

  function addConnection(): void {
    if (!draft) return
    const provider = providers.find(({ kind }) => kind === newProvider)
    if (!provider) return
    const connection: ModelConnection = {
      id: crypto.randomUUID(),
      name: provider.label,
      provider: provider.kind,
      baseUrl: provider.transport === 'http' ? (provider.defaultBaseUrl ?? '') : null,
    }
    setDraft({
      ...draft,
      connections: [...draft.connections, connection],
    })
    schedule(connection, actionFor(connection.id))
  }

  function removeConnection(connectionId: string): void {
    if (!draft) return
    const routes = { ...draft.routes }
    if (routes.extraction?.connectionId === connectionId) routes.extraction = null
    if (routes.interaction?.connectionId === connectionId) routes.interaction = null
    setDraft({
      connections: draft.connections.filter(({ id }) => id !== connectionId),
      routes,
    })
    const actions = { ...credentialActions }
    delete actions[connectionId]
    setCredentialActions(actions)
    dispose(connectionId)
  }

  function setRoute(key: RouteKey, connectionId: string): void {
    if (!draft) return
    if (!connectionId) {
      setDraft({ ...draft, routes: { ...draft.routes, [key]: null } })
      return
    }
    const current = draft.routes[key]
    const selected = draft.connections.find(({ id }) => id === connectionId)
    const rawSupported = selected ? descriptor(selected)?.supportsNuextractRaw === true : false
    setDraft({
      ...draft,
      routes: {
        ...draft.routes,
        [key]: {
          connectionId,
          modelId: current?.modelId ?? '',
          ...(key === 'extraction' && rawSupported && current && 'nuextractRaw' in current && current.nuextractRaw
            ? { nuextractRaw: true as const }
            : {}),
        },
      },
    })
  }

  function setRouteModel(key: RouteKey, modelId: string): void {
    if (!draft?.routes[key]) return
    setDraft({
      ...draft,
      routes: { ...draft.routes, [key]: { ...draft.routes[key], modelId } },
    })
  }

  function setSingleConnection(connectionId: string): void {
    if (!draft) return
    if (!connectionId) {
      setDraft({ ...draft, routes: { extraction: null, interaction: null } })
      return
    }
    const modelId = draft.routes.extraction?.modelId ?? draft.routes.interaction?.modelId ?? ''
    const route = { connectionId, modelId }
    setDraft({ ...draft, routes: { extraction: route, interaction: route } })
  }

  function setSingleModel(modelId: string): void {
    if (!draft) return
    const connectionId = draft.routes.extraction?.connectionId ?? draft.routes.interaction?.connectionId
    if (!connectionId) return
    const route = { connectionId, modelId }
    setDraft({ ...draft, routes: { extraction: route, interaction: route } })
  }

  async function apply(): Promise<void> {
    if (!draft || applying) return
    setApplying(true)
    setError(null)
    try {
      const state = await putModelConfig(draft, credentialActions)
      setDraft(state.config)
      setSavedIds(new Set(state.config.connections.map(({ id }) => id)))
      setCredentialStates(state.credentialStates)
      setCredentialActions({})
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

  const extraction = draft.routes.extraction
  const interaction = draft.routes.interaction
  const uniform =
    extraction !== null &&
    interaction !== null &&
    extraction.connectionId === interaction.connectionId &&
    extraction.modelId === interaction.modelId &&
    !('nuextractRaw' in extraction && extraction.nuextractRaw)
  const singleConnectionId = uniform ? extraction.connectionId : (extraction?.connectionId ?? '')
  const singleModelId = uniform ? extraction.modelId : (extraction?.modelId ?? '')
  const singleProbe = probes[singleConnectionId]
  const singleCatalog = singleProbe?.phase === 'done' ? singleProbe.result.catalog : []

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
        {mode === 'single' ? (
          <div className="flex flex-col gap-3">
            {!uniform && <p className="rounded-lg border border-stale bg-stale-soft px-3 py-2 text-[11px] text-stale-ink">Capability Routes currently differ. Selecting a connection and model here will assign the same target to both.</p>}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] font-semibold uppercase text-ink-muted">Connection</span>
                <select aria-label="Single model connection" value={singleConnectionId} onChange={(event) => setSingleConnection(event.target.value)} className={`${fieldClass} cursor-pointer`}>
                  <option value="">Select a connection…</option>
                  {draft.connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] font-semibold uppercase text-ink-muted">Model ID</span>
                <input
                  aria-label="Single model ID"
                  value={singleModelId}
                  onChange={(event) => setSingleModel(event.target.value)}
                  list={singleConnectionId ? `models-single-${singleConnectionId}` : undefined}
                  placeholder={singleCatalog.length > 0 ? 'Select or enter a model ID' : 'Enter an exact model ID'}
                  className={`font-mono ${fieldClass}`}
                />
                {singleConnectionId && (
                  <datalist id={`models-single-${singleConnectionId}`}>
                    {singleCatalog.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                  </datalist>
                )}
                {singleConnectionId && singleCatalog.length === 0 && (
                  <span className="text-[10.5px] text-ink-faint">Use Refresh models below to list this connection's models.</span>
                )}
              </label>
            </div>
          </div>
        ) : (
          <div>
            <Overline as="p" className="mb-3">Capability Routes</Overline>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {ROUTABLE_TASKS.map((task) => {
                const route = draft.routes[task.key]
                const connection = draft.connections.find(({ id }) => id === route?.connectionId)
                const provider = connection ? descriptor(connection) : undefined
                const probe = connection ? probes[connection.id] : undefined
                const catalog = probe?.phase === 'done' ? probe.result.catalog : []
                return (
                  <div key={task.key} className="rounded-xl border border-line bg-canvas p-3.5">
                    <b className="text-[12.5px] text-ink">{task.label}</b>
                    <p className="mb-2.5 text-[10.5px] text-ink-faint">{task.description}</p>
                    <label className="mb-2 flex flex-col gap-1">
                      <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Connection</span>
                      <select aria-label={`${task.label} connection`} value={route?.connectionId ?? ''} onChange={(event) => setRoute(task.key, event.target.value)} className={`${fieldClass} cursor-pointer`}>
                        <option value="">Select a connection…</option>
                        {draft.connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Model ID</span>
                      <input
                        aria-label={`${task.label} model ID`}
                        value={route?.modelId ?? ''}
                        onChange={(event) => setRouteModel(task.key, event.target.value)}
                        list={connection ? `models-${task.key}-${connection.id}` : undefined}
                        disabled={!route}
                        placeholder="Enter an exact model ID"
                        className={`font-mono ${fieldClass}`}
                      />
                      {connection && <datalist id={`models-${task.key}-${connection.id}`}>{catalog.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>}
                    </label>
                    {task.key === 'extraction' && provider?.supportsNuextractRaw && route && (
                      <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-muted">
                        <input
                          type="checkbox"
                          checked={'nuextractRaw' in route && route.nuextractRaw === true}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? { ...route, nuextractRaw: true as const }
                              : { connectionId: route.connectionId, modelId: route.modelId }
                            setDraft({ ...draft, routes: { ...draft.routes, extraction: next } })
                          }}
                        />
                        Use raw NuExtract protocol
                      </label>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <section className="p-4.5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <Overline>Your connections</Overline>
          <div className="flex gap-2">
            <select value={newProvider} onChange={(event) => setNewProvider(event.target.value as ProviderKind)} aria-label="New connection provider" className={`${fieldClass} w-auto cursor-pointer`}>
              {providers.map((provider) => <option key={provider.kind} value={provider.kind}>{provider.label}</option>)}
            </select>
            <Button variant="primary" size="sm" onClick={addConnection}>+ New connection</Button>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {draft.connections.map((connection) => {
            const provider = descriptor(connection)
            if (!provider) return null
            const view = probes[connection.id] ?? { phase: 'idle' as const }
            const tone = statusTone(view)
            const action = actionFor(connection.id)
            // An absent map entry means FREE manages no credential for this
            // connection yet (e.g. it is not saved) — not a broken keyring.
            const credentialState = credentialStates[connection.id] ?? 'absent'
            const statusText = view.phase === 'checking'
              ? 'Checking…'
              : view.phase === 'done'
                ? view.result.message
                : view.phase === 'error'
                  ? view.message
                  : 'Not checked this session.'
            return (
              <article key={connection.id} className="rounded-xl border border-line bg-surface p-3.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <b className="text-[12.5px] text-ink">{provider.label}</b>
                  <div className="flex items-center gap-2">
                    <Pill tone={tones[tone].pill} className="gap-1"><Dot tone={tone} />{view.phase === 'done' ? view.result.status : view.phase}</Pill>
                    <button type="button" onClick={() => removeConnection(connection.id)} aria-label={`Delete ${connection.name}`} className="text-danger">×</button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Display name</span>
                    <input value={connection.name} onChange={(event) => updateConnection(connection, { name: event.target.value }, false)} className={fieldClass} />
                  </label>
                  {!savedIds.has(connection.id) && (
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Provider</span>
                      <select aria-label={`${connection.name} provider`} value={connection.provider} onChange={(event) => changeProvider(connection, event.target.value as ProviderKind)} className={`${fieldClass} cursor-pointer`}>
                        {providers.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
                      </select>
                    </label>
                  )}
                  {provider.transport === 'http' && (
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Provider API base</span>
                      <input value={connection.baseUrl ?? ''} onChange={(event) => updateConnection(connection, { baseUrl: event.target.value }, true)} className={`font-mono ${fieldClass}`} />
                    </label>
                  )}
                </div>
                {provider.authentication !== 'external' && (
                  <div className="mt-2 grid grid-cols-1 items-end gap-2 md:grid-cols-[1fr_auto]">
                    <label className="flex flex-col gap-1">
                      <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">{provider.authentication === 'managed' ? 'API credential' : 'API credential (optional)'}</span>
                      <input
                        type="text"
                        autoComplete="off"
                        data-1p-ignore
                        value={typeof action === 'string' ? action : ''}
                        onChange={(event) => updateCredential(connection, event.target.value || undefined)}
                        placeholder={credentialState === 'present' ? 'Stored credential will be preserved' : 'Enter a credential'}
                        className={`font-mono [-webkit-text-security:disc] ${fieldClass}`}
                      />
                    </label>
                    <div className="flex gap-2">
                      {credentialState === 'present' && action !== null && <Button variant="secondary" size="sm" onClick={() => updateCredential(connection, null)}>Remove credential</Button>}
                      {action !== undefined && <Button variant="secondary" size="sm" onClick={() => updateCredential(connection, undefined)}>Preserve stored value</Button>}
                    </div>
                    {credentialState === 'unavailable' && <p className="text-[11px] text-danger">Credential store unavailable.</p>}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className={`text-[11px] ${tones[tone].text}`}>{statusText}</p>
                  <Button variant="secondary" size="sm" disabled={!canProbe(connection, actionFor(connection.id)) || view.phase === 'checking'} onClick={() => refresh(connection, actionFor(connection.id))}>Refresh models</Button>
                </div>
              </article>
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
