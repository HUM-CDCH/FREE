import { useState, type ReactNode } from 'react'
import { Button, EmptyState, Overline, Pill } from '../ui'
import type { PillProps } from '../ui'
import {
  API_PROVIDERS,
  CONNECTION_KINDS,
  INITIAL_CONNECTIONS,
  INITIAL_ROUTES,
  ROUTABLE_TASKS,
} from './providerConfig.data'
import type {
  ApiProviderKey,
  Connection,
  ConnectionKind,
  Draft,
  RouteState,
  TaskConfig,
  TaskId,
} from './providerConfig.data'

type StatusKind = 'ok' | 'warn' | 'err'
type StatusInfo = { kind: StatusKind; text: string; deleted?: boolean }
type RouteEntry = { task: TaskConfig; route: RouteState; status: StatusInfo }

const STATUS_TONE: Record<StatusKind, { pill: PillProps['tone']; dot: string; text: string; border: string }> = {
  ok: { pill: 'success', dot: 'bg-green', text: 'text-green', border: 'border-line' },
  warn: { pill: 'stale', dot: 'bg-stale', text: 'text-stale-ink', border: 'border-stale' },
  err: { pill: 'danger', dot: 'bg-danger', text: 'text-danger', border: 'border-danger/40' },
}

const inputClass =
  'w-full rounded-lg border border-line-strong bg-canvas px-2.75 py-2 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent'
const selectClass = `${inputClass} cursor-pointer`

// --- Pure derivation helpers, indexed through the data registries above (no per-kind branching in JSX) ---

function modelsFor(connection: Connection) {
  if (connection.kind === 'api' && connection.apiProvider) {
    return API_PROVIDERS[connection.apiProvider].models
  }
  return CONNECTION_KINDS[connection.kind].models ?? []
}

function kindNameFor(connection: Connection) {
  if (connection.kind === 'api' && connection.apiProvider) {
    return API_PROVIDERS[connection.apiProvider].name
  }
  return CONNECTION_KINDS[connection.kind].name
}

function connectionStatus(connection: Connection): StatusInfo {
  const config = CONNECTION_KINDS[connection.kind]
  if (config.shape === 'cli') {
    return connection.reachable ? { kind: 'ok', text: 'Detected' } : { kind: 'err', text: 'Not found' }
  }
  if (config.shape === 'server') {
    if (!connection.baseUrl) return { kind: 'err', text: 'No URL' }
    if (!connection.reachable) return { kind: 'err', text: 'Unreachable' }
    return { kind: 'ok', text: 'Connected' }
  }
  return connection.apiKey ? { kind: 'ok', text: 'Connected' } : { kind: 'warn', text: 'Key required' }
}

function routeStatus(route: RouteState, connections: Connection[]): StatusInfo {
  const connection = route.connectionId ? (connections.find((c) => c.id === route.connectionId) ?? null) : null
  if (!connection) {
    return { kind: 'err', text: 'Connection removed — pick another', deleted: true }
  }
  const status = connectionStatus(connection)
  const modelOk = modelsFor(connection).some((model) => model.id === route.model)
  if (status.kind === 'ok' && !modelOk) {
    return { kind: 'warn', text: 'Model unavailable' }
  }
  return { kind: status.kind, text: status.kind === 'ok' ? 'Ready' : status.text }
}

function defaultDraftFor(kind: ConnectionKind): Draft {
  const config = CONNECTION_KINDS[kind]
  if (kind === 'api') {
    const provider = API_PROVIDERS.openai
    return { kind, apiProvider: 'openai', name: provider.name, baseUrl: provider.defaultUrl, apiKey: '' }
  }
  return { kind, name: config.name, baseUrl: config.defaultUrl ?? '', apiKey: '' }
}

// --- Presentational pieces ---

function StatusDot({ kind }: { kind: StatusKind }) {
  return <span aria-hidden="true" className={`size-1.25 shrink-0 rounded-full ${STATUS_TONE[kind].dot}`} />
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-ink-muted">{label}</span>
      {children}
    </label>
  )
}

function ProviderConfigHeader({ status, text }: { status: StatusKind; text: string }) {
  const tone = STATUS_TONE[status]
  return (
    <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.75">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-extrabold tracking-[0.08em] text-accent">FREE</span>
        <span className="text-[11px] font-medium text-ink-faint">/ Providers</span>
      </div>
      <Pill tone={tone.pill} outline className="gap-1.5">
        <StatusDot kind={status} />
        {text}
      </Pill>
    </header>
  )
}

