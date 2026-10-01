import { type KeyboardEvent, type RefObject, useContext, useEffect, useId, useRef, useState } from 'react'
import type { ExtractionModelListing } from '../../shared/extraction.contract'
import type { DeploymentModels, GetModelConfigResponse, IngestionModelListing, ProviderDescriptor } from '../../shared/modelConfig.contract'
import { readExtractionModels, readIngestionModels } from '../api'
import { ResearcherSessionContext } from '../auth/sessionContext'
import { sendModelKeys } from '../modelKeys/modelKeyHandoff'
import { Button } from '../ui'
import { AdvancedTab } from './AdvancedTab'
import { ConnectionsTab } from './ConnectionsTab'
import { ModelsTab } from './ModelsTab'
import { apiErrorText, getModelConfig, putModelConfig } from './providerConfig.data'
import { probesDiffer, useProbeLifecycle } from './useProbeLifecycle'
import { useProviderConfigDraft } from './useProviderConfigDraft'

type PageProps = {
  onClose: () => void
  initialFocusRef?: RefObject<HTMLButtonElement | null>
}

type Tab = 'models' | 'connections' | 'advanced'
const TABS: readonly Tab[] = ['models', 'connections', 'advanced']

/** Keys are kept per Researcher Account, so the page needs the signed-in one. */
function ProviderConfigPage(props: PageProps) {
  const researcher = useContext(ResearcherSessionContext)
  if (!researcher) throw new Error('Model Configuration needs a signed-in Researcher Account.')
  return <ModelConfigurationEditor accountId={researcher.session.account.id} {...props} />
}

