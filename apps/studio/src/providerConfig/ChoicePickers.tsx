import type { ModelConnection, Route } from '../../shared/modelConfig.contract'
import { ModelPicker, type PickerGroup } from './ModelPicker'
import { ProbeDot } from './ProbeStatus'
import { probeCatalog, probeText, probeTone, type ProbeView } from './useProbeLifecycle'

const NOT_OFFERED = '(not offered by this deployment)'

/** A route target, connection and model, as one picker value. JSON, so no separator can occur inside an ID. */
const encodeRoute = (connectionId: string, modelId: string) => JSON.stringify([connectionId, modelId])
function decodeRoute(value: string): Route | null {
  if (!value) return null
  const [connectionId, modelId] = JSON.parse(value) as [string, string]
  return { connectionId, modelId }
}

function probeNote(probe: ProbeView | undefined): string | undefined {
  if (probe?.phase === 'checking') return 'Listing models…'
  return probeTone(probe) === 'failed' ? probeText(probe) : undefined
}

/** A Capability Route, connection and model in one pick, over every connection a route may name. */
export function RoutePicker({
  ariaLabel,
  route,
  unset,
  routable,
  probes,
  onChange,
}: {
  ariaLabel: string
  route: Route | null
  /** What the route runs on while it is unset. */
  unset: string
  routable: readonly ModelConnection[]
  probes: Readonly<Record<string, ProbeView>>
  onChange: (route: Route | null) => void
}) {
  const groups: PickerGroup[] = routable.map((connection) => {
    const probe = probes[connection.id]
    const catalog = probeCatalog(probe).map(({ id }) => id)
    const models = route?.connectionId === connection.id && !catalog.includes(route.modelId) ? [route.modelId, ...catalog] : catalog
    return {
      key: connection.id,
      label: connection.name,
      status: <ProbeDot probe={probe} />,
      note: probeNote(probe),
      options: models.map((modelId) => ({ value: encodeRoute(connection.id, modelId), label: modelId })),
      freeText: (typed) => encodeRoute(connection.id, typed),
    }
  })
  const connection = routable.find(({ id }) => id === route?.connectionId)
  return (
    <ModelPicker
      ariaLabel={ariaLabel}
      value={route ? encodeRoute(route.connectionId, route.modelId) : ''}
      groups={groups}
      reset={{ value: '', label: unset }}
      onChange={(value) => onChange(decodeRoute(value))}
      display={
        route ? (
          <>
            <span className="font-mono">{route.modelId}</span>
            <span className="text-ink-faint"> · {connection?.name ?? 'Unknown connection'}</span>
          </>
        ) : (
          <span className="text-ink-muted">{unset}</span>
        )
      }
    />
  )
}

/**
 * One role of a choice among the models this deployment runs (the Ingestion or Extraction Model Choice). A model the
 * deployment cannot run now is shown and cannot be picked; a saved key it no longer offers stays selected.
 */
export function ListingPicker({
  ariaLabel,
  group,
  value,
  defaultKey,
  choices,
  unserved,
  onChange,
}: {
  ariaLabel: string
  group: string
  /** '' keeps the deployment's default. */
  value: string
  defaultKey: string | undefined
  /** `null` when the deployment could not list its models: only its default and a saved key remain. */
  choices: readonly { key: string; name: string; serving: boolean }[] | null
  unserved: string
  onChange: (key: string) => void
}) {
  const nameOf = (key: string) => choices?.find((choice) => choice.key === key)?.name ?? key
  const fallback = defaultKey ? `Deployment default · ${nameOf(defaultKey)}` : 'Deployment default'
  const unlisted = value !== '' && !choices?.some((choice) => choice.key === value)
  const options = (choices ?? []).map(({ key, name, serving }) => ({
    value: key,
    label: name,
    hint: serving ? undefined : unserved,
    disabled: !serving,
  }))
  if (unlisted) options.push({ value, label: value, hint: choices ? NOT_OFFERED : undefined, disabled: false })
  return (
    <ModelPicker
      ariaLabel={ariaLabel}
      value={value}
      groups={[{ key: 'deployment', label: group, note: choices ? undefined : 'This deployment could not list its models.', options }]}
      reset={{ value: '', label: fallback }}
      onChange={onChange}
      display={
        value ? (
          <>
            <span className="font-mono">{nameOf(value)}</span>
            {unlisted && choices && <span className="text-ink-faint"> {NOT_OFFERED}</span>}
          </>
        ) : (
          <span className="text-ink-muted">{fallback}</span>
        )
      }
    />
  )
}