function ConnectionCard({ connection, onDelete }: { connection: Connection; onDelete: (id: string) => void }) {
  const status = connectionStatus(connection)
  const tone = STATUS_TONE[status.kind]
  const config = CONNECTION_KINDS[connection.kind]

  return (
    <div className={`rounded-xl border bg-surface p-3 ${tone.border}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">{connection.name}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Pill tone={tone.pill} className="gap-1">
            <StatusDot kind={status.kind} />
            {status.text}
          </Pill>
          <button
            type="button"
            title="Delete connection"
            onClick={() => onDelete(connection.id)}
            className="grid size-5.5 shrink-0 cursor-pointer place-items-center rounded-md border border-line text-sm leading-none text-ink-faint outline-none transition-colors hover:border-danger/40 hover:text-danger"
          >
            ×
          </button>
        </div>
      </div>
      <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">
        {config.shape === 'cli' ? 'Local agent harness' : connection.baseUrl || '—'}
      </p>
      <p className="mt-0.5 text-[10.5px] text-ink-faint">
        {kindNameFor(connection)} · {modelsFor(connection).length} models
      </p>
    </div>
  )
}

function ConnectionTypePicker({
  onPick,
  onCancel,
}: {
  onPick: (kind: ConnectionKind) => void
  onCancel: () => void
}) {
  return (
    <div>
      <div className="mb-2.75 flex items-center justify-between">
        <span className="text-xs text-ink-muted">Choose a connection type</span>
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer text-[11px] font-semibold text-ink-muted outline-none hover:text-ink"
        >
          Cancel
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(Object.entries(CONNECTION_KINDS) as [ConnectionKind, (typeof CONNECTION_KINDS)[ConnectionKind]][]).map(
          ([kind, config]) => (
            <button
              key={kind}
              type="button"
              onClick={() => onPick(kind)}
              className="flex flex-col items-start gap-0.5 rounded-lg border border-line-strong bg-surface p-2.75 text-left outline-none transition-colors hover:border-accent/50 focus-visible:border-accent"
            >
              <span className="text-xs font-semibold text-ink">{config.name}</span>
              <span className="text-[10px] text-ink-faint">{config.tagline}</span>
            </button>
          ),
        )}
      </div>
    </div>
  )
}

function ConnectionForm({
  draft,
  showAdvanced,
  onApiProviderChange,
  onNameChange,
  onBaseUrlChange,
  onApiKeyChange,
  onToggleAdvanced,
  onSave,
  onCancel,
}: {
  draft: Draft
  showAdvanced: boolean
  onApiProviderChange: (key: ApiProviderKey) => void
  onNameChange: (value: string) => void
  onBaseUrlChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onToggleAdvanced: () => void
  onSave: () => void
  onCancel: () => void
}) {
  const config = CONNECTION_KINDS[draft.kind]
  const isApi = draft.kind === 'api'
  const isServer = config.shape === 'server'
  const showUrl = isServer || (isApi && showAdvanced)
  const showKey = isApi || (isServer && config.keyOptional)
  const canSave =
    config.shape === 'cli' ? true : isServer ? !!draft.baseUrl : !!draft.apiProvider && !!draft.apiKey
  const note =
    config.shape === 'cli'
      ? `Uses your local ${config.name} sign-in — no URL or key needed.`
      : isServer
        ? 'Point at localhost or a remote machine. Any OpenAI-compatible server works.'
        : 'The base URL is set from the provider — open Advanced to change it for a proxy or gateway.'
  const connectionName = isApi && draft.apiProvider ? API_PROVIDERS[draft.apiProvider].name : config.name

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] font-semibold text-ink">New {connectionName} connection</p>

      {isApi && (
        <FormField label="Provider">
          <select
            value={draft.apiProvider}
            onChange={(event) => onApiProviderChange(event.target.value as ApiProviderKey)}
            className={selectClass}
          >
            {(Object.entries(API_PROVIDERS) as [ApiProviderKey, (typeof API_PROVIDERS)[ApiProviderKey]][]).map(
              ([key, provider]) => (
                <option key={key} value={key}>
                  {provider.name}
                </option>
              ),
            )}
          </select>
        </FormField>
      )}

      <FormField label="Display name">
        <input
          value={draft.name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="e.g. Lab GPU box"
          className={inputClass}
        />
      </FormField>

      {showKey && (
        <FormField label={isApi ? 'API key' : 'API key (only if your server requires one)'}>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder="sk-…"
            className={`font-mono ${inputClass}`}
          />
        </FormField>
      )}

      {showUrl && (
        <FormField label={config.endpointLabel ?? 'Endpoint'}>
          <input
            value={draft.baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="http://localhost:11434"
            className={`font-mono ${inputClass}`}
          />
        </FormField>
      )}

      {isApi && (
        <button
          type="button"
          onClick={onToggleAdvanced}
          className="self-start cursor-pointer font-mono text-[10.5px] font-semibold text-accent outline-none"
        >
          {showAdvanced ? 'Hide advanced' : 'Advanced · custom base URL'}
        </button>
      )}

      <p className="text-[11px] leading-relaxed text-ink-faint">{note}</p>

      <div className="mt-0.5 flex gap-2">
        <Button variant="primary" size="md" disabled={!canSave} onClick={onSave}>
          Save connection
        </Button>
        <Button variant="secondary" size="md" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

type ConnectionsPanelProps = {
  connections: Connection[]
  creating: boolean
  pickedKind: ConnectionKind | null
  draft: Draft | null
  showAdvanced: boolean
  onStartCreate: () => void
  onCancelCreate: () => void
  onPickKind: (kind: ConnectionKind) => void
  onApiProviderChange: (key: ApiProviderKey) => void
  onNameChange: (value: string) => void
  onBaseUrlChange: (value: string) => void
  onApiKeyChange: (value: string) => void
  onToggleAdvanced: () => void
  onSave: () => void
  onDelete: (id: string) => void
}

function ConnectionsPanel({
  connections,
  creating,
  pickedKind,
  draft,
  showAdvanced,
  onStartCreate,
  onCancelCreate,
  onPickKind,
  onApiProviderChange,
  onNameChange,
  onBaseUrlChange,
  onApiKeyChange,
  onToggleAdvanced,
  onSave,
  onDelete,
}: ConnectionsPanelProps) {
  return (
    <div className="min-h-90 border-r border-line p-4.5">
      <div className="mb-3.25 flex items-center justify-between">
        <Overline>Your connections</Overline>
        {!creating && (
          <Button variant="primary" size="sm" onClick={onStartCreate}>
            + New connection
          </Button>
        )}
      </div>

      {!creating && (
        <div className="flex flex-col gap-2.25">
          {connections.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} onDelete={onDelete} />
          ))}
          {connections.length === 0 && (
            <EmptyState title="No connections yet." description="Add one to route your tasks." />
          )}
        </div>
      )}

      {creating && !pickedKind && <ConnectionTypePicker onPick={onPickKind} onCancel={onCancelCreate} />}

      {creating && pickedKind && draft && (
        <ConnectionForm
          draft={draft}
          showAdvanced={showAdvanced}
          onApiProviderChange={onApiProviderChange}
          onNameChange={onNameChange}
          onBaseUrlChange={onBaseUrlChange}
          onApiKeyChange={onApiKeyChange}
          onToggleAdvanced={onToggleAdvanced}
          onSave={onSave}
          onCancel={onCancelCreate}
        />
      )}
    </div>
  )
}

function RouteCard({
  entry,
  connections,
  onConnectionChange,
  onModelChange,
}: {
  entry: RouteEntry
  connections: Connection[]
  onConnectionChange: (taskId: TaskId, connectionId: string) => void
  onModelChange: (taskId: TaskId, model: string) => void
}) {
  const { task, route, status } = entry
  const connection = connections.find((c) => c.id === route.connectionId) ?? null
  const models = connection ? modelsFor(connection) : []
  const tone = STATUS_TONE[status.kind]

  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <p className="text-[12.5px] font-semibold text-ink">{task.label}</p>
      <p className="mb-2.75 text-[10.5px] text-ink-faint">{task.sub}</p>
      <div className="flex flex-col gap-2">
        <select
          value={route.connectionId ?? ''}
          onChange={(event) => onConnectionChange(task.id, event.target.value)}
          className={selectClass}
        >
          <option value="">Select a connection…</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {kindNameFor(c)}
            </option>
          ))}
        </select>
        {!status.deleted && (
          <select
            value={route.model ?? ''}
            onChange={(event) => onModelChange(task.id, event.target.value)}
            className={`font-mono ${selectClass}`}
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="mt-2.25 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em]">
        <StatusDot kind={status.kind} />
        <span className={tone.text}>{status.text}</span>
      </div>
    </div>
  )
}

function TaskRoutingPanel({
  routeEntries,
  connections,
  mixText,
  onConnectionChange,
  onModelChange,
}: {
  routeEntries: RouteEntry[]
  connections: Connection[]
  mixText: string
  onConnectionChange: (taskId: TaskId, connectionId: string) => void
  onModelChange: (taskId: TaskId, model: string) => void
}) {
  return (
    <div className="p-4.5">
      <Overline as="p" className="mb-3.25">
        Task routing
      </Overline>
      <div className="flex flex-col gap-3.25">
        {routeEntries.map((entry) => (
          <RouteCard
            key={entry.task.id}
            entry={entry}
            connections={connections}
            onConnectionChange={onConnectionChange}
            onModelChange={onModelChange}
          />
        ))}
        <p className="px-0.5 text-[11px] font-medium text-ink-muted">{mixText}</p>
      </div>
    </div>
  )
}

// --- Container: owns all state, has no props ---

function ProviderConfigPage() {
  const [connections, setConnections] = useState<Connection[]>(INITIAL_CONNECTIONS)
  const [routes, setRoutes] = useState<Record<TaskId, RouteState>>(INITIAL_ROUTES)
  const [creating, setCreating] = useState(false)
  const [pickedKind, setPickedKind] = useState<ConnectionKind | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [nextId, setNextId] = useState(3)

  function startCreate() {
    setCreating(true)
    setPickedKind(null)
    setDraft(null)
    setShowAdvanced(false)
  }

  function cancelCreate() {
    setCreating(false)
    setPickedKind(null)
    setDraft(null)
  }

  function pickKind(kind: ConnectionKind) {
    setPickedKind(kind)
    setShowAdvanced(false)
    setDraft(defaultDraftFor(kind))
  }

  function changeApiProvider(key: ApiProviderKey) {
    const provider = API_PROVIDERS[key]
    setDraft((current) =>
      current ? { ...current, apiProvider: key, name: provider.name, baseUrl: provider.defaultUrl } : current,
    )
  }

  function changeDraftName(name: string) {
    setDraft((current) => (current ? { ...current, name } : current))
  }

  function changeDraftBaseUrl(baseUrl: string) {
    setDraft((current) => (current ? { ...current, baseUrl } : current))
  }

  function changeDraftApiKey(apiKey: string) {
    setDraft((current) => (current ? { ...current, apiKey } : current))
  }

  function saveConnection() {
    if (!draft) return
    const id = `c${nextId}`
    const connection: Connection = {
      id,
      kind: draft.kind,
      apiProvider: draft.apiProvider,
      name: draft.name || CONNECTION_KINDS[draft.kind].name,
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
      reachable: true,
    }
    setConnections((current) => [...current, connection])
    setNextId((current) => current + 1)
    cancelCreate()
  }

  function deleteConnection(id: string) {
    setConnections((current) => current.filter((connection) => connection.id !== id))
    setRoutes((current) => {
      const next = { ...current }
      for (const task of ROUTABLE_TASKS) {
        if (next[task.id].connectionId === id) {
          next[task.id] = { connectionId: null, model: null }
        }
      }
      return next
    })
  }

  function changeRouteConnection(taskId: TaskId, connectionId: string) {
    const connection = connections.find((c) => c.id === connectionId) ?? null
    const model = connection ? (modelsFor(connection)[0]?.id ?? null) : null
    setRoutes((current) => ({ ...current, [taskId]: { connectionId, model } }))
  }

  function changeRouteModel(taskId: TaskId, model: string) {
    setRoutes((current) => ({ ...current, [taskId]: { ...current[taskId], model } }))
  }

  const routeEntries: RouteEntry[] = ROUTABLE_TASKS.map((task) => ({
    task,
    route: routes[task.id],
    status: routeStatus(routes[task.id], connections),
  }))
  const allValid = routeEntries.every((entry) => entry.status.kind === 'ok')
  const anyError = routeEntries.some((entry) => entry.status.kind === 'err')
  const connectedIds = new Set(
    routeEntries.map((entry) => entry.route.connectionId).filter((id): id is string => Boolean(id)),
  )
  const singleConnection = connectedIds.size === 1
  const overallStatus: StatusKind = allValid ? 'ok' : anyError ? 'err' : 'warn'
  const chipText = allValid ? (singleConnection ? 'Single provider · ready' : 'Mixed · ready') : 'Needs attention'
  const mixText = singleConnection
    ? 'All tasks use the same connection.'
    : 'Mixed setup — each task uses a different connection.'

  return (
    <div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-line bg-surface-muted shadow-page">
      <ProviderConfigHeader status={overallStatus} text={chipText} />
      <div className="grid grid-cols-[1.08fr_1fr]">
        <ConnectionsPanel
          connections={connections}
          creating={creating}
          pickedKind={pickedKind}
          draft={draft}
          showAdvanced={showAdvanced}
          onStartCreate={startCreate}
          onCancelCreate={cancelCreate}
          onPickKind={pickKind}
          onApiProviderChange={changeApiProvider}
          onNameChange={changeDraftName}
          onBaseUrlChange={changeDraftBaseUrl}
          onApiKeyChange={changeDraftApiKey}
          onToggleAdvanced={() => setShowAdvanced((current) => !current)}
          onSave={saveConnection}
          onDelete={deleteConnection}
        />
        <TaskRoutingPanel
          routeEntries={routeEntries}
          connections={connections}
          mixText={mixText}
          onConnectionChange={changeRouteConnection}
          onModelChange={changeRouteModel}
        />
      </div>
    </div>
  )
}

export default ProviderConfigPage
