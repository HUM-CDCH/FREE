import { type RefObject, useContext, useEffect, useState } from 'react'
import type { ExtractionModelListing } from '../../shared/extraction.contract'
import type { DeploymentModels, GetModelConfigResponse, ProviderDescriptor, ProviderKind } from '../../shared/modelConfig.contract'
import { readExtractionModels } from '../api'
import { ResearcherSessionContext } from '../auth/sessionContext'
import { sendModelKeys } from '../modelKeys/modelKeyHandoff'
import { modelKeyFor } from '../modelKeys/modelKeyStore'
import { Button, EmptyState, Overline } from '../ui'
import { ExtractionModelSelect } from './ExtractionModelSelect'
import { ProviderConnectionCard, providerFieldClass } from './ProviderConnectionCard'
import { ProviderRoutesEditor } from './ProviderRoutesEditor'
import { apiErrorText, getModelConfig, putModelConfig } from './providerConfig.data'
import { useProbeLifecycle } from './useProbeLifecycle'
import { useProviderConfigDraft } from './useProviderConfigDraft'

type PageProps = {
  onClose: () => void
  initialFocusRef?: RefObject<HTMLButtonElement | null>
}

/** Keys are kept per Researcher Account, so the page needs the signed-in one. */
function ProviderConfigPage(props: PageProps) {
  const researcher = useContext(ResearcherSessionContext)
  if (!researcher) throw new Error('Model Configuration needs a signed-in Researcher Account.')
  return <ModelConfigurationEditor accountId={researcher.session.account.id} {...props} />
}

