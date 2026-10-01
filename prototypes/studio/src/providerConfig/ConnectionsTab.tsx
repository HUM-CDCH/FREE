import { type KeyboardEvent, type RefObject, useId, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { DeploymentModels, ModelConfig, ModelConnection, ProviderDescriptor, ProviderKind } from '../../shared/modelConfig.contract'
import { modelKeyFor } from '../modelKeys/modelKeyStore'
import { Button } from '../ui'
import { ProbeDot, ProbeStatusLine } from './ProbeStatus'
import { probeCatalog, probeText, type ProbeView } from './useProbeLifecycle'
import type { ProviderConfigDraft } from './useProviderConfigDraft'
import { SettingsViews } from './SettingsViews'

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
  const aside = useRef<HTMLElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const statusId = useId()
  const connections = [...deployment.connections, ...draft.connections]
  const pages = Array.from({ length: Math.ceil(connections.length / 4) }, (_, index) => connections.slice(index * 4, index * 4 + 4))
  const pageTitles = pages.map((_, index) => `Connections ${index * 4 + 1}–${Math.min(index * 4 + 4, connections.length)}`)
  const selectedPage = pages.findIndex((page) => page.some((connection) => connection.id === selected?.id))

  /** A new connection opens in the detail pane, and focus goes to it. */
  function add(kind: ProviderKind): void {
    flushSync(() => {
      const id = editor.addConnection(kind)
      if (id) onSelect(id)
    })
    detailHeading.current?.focus()
  }

  /** A deleted connection's pane is gone, so focus goes to the connection selected in its place, or to "Add". */
  function remove(id: string): void {
    flushSync(() => editor.removeConnection(id))
    const chooser = aside.current?.querySelector<HTMLSelectElement>('select')
    const next = aside.current?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? aside.current?.querySelector<HTMLButtonElement>('button')
    if (chooser && chooser.getClientRects().length > 0) chooser.focus()
    else next?.focus()
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside ref={aside} className="configuration-view flex min-w-0 items-start gap-2 border-line p-3 md:flex-col md:border-r">
        <select aria-label="Connection" value={selected?.id ?? ''} onChange={(event) => onSelect(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-[12px] text-ink md:hidden">
          {connections.length === 0 && <option value="">No connections</option>}
          {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name.trim() || 'Unnamed connection'}</option>)}
        </select>
        <div className="hidden w-full md:block">
        <SettingsViews label="Connections page" titles={pageTitles} selected={pageTitles[selectedPage]}>
        {pages.map((connections, index) => (
        <ul key={index} aria-label="Connections" className="flex flex-col gap-0.5">
          {connections.map((connection) => (
            <li key={connection.id}>
              <button
                type="button"
                aria-current={connection.id === selected?.id ? 'true' : undefined}
                // The dot's colour in words, for assistive technology and on hover.
                aria-describedby={`${statusId}-${connection.id}`}
                title={probeText(probes[connection.id])}
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
              <span id={`${statusId}-${connection.id}`} className="sr-only">{probeText(probes[connection.id])}</span>
            </li>
          ))}
        </ul>
        ))}
        </SettingsViews>
        </div>
        <AddConnectionMenu providers={providers.filter(({ transport }) => transport !== 'cli')} onAdd={add} />
      </aside>
      <section aria-label="Connection details" className="configuration-view min-w-0 p-3 sm:p-4">
        {!selected ? (
          <p className="text-[12px] text-ink-muted">No connections yet. Add one to choose a model from your own account or server.</p>
        ) : deployed(selected) ? (
          <DeploymentConnection connection={selected} probe={probes[selected.id]} headingRef={detailHeading} />
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
            headingRef={detailHeading}
            onDelete={() => remove(selected.id)}
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
function DeploymentConnection({
  connection,
  probe,
  headingRef,
}: {
  connection: ModelConnection
  probe: ProbeView | undefined
  headingRef: RefObject<HTMLHeadingElement | null>
}) {
  const models = probeCatalog(probe)
  return (
    <div className="flex flex-col gap-2">
      <h3 ref={headingRef} tabIndex={-1} className="text-[14px] font-bold text-ink">{connection.name}</h3>
      <p className="text-[12px] text-ink-muted">Run by this deployment. It cannot be edited here.</p>
      {connection.baseUrl === null ? (
        <p className="text-[11.5px] text-ink-faint">Runs on this server's CLI login</p>
      ) : (
        <p className="font-mono text-[11.5px] break-all text-ink-faint">{connection.baseUrl}</p>
      )}
      <ProbeStatusLine probe={probe} />
      {models.length > 0 && (
        <SettingsViews label="Connection models page" titles={Array.from({ length: Math.ceil(models.length / 4) }, (_, index) => `Models ${index * 4 + 1}–${Math.min(index * 4 + 4, models.length)}`)}>
          {Array.from({ length: Math.ceil(models.length / 4) }, (_, index) => (
            <ul key={index} aria-label="Models" className="mt-1 flex flex-col gap-0.5 font-mono text-[12px] break-all text-ink">
              {models.slice(index * 4, index * 4 + 4).map(({ id }) => <li key={id}>{id}</li>)}
            </ul>
          ))}
        </SettingsViews>
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
  headingRef,
  onDelete,
}: {
  accountId: string
  connection: ModelConnection
  provider: ProviderDescriptor | undefined
  probe: ProbeView | undefined
  editor: ProviderConfigDraft
  replacing: boolean
  onReplacing: (replacing: boolean) => void
  headingRef: RefObject<HTMLHeadingElement | null>
  onDelete: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 ref={headingRef} tabIndex={-1} className="text-[14px] font-bold text-ink">
        {provider?.label ?? connection.provider} connection
      </h3>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
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
        <Button variant="secondary" size="sm" className="text-danger" onClick={onDelete}>
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
  const input = useRef<HTMLInputElement>(null)
  const replaceButton = useRef<HTMLButtonElement>(null)
  const edit = editor.keyEdits[connection.id]
  const typed = typeof edit === 'string' ? edit : ''
  const issue = editor.keyIssues[connection.id]
  const keySaved = edit === undefined && connection.hasKey && modelKeyFor(accountId, connection) !== null
  const optional = provider?.authentication !== 'managed'
  /** Every key action swaps the pressed control for another; focus follows to the one that replaced it. */
  const then = (update: () => void, next: RefObject<HTMLElement | null>) => {
    flushSync(update)
    next.current?.focus()
  }

  if (keySaved && !replacing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-ink">Key saved in this browser</span>
        <div className="flex gap-2">
          <Button ref={replaceButton} variant="secondary" size="sm" onClick={() => then(() => onReplacing(true), input)}>
            Replace
          </Button>
          <Button variant="secondary" size="sm" onClick={() => then(() => editor.removeKey(connection.id), input)}>
            Remove
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-[11px] font-semibold text-ink-muted">{optional ? 'API key (optional)' : 'API key'}</label>
      <div className="flex items-center gap-2">
        <input
          ref={input}
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
            onClick={() =>
              then(() => {
                if (typed) editor.setKey(connection.id, '')
                onReplacing(false)
              }, replaceButton)
            }
          >
            Keep saved key
          </Button>
        )}
        {optional && connection.hasKey && !keySaved && typed === '' && (
          <Button variant="secondary" size="sm" onClick={() => then(() => editor.connectWithoutKey(connection.id), input)}>
            Use without a key
          </Button>
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
  useLayoutEffect(() => {
    const anchor = button.current
    const popup = menu.current
    if (!open || !anchor || !popup) return
    function position() {
      if (!anchor || !popup) return
      const bounds = anchor.getBoundingClientRect()
      const dialog = anchor.closest('dialog')?.getBoundingClientRect()
      const left = Math.max(8, dialog?.left ?? 8)
      const right = Math.min(window.innerWidth - 8, dialog?.right ?? window.innerWidth - 8)
      const width = Math.min(256, right - left)
      popup.style.width = `${width}px`
      popup.style.left = `${Math.max(left, Math.min(bounds.left, right - width))}px`
      const height = popup.getBoundingClientRect().height
      const below = bounds.bottom + 4
      popup.style.top = `${below + height <= window.innerHeight - 8 ? below : Math.max(8, bounds.top - height - 4)}px`
    }
    position()
    popup.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position)
    observer?.observe(anchor)
    observer?.observe(popup)
    const dialog = anchor.closest('dialog')
    if (dialog) observer?.observe(dialog)
    window.addEventListener('resize', position)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [open])
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
          className="fixed z-30 rounded-xl border border-line bg-surface py-1 shadow-float"
        >
          {providers.map((provider) => (
            <li key={provider.kind} role="none">
              <button
                type="button"
                role="menuitem"
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