function ModelConfigurationEditor({ accountId, onClose, initialFocusRef }: PageProps & { accountId: string }) {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([])
  const [deployment, setDeployment] = useState<DeploymentModels>({ connections: [], defaultRoute: null })
  // The deployment's model listings; null until listed, and for good when they cannot be. Neither blocks an edit.
  const [extractionListing, setExtractionListing] = useState<ExtractionModelListing | null>(null)
  const [ingestionListing, setIngestionListing] = useState<IngestionModelListing | null>(null)
  const [tab, setTab] = useState<Tab>('models')
  const [selected, setSelected] = useState<string | null>(null)
  // Connections whose saved key is being replaced: their key input shows instead of the saved-key line.
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set())
  // Connections to probe once the state a probe reads (providers, draft, keys) has rendered: on open, after Discard.
  const [probeRequest, setProbeRequest] = useState<{ ids: ReadonlySet<string> } | null>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  // Set by the footer's issue summary until the Advanced tab has focused the first invalid control.
  const [focusIssue, setFocusIssue] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tabIds = { models: useId(), connections: useId(), advanced: useId() }
  const panelId = useId()
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})

  const { probes, schedule, refreshAll, cancel, dispose } = useProbeLifecycle({ providers })
  const editor = useProviderConfigDraft({
    accountId,
    providers,
    scheduleProbe: schedule,
    cancelProbe: cancel,
    disposeProbe: dispose,
  })
  const { draft, saved, keyEdits, keyIssues, dirty, credentialFor } = editor

  function receive(state: GetModelConfigResponse): void {
    editor.initialize(state.config)
    setProviders(state.providers)
    setDeployment(state.deployment)
    setProbeRequest({ ids: new Set([...state.deployment.connections, ...state.config.connections].map(({ id }) => id)) })
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
    // A listing that fails stays empty: the step keeps the deployment's defaults and any saved choice.
    readExtractionModels(controller.signal).then(
      (listing) => {
        if (!controller.signal.aborted) setExtractionListing(listing)
      },
      () => {},
    )
    readIngestionModels(controller.signal).then(
      (listing) => {
        if (!controller.signal.aborted) setIngestionListing(listing)
      },
      () => {},
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount load; deliberately not re-run when draft helpers change identity
  }, [])

  // Each eligible connection is probed once, now, with exactly the credential it may carry: none for a deployment or
  // keyless connection, this browser's key for this address for one with `hasKey`, and not at all without that key.
  useEffect(() => {
    if (!probeRequest || !draft) return
    refreshAll(
      [...deployment.connections, ...draft.connections]
        .filter(({ id }) => probeRequest.ids.has(id))
        .map((connection) => ({ connection, credential: credentialFor(connection) })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request; it reads the state rendered with it
  }, [probeRequest])

  async function apply(): Promise<void> {
    if (!draft || applying) return
    setApplying(true)
    setError(null)
    try {
      const state = await putModelConfig(draft)
      const dropped = editor.commit(state.config)
      setReplacing(new Set())
      // Studio gets this browser's keys for the committed configuration, and forgets the ones it dropped.
      void sendModelKeys(accountId, dropped)
    } catch (cause) {
      setError(apiErrorText(cause))
    } finally {
      setApplying(false)
    }
  }

  /** Back to the saved configuration. A connection is probed again as saved only when the draft changed what a probe
   *  of it does (its address, `hasKey`, a key, or its removal); a rename alone is not. */
  function discard(): void {
    if (!draft || !saved) return
    const drafted = new Map(draft.connections.map((connection) => [connection.id, connection]))
    for (const { id } of draft.connections) if (!saved.connections.some((connection) => connection.id === id)) dispose(id)
    const changed = saved.connections.filter((connection) => {
      const before = drafted.get(connection.id)
      return !before || Object.hasOwn(keyEdits, connection.id) || probesDiffer(before, connection)
    })
    editor.discard()
    setReplacing(new Set())
    setError(null)
    if (changed.length > 0) setProbeRequest({ ids: new Set(changed.map(({ id }) => id)) })
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = TABS[(TABS.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  if (loading) {
    return <div className="mx-auto max-w-4xl rounded-2xl border border-line bg-surface p-6 text-sm text-ink-muted">Loading model configuration…</div>
  }
  if (!draft) {
    return (
      <div className="mx-auto max-w-4xl rounded-2xl border border-danger/40 bg-surface p-6">
        <p className="text-sm font-semibold text-danger">Model configuration could not be loaded.</p>
        {error && <p role="alert" className="mt-2 font-mono text-xs whitespace-pre-line text-danger">{error}</p>}
        <div className="mt-3 flex gap-2">
          <Button ref={initialFocusRef} autoFocus variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    )
  }

  const routable = [...deployment.connections, ...draft.connections]
  const current = routable.find(({ id }) => id === selected) ?? routable[0] ?? null
  const blocked = Object.keys(keyIssues).length > 0 || editor.settingsIssues.length > 0

  return (
    <fieldset disabled={applying} className="model-configuration mx-auto flex min-w-0 max-w-4xl flex-col rounded-2xl border border-line bg-surface shadow-page">
      {/* Below `sm` the three tabs take their own row under the title and close button, so nothing scrolls sideways. */}
      <header className="flex flex-wrap items-center gap-x-4 rounded-t-2xl border-b border-line bg-surface px-5 pt-3">
        <h2 className="mr-auto pb-3 text-[13px] font-bold text-ink sm:mr-0">Model Configuration</h2>
        <div role="tablist" aria-label="Model Configuration" className="order-last flex w-full gap-4 self-end sm:order-none sm:w-auto sm:flex-1">
          {TABS.map((key) => (
            <button
              key={key}
              ref={(element) => {
                tabRefs.current[key] = element
              }}
              id={tabIds[key]}
              role="tab"
              type="button"
              aria-selected={tab === key}
              aria-controls={panelId}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={onTabKeyDown}
              className={`-mb-px border-b-2 pb-2.5 text-[12px] font-semibold transition-colors ${
                tab === key ? 'border-accent text-accent' : 'border-transparent text-ink-faint hover:text-ink'
              }`}
            >
              {key === 'models' ? 'Models' : key === 'connections' ? `Connections · ${routable.length}` : 'Advanced'}
            </button>
          ))}
        </div>
        <button
          ref={initialFocusRef}
          autoFocus
          type="button"
          onClick={onClose}
          aria-label="Close Model Configuration"
          className="pb-3 text-lg text-ink-faint hover:text-ink"
        >
          ×
        </button>
      </header>

      {error && (
        <p role="alert" className="mx-5 mt-4 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 font-mono text-xs whitespace-pre-line text-danger">
          {error}
        </p>
      )}

      <div role="tabpanel" id={panelId} aria-labelledby={tabIds[tab]} className="min-h-0 flex-1 bg-surface-muted/60">
        {tab === 'models' ? (
          <ModelsTab
            draft={draft}
            deployment={deployment}
            descriptor={editor.descriptor}
            probes={probes}
            extractionListing={extractionListing}
            ingestionListing={ingestionListing}
            assign={editor.assign}
            setExtractionModel={editor.setExtractionModel}
            setIngestionModel={editor.setIngestionModel}
          />
        ) : tab === 'advanced' ? (
          <AdvancedTab
            draft={draft}
            saved={saved ?? draft}
            editor={editor}
            focusIssue={focusIssue}
            onIssueFocused={() => setFocusIssue(false)}
          />
        ) : (
          <ConnectionsTab
            accountId={accountId}
            draft={draft}
            deployment={deployment}
            providers={providers}
            probes={probes}
            editor={editor}
            replacing={replacing}
            onReplacing={(id, on) =>
              setReplacing((ids) => {
                const next = new Set(ids)
                if (on) next.add(id)
                else next.delete(id)
                return next
              })
            }
            selected={current}
            onSelect={setSelected}
          />
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t border-line bg-surface px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11.5px] text-ink-faint">{dirty ? 'Unsaved changes' : 'Everything saved'}</span>
          {editor.settingsIssues.length > 0 && (
            <button
              type="button"
              className="text-[11.5px] font-semibold text-danger underline"
              onClick={() => {
                setTab('advanced')
                setFocusIssue(true)
              }}
            >
              {editor.settingsIssues.length === 1 ? '1 issue blocks Apply' : `${editor.settingsIssues.length} issues block Apply`}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="md" disabled={!dirty} onClick={discard}>Discard</Button>
          <Button variant="primary" size="md" disabled={applying || !dirty || blocked} onClick={() => void apply()}>
            {applying ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </footer>
    </fieldset>
  )
}

export default ProviderConfigPage
