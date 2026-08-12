import type { ModelConfig, ModelConnection, ProviderDescriptor, RouteKey } from '../../shared/modelConfig.contract'
import { Overline } from '../ui'
import { ModelCombobox } from './ModelCombobox'
import { providerFieldClass } from './ProviderConnectionCard'
import { ROUTABLE_TASKS } from './providerConfig.data'
import type { ProbeView } from './useProbeLifecycle'
import type { ConfigurationMode } from './useProviderConfigDraft'

type Props = {
  mode: ConfigurationMode
  draft: ModelConfig
  probes: Readonly<Record<string, ProbeView>>
  descriptor: (connection: ModelConnection) => ProviderDescriptor | undefined
  onModelListOpen: (connectionId: string) => void
  setRoute: (key: RouteKey, connectionId: string) => void
  setRouteModel: (key: RouteKey, modelId: string) => void
  setSingleConnection: (connectionId: string) => void
  setSingleModel: (modelId: string) => void
  setRawNuextract: (enabled: boolean) => void
}

export function ProviderRoutesEditor({
  mode,
  draft,
  probes,
  descriptor,
  onModelListOpen,
  setRoute,
  setRouteModel,
  setSingleConnection,
  setSingleModel,
  setRawNuextract,
}: Props) {
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

  if (mode === 'single') {
    return (
      <div>
        {!uniform && (extraction !== null || interaction !== null) && <p className="rounded-lg border border-stale bg-stale-soft px-3 py-2 text-[11px] text-stale-ink">Capability Routes currently differ. Selecting a connection and model here will assign the same target to both.</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] font-semibold uppercase text-ink-muted">Connection</span>
            <select aria-label="Single model connection" value={singleConnectionId} onChange={(event) => setSingleConnection(event.target.value)} className={`${providerFieldClass} cursor-pointer`}>
              <option value="">Select a connection…</option>
              {draft.connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
            </select>
          </label>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] font-semibold uppercase text-ink-muted">Model ID</span>
            <ModelCombobox
              ariaLabel="Single model ID"
              value={singleModelId}
              onChange={setSingleModel}
              options={singleCatalog}
              probePhase={singleProbe?.phase ?? 'idle'}
              disabled={!singleConnectionId}
              onOpen={() => singleConnectionId && onModelListOpen(singleConnectionId)}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
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
                <select aria-label={`${task.label} connection`} value={route?.connectionId ?? ''} onChange={(event) => setRoute(task.key, event.target.value)} className={`${providerFieldClass} cursor-pointer`}>
                  <option value="">Select a connection…</option>
                  {draft.connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Model ID</span>
                <ModelCombobox
                  ariaLabel={`${task.label} model ID`}
                  value={route?.modelId ?? ''}
                  onChange={(modelId) => setRouteModel(task.key, modelId)}
                  options={catalog}
                  probePhase={probe?.phase ?? 'idle'}
                  disabled={!route}
                  onOpen={() => connection && onModelListOpen(connection.id)}
                />
              </div>
              {task.key === 'extraction' && provider?.supportsNuextractRaw && route && (
                <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-muted">
                  <input type="checkbox" checked={'nuextractRaw' in route && route.nuextractRaw === true} onChange={(event) => setRawNuextract(event.target.checked)} />
                  Use raw NuExtract protocol
                </label>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
