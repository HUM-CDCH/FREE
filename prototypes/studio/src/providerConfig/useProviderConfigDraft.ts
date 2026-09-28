import { useState } from 'react'
import {
  extractionSettingsIssues,
  extractionSettingsSchema,
  METHOD_MESSAGES,
  REFERENCE_ARTICLE,
  REFERENCE_CATALOG,
  settingsShapeIssues,
  type ArticleSettings,
  type MethodIssue,
} from 'extraction/extraction-method'
import type { ExtractionModelRole } from '../../shared/extraction.contract'
import {
  modelKeyIssue,
  type IngestionModelRole,
  type ModelConfig,
  type ModelConnection,
  type ProviderDescriptor,
  type ProviderKind,
  type Route,
  type RouteKey,
} from '../../shared/modelConfig.contract'
import { modelKeyFor, removeModelKey, retainModelKeys, saveModelKey } from '../modelKeys/modelKeyStore'
import {
  keepSavedOmissions,
  NUMBER_MESSAGES,
  orderedArticle,
  orderedCatalog,
  type AdvancedStrategy,
  type ArticleKey,
  type CatalogFactor,
  type NumberPath,
} from './advancedSettings'
import { probesDiffer } from './useProbeLifecycle'

/** A key typed in this draft, or `null`: this browser's key is removed on Apply. */
export type KeyEdit = string | null
export type ProviderConfigDraft = ReturnType<typeof useProviderConfigDraft>

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
  /** Number text that is not a whole number, by path: kept as typed, never clamped, and it blocks Apply. */
  const [numberEdits, setNumberEdits] = useState<Readonly<Partial<Record<NumberPath, string>>>>({})
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
    setNumberEdits({})
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
    if (!provider) return null
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
    if (change.baseUrl === undefined || change.baseUrl === connection.baseUrl) {
      // A rename is probed again only when it blanks the name or restores one: nothing else about the probe changed.
      if (probesDiffer(connection, next)) scheduleProbe(next, credentialFor(next))
      return
    }
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

  /** An absent member is service defaults. Members stay in the saved order (Article, then Catalog), so a strategy
   *  removed and customized again is not an unsaved change. */
  function setSettings(change: (settings: ModelConfig['extractionSettings']) => ModelConfig['extractionSettings']): void {
    setDraft((current) => {
      if (!current) return current
      const { article, catalog } = change(current.extractionSettings)
      return { ...current, extractionSettings: { ...(article ? { article } : {}), ...(catalog ? { catalog } : {}) } }
    })
  }

  /** Customize: that strategy's override starts from the documented reference settings. */
  function customize(strategy: AdvancedStrategy): void {
    setSettings((settings) => ({ ...settings, [strategy]: strategy === 'article' ? REFERENCE_ARTICLE : REFERENCE_CATALOG }))
  }

  /** Use service defaults: removes only that strategy's override; Models, Connections and the other strategy stay. */
  function useServiceDefaults(strategy: AdvancedStrategy): void {
    setSettings((settings) => ({ ...settings, [strategy]: undefined }))
    setNumberEdits((edits) => Object.fromEntries(Object.entries(edits).filter(([path]) => !path.startsWith(`${strategy}.`))))
  }

  /** `undefined` switches an optional factor off (omitted, never null). A parent change keeps its children as they are. */
  function setArticle<K extends ArticleKey>(key: K, value: ArticleSettings[K] | undefined): void {
    setSettings((settings) => settings.article ? { ...settings, article: orderedArticle({ ...settings.article, [key]: value }) } : settings)
  }

  /** A starting point, and its Undo: the whole Article override, or none, with the Article number text that goes with
   *  it (none by default; Undo passes the `numberEdits` it kept, and only their Article paths are restored). */
  function replaceArticle(article: ArticleSettings | undefined, articleEdits: Readonly<Partial<Record<NumberPath, string>>> = {}): void {
    setSettings((settings) => ({ ...settings, article: article && orderedArticle(article) }))
    const isArticle = ([path]: [string, unknown]) => path.startsWith('article.')
    setNumberEdits((edits) => ({
      ...Object.fromEntries(Object.entries(edits).filter((entry) => !isArticle(entry))),
      ...(article ? Object.fromEntries(Object.entries(articleEdits).filter(isArticle)) : {}),
    }))
  }

  /** Returns the refusal shown beside the input, or null once the trimmed, exact-case name is added. */
  function addIdentityField(text: string): string | null {
    const name = text.trim()
    const fields = draft?.extractionSettings.article?.identity_fields ?? []
    if (name === '' || fields.includes(name)) return METHOD_MESSAGES.identityNames
    setArticle('identity_fields', [...fields, name])
    return null
  }

  function removeIdentityField(name: string): void {
    setArticle('identity_fields', (draft?.extractionSettings.article?.identity_fields ?? []).filter((field) => field !== name))
  }

  /** Catalog edits keep what the saved override omits omitted once an edit returns to the value shown for it. */
  function setCatalog(change: (catalog: Record<string, Record<string, unknown> | undefined>) => Parameters<typeof orderedCatalog>[0]): void {
    setSettings((settings) => ({
      ...settings,
      catalog: keepSavedOmissions(orderedCatalog(change({ ...settings.catalog })), saved?.extractionSettings.catalog),
    }))
  }

  function setCatalogFactor(key: CatalogFactor, on: boolean): void {
    setCatalog((catalog) => {
      const recipe = catalog.recipe ?? {}
      const factors = { ...REFERENCE_CATALOG.recipe!.factors!, ...(recipe.factors as object | undefined), [key]: on }
      return { ...catalog, recipe: { ...recipe, factors } }
    })
  }

  /** Digits only: a whole number reaches the draft (its minimum is then the contract's to report); any other text
   *  stays in the input, marked invalid, and blocks Apply. Nothing is clamped or rounded. */
  function setNumber(path: NumberPath, text: string): void {
    if (!/^\d+$/.test(text)) {
      setNumberEdits((edits) => ({ ...edits, [path]: text }))
      return
    }
    setNumberEdits((edits) => {
      const rest = { ...edits }
      delete rest[path]
      return rest
    })
    const value = Number(text)
    const [scope, member, key] = path.split('.') as [AdvancedStrategy, string, string]
    if (scope === 'article') setArticle(member as ArticleKey, value as never)
    // Never parsed here: a value below its minimum must stay in the draft, visible and reported.
    else setCatalog((catalog) => ({ ...catalog, [member]: { ...catalog[member], [key]: value } }))
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
    (JSON.stringify(draft) !== JSON.stringify(saved) || Object.keys(keyEdits).length > 0 || Object.keys(numberEdits).length > 0)

  /** Every Advanced issue the page shows and Apply waits for: shape (minimums, names), cross-field rules, and number
   *  text that is not a whole number. Paths are relative to `extractionSettings`. A draft is never parsed into the
   *  draft itself: parsing would fill defaults and could not hold a below-minimum value. */
  const settingsIssues: readonly MethodIssue[] = (() => {
    if (!draft) return []
    const parsed = extractionSettingsSchema.safeParse(draft.extractionSettings)
    const found = parsed.success ? extractionSettingsIssues(parsed.data) : settingsShapeIssues(parsed.error)
    const typed = (Object.keys(numberEdits) as NumberPath[]).map((path) => ({ path, message: NUMBER_MESSAGES[path] }))
    return [...typed, ...found.filter((issue) => !typed.some((edit) => edit.path === issue.path))]
  })()

  /** Typed keys Studio would refuse, by connection ID: this browser would not save them, so Apply waits. */
  const keyIssues: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(keyEdits).flatMap(([id, edit]) => {
      const issue = typeof edit === 'string' && edit !== '' ? modelKeyIssue(edit) : null
      return issue === null ? [] : [[id, issue]]
    }),
  )

  return {
    draft,
    saved,
    keyEdits,
    keyIssues,
    numberEdits,
    settingsIssues,
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
    customize,
    useServiceDefaults,
    setArticle,
    replaceArticle,
    addIdentityField,
    removeIdentityField,
    setCatalogFactor,
    setNumber,
    commit,
    discard,
  }
}
