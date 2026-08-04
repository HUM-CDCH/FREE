import { useState } from 'react'
import type { CredentialActions, ModelConfig, ModelConnection, ProviderDescriptor, ProviderKind, RouteKey } from '../../shared/modelConfig.contract'

export type ConfigurationMode = 'single' | 'routes'
type ProbeSchedule = (connection: ModelConnection, action: string | null | undefined) => void

type DraftInputs = {
  providers: readonly ProviderDescriptor[]
  scheduleProbe: ProbeSchedule
  disposeProbe: (connectionId: string) => void
}

export function configurationMode(config: ModelConfig): ConfigurationMode {
  const { extraction, interaction } = config.routes
  if (extraction === null && interaction === null) return 'single'
  if (extraction === null || interaction === null) return 'routes'
  return extraction.connectionId === interaction.connectionId &&
    extraction.modelId === interaction.modelId &&
    !('nuextractRaw' in extraction && extraction.nuextractRaw)
    ? 'single'
    : 'routes'
}

export function useProviderConfigDraft({ providers, scheduleProbe, disposeProbe }: DraftInputs) {
  const [draft, setDraft] = useState<ModelConfig | null>(null)
  const [mode, setMode] = useState<ConfigurationMode>('single')
  const [credentialActions, setCredentialActions] = useState<CredentialActions>({})

  const descriptor = (connection: ModelConnection) =>
    providers.find(({ kind }) => kind === connection.provider)
  const actionFor = (connectionId: string): string | null | undefined =>
    Object.hasOwn(credentialActions, connectionId) ? credentialActions[connectionId] : undefined

  function initialize(config: ModelConfig): void {
    setDraft(config)
    setMode(configurationMode(config))
  }

  function replaceAfterApply(config: ModelConfig): void {
    setDraft(config)
    setCredentialActions({})
  }

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
    if (probeInput) scheduleProbe(next, actionFor(next.id))
  }

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
    const action = provider.authentication === 'external' ? undefined : actionFor(connection.id)
    if (provider.authentication === 'external' && Object.hasOwn(credentialActions, connection.id)) {
      const actions = { ...credentialActions }
      delete actions[connection.id]
      setCredentialActions(actions)
    }
    scheduleProbe(next, action)
  }

  function updateCredential(connection: ModelConnection, action: string | null | undefined): void {
    const next = { ...credentialActions }
    if (action === undefined) delete next[connection.id]
    else next[connection.id] = action
    setCredentialActions(next)
    scheduleProbe(connection, action)
  }

  function addConnection(kind: ProviderKind): void {
    if (!draft) return
    const provider = providers.find(({ kind: candidate }) => candidate === kind)
    if (!provider) return
    const connection: ModelConnection = {
      id: crypto.randomUUID(),
      name: provider.label,
      provider: provider.kind,
      baseUrl: provider.transport === 'http' ? (provider.defaultBaseUrl ?? '') : null,
    }
    setDraft({ ...draft, connections: [...draft.connections, connection] })
    scheduleProbe(connection, actionFor(connection.id))
  }

  function removeConnection(connectionId: string): void {
    if (!draft) return
    const routes = { ...draft.routes }
    if (routes.extraction?.connectionId === connectionId) routes.extraction = null
    if (routes.interaction?.connectionId === connectionId) routes.interaction = null
    setDraft({ connections: draft.connections.filter(({ id }) => id !== connectionId), routes })
    const actions = { ...credentialActions }
    delete actions[connectionId]
    setCredentialActions(actions)
    disposeProbe(connectionId)
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
    setDraft({ ...draft, routes: { ...draft.routes, [key]: { ...draft.routes[key], modelId } } })
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

  function setRawNuextract(enabled: boolean): void {
    if (!draft?.routes.extraction) return
    const extraction = draft.routes.extraction
    setDraft({
      ...draft,
      routes: {
        ...draft.routes,
        extraction: enabled
          ? { ...extraction, nuextractRaw: true }
          : { connectionId: extraction.connectionId, modelId: extraction.modelId },
      },
    })
  }

  return {
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
  }
}
