import { type KeyboardEvent, useId, useRef, useState } from 'react'
import type { DeploymentModels, ModelConfig, ModelConnection, ProviderDescriptor, ProviderKind } from '../../shared/modelConfig.contract'
import { modelKeyFor } from '../modelKeys/modelKeyStore'
import { Button } from '../ui'
import { ProbeDot, ProbeStatusLine } from './ProbeStatus'
import { probeCatalog, type ProbeView } from './useProbeLifecycle'
import type { ProviderConfigDraft } from './useProviderConfigDraft'

const FIELD_CLASS =
  'w-full rounded-lg border border-line-strong bg-canvas px-2.75 py-2 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent aria-invalid:border-danger'

type Props = {
  accountId: string
  draft: ModelConfig
  deployment: DeploymentModels
  providers: readonly ProviderDescriptor[]
  probes: Readonly<Record<string, ProbeView>>
  editor: ProviderConfigDraft
  /** Connections whose saved key is being replaced: the key input shows instead of the saved-key line. */
  replacing: ReadonlySet<string>
  onReplacing: (id: string, replacing: boolean) => void
  selected: ModelConnection | null
  onSelect: (id: string) => void
}

/** Every connection a route may name, the deployment's first, and the selected one's details. */
export function ConnectionsTab({ accountId, draft, deployment, providers, probes, editor, replacing, onReplacing, selected, onSelect }: Props) {
  const deployed = (connection: ModelConnection) => deployment.connections.some(({ id }) => id === connection.id)
  return (
    <div className="grid min-h-96 grid-cols-1 md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-2 border-line p-3 md:border-r">
        <ul aria-label="Connections" className="flex flex-col gap-0.5">
          {[...deployment.connections, ...draft.connections].map((connection) => (
            <li key={connection.id}>
              <button
                type="button"
                aria-current={connection.id === selected?.id ? 'true' : undefined}
                onClick={() => onSelect(connection.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors ${
                  connection.id === selected?.id ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-muted hover:bg-surface/70'
                }`}
              >
                <ProbeDot probe={probes[connection.id]} />
                <span title={connection.name} className="min-w-0 flex-1 truncate">{connection.name.trim() || 'Unnamed connection'}</span>
                {deployed(connection) && (
                  <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-ink-faint">
                    <LockIcon />
                    Deployment
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <AddConnectionMenu
          providers={providers.filter(({ transport }) => transport !== 'cli')}
          onAdd={(kind) => {
            const id = editor.addConnection(kind)
            if (id) onSelect(id)
          }}
        />
      </aside>
      <section aria-label="Connection details" className="min-w-0 p-5">
        {!selected ? (
          <p className="text-[12px] text-ink-muted">No connections yet. Add one to choose a model from your own account or server.</p>
        ) : deployed(selected) ? (
          <DeploymentConnection connection={selected} probe={probes[selected.id]} />
        ) : (
          <ConnectionForm
            key={selected.id}
            accountId={accountId}
            connection={selected}
            provider={editor.descriptor(selected)}
            probe={probes[selected.id]}
            editor={editor}
            replacing={replacing.has(selected.id)}
            onReplacing={(on) => onReplacing(selected.id, on)}
          />
        )}
      </section>
    </div>
  )
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2.25" y="5.25" width="7.5" height="5.25" rx="1" />
      <path d="M4 5.25V3.75a2 2 0 0 1 4 0v1.5" />
    </svg>
  )
}

/** A connection the deployment runs: described by its environment, so it is shown and never edited here. */
function DeploymentConnection({ connection, probe }: { connection: ModelConnection; probe: ProbeView | undefined }) {
  const models = probeCatalog(probe)
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[14px] font-bold text-ink">{connection.name}</h3>
      <p className="text-[12px] text-ink-muted">Run by this deployment. It cannot be edited here.</p>
      {connection.baseUrl === null ? (
        <p className="text-[11.5px] text-ink-faint">Runs on this server's CLI login</p>
      ) : (
        <p className="font-mono text-[11.5px] break-all text-ink-faint">{connection.baseUrl}</p>
      )}
      <ProbeStatusLine probe={probe} />
      {models.length > 0 && (
        <ul aria-label="Models" className="mt-1 flex flex-col gap-0.5 font-mono text-[12px] text-ink">
          {models.map(({ id }) => <li key={id}>{id}</li>)}
        </ul>
      )}
    </div>
  )
}

/** One of the researcher's connections. Its provider is fixed once added: another provider is another connection. */
function ConnectionForm({
  accountId,
  connection,
  provider,
  probe,
  editor,
  replacing,
  onReplacing,
}: {
  accountId: string
  connection: ModelConnection
  provider: ProviderDescriptor | undefined
  probe: ProbeView | undefined
  editor: ProviderConfigDraft
  replacing: boolean
  onReplacing: (replacing: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[14px] font-bold text-ink">{provider?.label ?? connection.provider} connection</h3>
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink-muted">Name</span>
          <input
            value={connection.name}
            onChange={(event) => editor.updateConnection(connection.id, { name: event.target.value })}
            className={FIELD_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink-muted">Base URL</span>
          <input
            value={connection.baseUrl ?? ''}
            onChange={(event) => editor.updateConnection(connection.id, { baseUrl: event.target.value })}
            spellCheck={false}
            className={`font-mono ${FIELD_CLASS}`}
          />
        </label>
      </div>
      <KeyLine accountId={accountId} connection={connection} provider={provider} editor={editor} replacing={replacing} onReplacing={onReplacing} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ProbeStatusLine probe={probe} />
        <Button variant="secondary" size="sm" className="text-danger" onClick={() => editor.removeConnection(connection.id)}>
          Delete connection
        </Button>
      </div>
    </div>
  )
}

/**
 * The key is one line: saved in this browser (Replace, Remove), or an input. The input is masked text, not a
 * password field, so the browser's password manager keeps no other copy of the key.
 */
function KeyLine({
  accountId,
  connection,
  provider,
  editor,
  replacing,
  onReplacing,
}: {
  accountId: string
  connection: ModelConnection
  provider: ProviderDescriptor | undefined
  editor: ProviderConfigDraft
  replacing: boolean
  onReplacing: (replacing: boolean) => void
}) {
  const inputId = useId()
  const issueId = useId()
  const edit = editor.keyEdits[connection.id]
  const typed = typeof edit === 'string' ? edit : ''
  const issue = editor.keyIssues[connection.id]
  const keySaved = edit === undefined && connection.hasKey && modelKeyFor(accountId, connection) !== null
  const optional = provider?.authentication !== 'managed'

  if (keySaved && !replacing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-ink">Key saved in this browser</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => onReplacing(true)}>Replace</Button>
          <Button variant="secondary" size="sm" onClick={() => editor.removeKey(connection.id)}>Remove</Button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-[11px] font-semibold text-ink-muted">{optional ? 'API key (optional)' : 'API key'}</label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          aria-invalid={issue ? true : undefined}
          aria-describedby={issue ? issueId : undefined}
          value={typed}
          onChange={(event) => editor.setKey(connection.id, event.target.value)}
          placeholder={connection.hasKey ? 'Paste a key' : 'Used without a key'}
          className={`font-mono [-webkit-text-security:disc] ${FIELD_CLASS}`}
        />
        {keySaved && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (typed) editor.setKey(connection.id, '')
              onReplacing(false)
            }}
          >
            Keep saved key
          </Button>
        )}
        {optional && connection.hasKey && !keySaved && typed === '' && (
          <Button variant="secondary" size="sm" onClick={() => editor.connectWithoutKey(connection.id)}>Use without a key</Button>
        )}
      </div>
      {issue && <p id={issueId} className="text-[11.5px] text-danger">{issue}</p>}
    </div>
  )
}

/** "Add connection": the kinds a researcher may add. CLI kinds run on the server's own login, so only the operator
 *  enables them, as deployment connections. */
function AddConnectionMenu({ providers, onAdd }: { providers: readonly ProviderDescriptor[]; onAdd: (kind: ProviderKind) => void }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLUListElement>(null)
  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) button.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!open) return
    if (event.key === 'Escape') {
      // Handled here, so an enclosing dialog does not also take it as its own dismissal.
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const at = items.findIndex((item) => item === document.activeElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    items[(at + step + items.length) % items.length]?.focus()
  }

  return (
    <div
      className="relative"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false)
      }}
    >
      <Button
        ref={button}
        variant="secondary"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(event) => open && event.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">+</span>
        Add connection
      </Button>
      {open && (
        // A press keeps focus in the menu: a browser that does not focus a clicked button would otherwise blur it
        // and close the menu before the click lands.
        <ul
          ref={menu}
          role="menu"
          aria-label="Add connection"
          onMouseDown={(event) => event.preventDefault()}
          className="absolute left-0 z-30 mt-1 w-72 rounded-xl border border-line bg-surface py-1 shadow-float"
        >
          {providers.map((provider, index) => (
            <li key={provider.kind} role="none">
              <button
                type="button"
                role="menuitem"
                autoFocus={index === 0}
                onClick={() => {
                  onAdd(provider.kind)
                  close(false)
                }}
                className="flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left hover:bg-surface-muted focus-visible:bg-surface-muted"
              >
                <b className="text-[12.5px] font-semibold text-ink">{provider.label}</b>
                <span className="text-[10.5px] text-ink-faint">{provider.authentication === 'managed' ? 'Hosted API · needs a key' : 'Your own server'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
