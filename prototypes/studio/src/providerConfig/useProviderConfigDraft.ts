import { useState } from 'react'
import type { ExtractionModelRole } from '../../shared/extraction.contract'
import type {
  IngestionModelRole,
  ModelConfig,
  ModelConnection,
  ProviderDescriptor,
  ProviderKind,
  Route,
  RouteKey,
} from '../../shared/modelConfig.contract'
import { modelKeyFor, removeModelKey, retainModelKeys, saveModelKey } from '../modelKeys/modelKeyStore'

/** A key typed in this draft, or `null`: this browser's key is removed on Apply. */
export type KeyEdit = string | null

type DraftInputs = {
  accountId: string
  providers: readonly ProviderDescriptor[]
  scheduleProbe: (connection: ModelConnection, credential: string | null | undefined) => void
  cancelProbe: (connectionId: string) => void
  disposeProbe: (connectionId: string) => void
}

export function useProviderConfigDraft({ accountId, providers, scheduleProbe, cancelProbe, disposeProbe }: DraftInputs) {
  const [saved, setSaved] = useState<ModelConfig | null>(null)
  const [draft, setDraft] = useState<ModelConfig | null>(null)
  const [keyEdits, setKeyEdits] = useState<Readonly<Record<string, KeyEdit>>>({})
  const descriptor = (connection: Pick<ModelConnection, 'provider'>) => providers.find(({ kind }) => kind === connection.provider)
  const withoutEdit = (id: string) => setKeyEdits((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)))
  const connectionOf = (id: string) => draft?.connections.find((connection) => connection.id === id)
  const replaceConnection = (next: ModelConnection) =>
    setDraft((current) => current && { ...current, connections: current.connections.map((item) => (item.id === next.id ? next : item)) })

  /** What a probe of `connection` may carry: nothing for a keyless connection; for one with a key, the key typed in
   *  this draft, else this browser's key for this account at this exact provider and base. `undefined`: not probed. */
  function credentialFor(connection: ModelConnection): string | null | undefined {
    if (!connection.hasKey) return null
    const edit = keyEdits[connection.id]
    if (typeof edit === 'string') return edit
    if (edit === null) return undefined
    return modelKeyFor(accountId, connection) ?? undefined
  }

  function initialize(config: ModelConfig): void {
    setSaved(config)
    setDraft(config)
    setKeyEdits({})
  }

  /** The single route setter: a route is {connectionId, modelId}, or null (the deployment default; for Schema
   *  Suggestion, the Assistant model). */
  function assign(task: RouteKey, target: Route | null): void {
    setDraft((current) => current && { ...current, routes: { ...current.routes, [task]: target } })
  }

  /** '' hands the role back to the deployment's default. */
  function setExtractionModel(role: ExtractionModelRole, key: string): void {
    setDraft((current) => {
      if (!current) return current
      const extractionModels = { ...current.extractionModels }
      if (key) extractionModels[role] = key
      else delete extractionModels[role]
      return { ...current, extractionModels }
    })
  }

  /** '' hands the role back to kei's default. Applies to new ingestions and reprocessing only. */
  function setIngestionModel(role: IngestionModelRole, key: string): void {
    setDraft((current) => {
      if (!current) return current
      const ingestionModels = { ...current.ingestionModels }
      if (key) ingestionModels[role] = key
      else delete ingestionModels[role]
      return { ...current, ingestionModels }
    })
  }

  function addConnection(kind: ProviderKind): string | null {
    const provider = providers.find((item) => item.kind === kind)
    if (!provider || provider.transport === 'cli') return null
    const connection: ModelConnection = {
      id: crypto.randomUUID(),
      name: provider.label,
      provider: kind,
      baseUrl: provider.defaultBaseUrl ?? '',
      hasKey: provider.authentication === 'managed',
    }
    setDraft((current) => current && { ...current, connections: [...current.connections, connection] })
    scheduleProbe(connection, connection.hasKey ? undefined : null)
    return connection.id
  }

  function updateConnection(id: string, change: Partial<Pick<ModelConnection, 'name' | 'baseUrl'>>): void {
    const connection = connectionOf(id)
    if (!connection) return
    const next = { ...connection, ...change }
    replaceConnection(next)
    if (change.baseUrl === undefined || change.baseUrl === connection.baseUrl) return
    // A key belongs to one API base. A new base drops the typed key at once and supersedes the probe the old input
    // scheduled; this browser's stored key stays bound to the old base and is never sent to the new one.
    cancelProbe(id)
    withoutEdit(id)
    scheduleProbe(next, next.hasKey ? modelKeyFor(accountId, next) ?? undefined : null)
  }

  function setKey(id: string, key: string): void {
    const connection = connectionOf(id)
    if (!connection) return
    const next = { ...connection, hasKey: true }
    replaceConnection(next)
    if (key) setKeyEdits((current) => ({ ...current, [id]: key }))
    else withoutEdit(id)
    scheduleProbe(next, key || (modelKeyFor(accountId, next) ?? undefined))
  }

  function removeKey(id: string): void {
    const connection = connectionOf(id)
    if (!connection) return
    const managed = descriptor(connection)?.authentication === 'managed'
    const next = { ...connection, hasKey: managed }
    replaceConnection(next)
    setKeyEdits((current) => ({ ...current, [id]: null }))
    cancelProbe(id)
    if (!managed) scheduleProbe(next, null)
  }

  /** An optional-key connection whose key is not in this browser can be used without one instead. */
  function connectWithoutKey(id: string): void {
    const connection = connectionOf(id)
    if (!connection || descriptor(connection)?.authentication !== 'optional') return
    const next = { ...connection, hasKey: false }
    replaceConnection(next)
    withoutEdit(id)
    scheduleProbe(next, null)
  }

  function removeConnection(id: string): void {
    setDraft((current) => current && {
      ...current,
      connections: current.connections.filter((item) => item.id !== id),
      routes: {
        schemaSuggestion: current.routes.schemaSuggestion?.connectionId === id ? null : current.routes.schemaSuggestion,
        interaction: current.routes.interaction?.connectionId === id ? null : current.routes.interaction,
      },
    })
    withoutEdit(id)
    disposeProbe(id)
  }

  /** After Apply: the committed configuration is the new baseline and this browser's keys follow it. Returns the IDs
   *  whose key this browser dropped, for the handoff to remove from Studio too. */
  function commit(config: ModelConfig): string[] {
    const dropped = new Set<string>()
    for (const [id, edit] of Object.entries(keyEdits)) {
      const connection = config.connections.find((item) => item.id === id)
      if (typeof edit === 'string' && connection?.hasKey) saveModelKey(accountId, connection, edit)
      if (edit === null) {
        removeModelKey(accountId, id)
        dropped.add(id)
      }
    }
    for (const id of retainModelKeys(accountId, config.connections)) dropped.add(id)
    initialize(config)
    return [...dropped]
  }

  function discard(): void {
    if (saved) initialize(saved)
  }

  const dirty = draft !== null && saved !== null &&
    (JSON.stringify(draft) !== JSON.stringify(saved) || Object.keys(keyEdits).length > 0)

  return {
    draft,
    saved,
    keyEdits,
    dirty,
    descriptor,
    credentialFor,
    initialize,
    assign,
    setExtractionModel,
    setIngestionModel,
    addConnection,
    updateConnection,
    setKey,
    removeKey,
    connectWithoutKey,
    removeConnection,
    commit,
    discard,
  }
}
