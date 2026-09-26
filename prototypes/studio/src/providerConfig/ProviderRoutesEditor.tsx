import {
  usesNuextractProtocol,
  type ModelConfig,
  type ModelConnection,
  type ProviderDescriptor,
  type Route,
  type RouteKey,
} from '../../shared/modelConfig.contract'
import { Overline } from '../ui'
import { ModelCombobox } from './ModelCombobox'
import { providerFieldClass } from './ProviderConnectionCard'
import { ROUTABLE_TASKS } from './providerConfig.data'
import type { ProbeView } from './useProbeLifecycle'

type Props = {
  draft: ModelConfig
  /** Every connection a route may name: the deployment's own, then the saved ones. */
  connections: readonly ModelConnection[]
  /** What an unset route runs on, when the deployment serves an instruction model. */
  defaultModelId: string | null
  probes: Readonly<Record<string, ProbeView>>
  descriptor: (connection: Pick<ModelConnection, 'provider'>) => ProviderDescriptor | undefined
  onModelListOpen: (connectionId: string) => void
  assign: (task: RouteKey, target: Route | null) => void
}

export function ProviderRoutesEditor({
  draft,
  connections,
  defaultModelId,
  probes,
  descriptor,
  onModelListOpen,
  assign,
}: Props) {
  const unsetLabel = defaultModelId ? `Deployment default (${defaultModelId})` : 'Select a connection…'

  return (
    <div>
      <Overline as="p" className="mb-3">Capability Routes</Overline>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {ROUTABLE_TASKS.map((task) => {
          const route = draft.routes[task.key]
          const connection = connections.find(({ id }) => id === route?.connectionId)
          const provider = connection ? descriptor(connection) : undefined
          const probe = connection ? probes[connection.id] : undefined
          const catalog = probe?.phase === 'done' ? probe.result.catalog : []
          return (
            <div key={task.key} className="rounded-xl border border-line bg-canvas p-3.5">
              <b className="text-[12.5px] text-ink">{task.label}</b>
              <p className="mb-2.5 text-[10.5px] text-ink-faint">{task.description}</p>
              <label className="mb-2 flex flex-col gap-1">
                <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Connection</span>
                <select
                  aria-label={`${task.label} connection`}
                  value={route?.connectionId ?? ''}
                  onChange={(event) => {
                    const value = event.target.value
                    assign(task.key, value ? { connectionId: value, modelId: route?.modelId ?? '' } : null)
                  }}
                  className={`${providerFieldClass} cursor-pointer`}
                >
                  <option value="">{unsetLabel}</option>
                  {connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] font-semibold uppercase text-ink-muted">Model ID</span>
                <ModelCombobox
                  ariaLabel={`${task.label} model ID`}
                  value={route?.modelId ?? ''}
                  onChange={(modelId) => route && assign(task.key, { connectionId: route.connectionId, modelId })}
                  options={catalog}
                  probePhase={probe?.phase ?? 'idle'}
                  disabled={!route}
                  onOpen={() => connection && onModelListOpen(connection.id)}
                />
              </div>
              {task.key === 'schemaSuggestion' && provider && route && usesNuextractProtocol(provider, route.modelId) && (
                <p className="mt-2 text-[11px] text-ink-muted">Uses the NuExtract protocol for this model.</p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
