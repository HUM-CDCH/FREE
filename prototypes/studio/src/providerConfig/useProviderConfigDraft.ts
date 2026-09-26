import { useState } from 'react'
import type { ExtractionModelRole } from '../../shared/extraction.contract'
import type { CredentialActions, ModelConfig, ModelConnection, ProviderDescriptor, ProviderKind, RouteKey } from '../../shared/modelConfig.contract'

export type ConfigurationMode = 'single' | 'routes'
type ProbeSchedule = (connection: ModelConnection, action: string | null | undefined) => void

type DraftInputs = {
  providers: readonly ProviderDescriptor[]
  scheduleProbe: ProbeSchedule
  disposeProbe: (connectionId: string) => void
}

export function configurationMode(config: ModelConfig): ConfigurationMode {
  const { schemaSuggestion, interaction } = config.routes
  if (schemaSuggestion === null && interaction === null) return 'single'
  if (schemaSuggestion === null || interaction === null) return 'routes'
  return schemaSuggestion.connectionId === interaction.connectionId &&
    schemaSuggestion.modelId === interaction.modelId
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
    setDraft({
      ...draft,
      connections: draft.connections.map((item) => (item.id === connection.id ? next : item)),
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
    if (routes.schemaSuggestion?.connectionId === connectionId) routes.schemaSuggestion = null
    if (routes.interaction?.connectionId === connectionId) routes.interaction = null
    setDraft({ ...draft, connections: draft.connections.filter(({ id }) => id !== connectionId), routes })
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
    setDraft({
      ...draft,
      routes: { ...draft.routes, [key]: { connectionId, modelId: draft.routes[key]?.modelId ?? '' } },
    })
  }

  function setRouteModel(key: RouteKey, modelId: string): void {
    if (!draft?.routes[key]) return
    setDraft({ ...draft, routes: { ...draft.routes, [key]: { ...draft.routes[key], modelId } } })
  }

  function setSingleConnection(connectionId: string): void {
    if (!draft) return
    if (!connectionId) {
      setDraft({ ...draft, routes: { schemaSuggestion: null, interaction: null } })
      return
    }
    const modelId = draft.routes.schemaSuggestion?.modelId ?? draft.routes.interaction?.modelId ?? ''
    const route = { connectionId, modelId }
    setDraft({ ...draft, routes: { schemaSuggestion: route, interaction: route } })
  }

  function setSingleModel(modelId: string): void {
    if (!draft) return
    const current = draft.routes.schemaSuggestion ?? draft.routes.interaction
    if (!current) return
    const route = { connectionId: current.connectionId, modelId }
    setDraft({ ...draft, routes: { schemaSuggestion: route, interaction: route } })
  }

  /** '' leaves the role to kei-exp's deployment default. */
  function setExtractionModel(role: ExtractionModelRole, key: string): void {
    if (!draft) return
    const extractionModels = { ...draft.extractionModels }
    if (key) extractionModels[role] = key
    else delete extractionModels[role]
    setDraft({ ...draft, extractionModels })
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
    setExtractionModel,
  }
}