function ModelConfigurationEditor({ accountId, onClose, initialFocusRef }: PageProps & { accountId: string }) {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([])
  const [deployment, setDeployment] = useState<DeploymentModels>({ connections: [], defaultRoute: null })
  // kei-exp's extraction models; null until listed, and for good when they cannot be.
  const [extractionListing, setExtractionListing] = useState<ExtractionModelListing | null>(null)
  const [newProvider, setNewProvider] = useState<ProviderKind>('ollama')
  // Connections whose saved key is being replaced: their key input shows instead of the saved-key line.
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { probes, schedule, refresh, cancel, dispose } = useProbeLifecycle({ providers })
  const {
    draft,
    keyEdits,
    descriptor,
    credentialFor,
    initialize,
    assign,
    setExtractionModel,
    addConnection,
    updateConnection,
    setKey,
    removeKey,
    connectWithoutKey,
    removeConnection,
    commit,
  } = useProviderConfigDraft({
    accountId,
    providers,
    scheduleProbe: schedule,
    cancelProbe: cancel,
    disposeProbe: dispose,
  })

  function receive(state: GetModelConfigResponse): void {
    initialize(state.config)
    setProviders(state.providers)
    setDeployment(state.deployment)
    setNewProvider(state.providers[0]?.kind ?? 'ollama')
  }

  useEffect(() => {
    const controller = new AbortController()
    void getModelConfig(controller.signal)
      .then(receive)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setError(apiErrorText(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    // A failed listing leaves only kei-exp's defaults, which never block a run.
    readExtractionModels(controller.signal).then(
      (listing) => {
        if (!controller.signal.aborted) setExtractionListing(listing)
      },
      () => {},
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount load; deliberately not re-run when draft helpers change identity
  }, [])

  async function apply(): Promise<void> {
    if (!draft || applying) return
    setApplying(true)
    setError(null)
    try {
      const state = await putModelConfig(draft)
      const dropped = commit(state.config)
      setReplacing(new Set())
      // Studio gets this browser's keys for the committed configuration, and forgets the ones it dropped.
      void sendModelKeys(accountId, dropped)
    } catch (cause) {
      setError(apiErrorText(cause))
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
        {error && <p role="alert" className="mt-2 whitespace-pre-line font-mono text-xs text-danger">{error}</p>}
        <div className="mt-3 flex gap-2">
          <Button ref={initialFocusRef} autoFocus variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    )
  }

  const hasConnections = draft.connections.length > 0
  const routable = [...deployment.connections, ...draft.connections]

  function openModelList(connectionId: string): void {
    const phase = probes[connectionId]?.phase ?? 'idle'
    if (phase === 'checking' || phase === 'done') return
    const connection = routable.find(({ id }) => id === connectionId)
    if (connection) refresh(connection, credentialFor(connection))
  }

  return (
    <fieldset disabled={applying} className="mx-auto min-w-0 max-w-4xl overflow-hidden rounded-2xl border border-line bg-surface-muted shadow-page">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.75">
        <b className="text-[13px] text-ink">Model Configuration</b>
        <button ref={initialFocusRef} autoFocus type="button" onClick={onClose} aria-label="Close Model Configuration" className="text-lg text-ink-faint hover:text-ink">×</button>
      </header>

      {error && <p role="alert" className="m-4 whitespace-pre-line rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 font-mono text-xs text-danger">{error}</p>}

      <section aria-label="Extraction models" className="border-b border-line bg-surface p-4.5">
        <Overline as="p" className="mb-1">Extraction</Overline>
        <p className="mb-3 text-[10.5px] text-ink-faint">kei-exp's models for every single and batch Extraction.</p>
        <div className="flex flex-wrap gap-4">
          {(['fields', 'reasoning'] as const).map((role) => (
            <ExtractionModelSelect
              key={role}
              role={role}
              listing={extractionListing}
              value={draft.extractionModels[role] ?? ''}
              disabled={applying}
              onChange={(key) => setExtractionModel(role, key)}
            />
          ))}
        </div>
      </section>

      {routable.length > 0 && <section className="border-b border-line bg-surface p-4.5">
        <ProviderRoutesEditor
          draft={draft}
          connections={routable}
          defaultModelId={deployment.defaultRoute?.modelId ?? null}
          probes={probes}
          descriptor={descriptor}
          onModelListOpen={openModelList}
          assign={assign}
        />
      </section>}
      <section className="p-4.5">
        {deployment.connections.length > 0 && (
          <div className="mb-5">
            <Overline as="p" className="mb-3">Deployment connections</Overline>
            <ul className="flex flex-col gap-2">
              {deployment.connections.map((connection) => (
                <li key={connection.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-canvas px-3.5 py-2.5">
                  <span className="min-w-0">
                    <b className="block text-[12.5px] text-ink">{connection.name}</b>
                    <span className="block truncate font-mono text-[10.5px] text-ink-faint">{connection.baseUrl}</span>
                  </span>
                  <span className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[10px] font-semibold uppercase text-ink-muted">Deployment</span>
                </li>
              ))}
            </ul>
          </div>
        )}

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
            const edit = keyEdits[connection.id]
            return (
              <ProviderConnectionCard
                key={connection.id}
                connection={connection}
                provider={provider}
                keySaved={edit === undefined && connection.hasKey && modelKeyFor(accountId, connection) !== null}
                typedKey={typeof edit === 'string' ? edit : ''}
                replacing={replacing.has(connection.id)}
                probe={probes[connection.id] ?? { phase: 'idle' }}
                onUpdate={(change) => updateConnection(connection.id, change)}
                onReplaceKey={() => setReplacing((current) => new Set(current).add(connection.id))}
                onKeyChange={(key) => setKey(connection.id, key)}
                onRemoveKey={() => removeKey(connection.id)}
                onUseWithoutKey={() => connectWithoutKey(connection.id)}
                onRemove={() => removeConnection(connection.id)}
              />
            )
          })}
          {!hasConnections && <EmptyState title="No Model Connections yet." description="Choose a provider above and add your first connection. You'll pick a model afterwards." />}
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          <Button variant="primary" size="md" disabled={applying} onClick={() => void apply()}>{applying ? 'Applying…' : 'Apply'}</Button>
        </div>
      </section>
    </fieldset>
  )
}

export default ProviderConfigPage
