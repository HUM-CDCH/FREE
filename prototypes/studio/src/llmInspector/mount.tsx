/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { LlmTrace } from '../../shared/llmInspector.contract'

function elapsed(trace: LlmTrace): string {
  const end = trace.completedAt ? Date.parse(trace.completedAt) : Date.now()
  return `${Math.max(0, end - Date.parse(trace.startedAt))} ms`
}

function Payload({ label, direction, value }: { label: string; direction: string; value: string | null }) {
  return (
    <section className="flex min-h-64 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#393c3a] bg-[#151716]">
      <div className="flex items-center justify-between border-b border-[#393c3a] bg-[#1d201e] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-[#d9ff65]" aria-hidden="true">{direction}</span>
          <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-[#c7cbc5]">{label}</h3>
        </div>
        {value !== null && <button type="button" className="rounded border border-[#454944] px-2 py-1 font-mono text-[10px] uppercase text-[#9da49b] hover:border-[#d9ff65] hover:text-[#d9ff65]" onClick={() => void navigator.clipboard.writeText(value)}>Copy</button>}
      </div>
      <pre className="scrollbar-subtle min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-[1.65] text-[#d7dbd3]">{value ?? 'Waiting for provider…'}</pre>
    </section>
  )
}

function Inspector({ onClose }: { onClose: () => void }) {
  const [traces, setTraces] = useState<LlmTrace[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const response = await fetch('/api/llm_inspector', { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('Inspector unavailable')
        const body = await response.json() as { traces: LlmTrace[] }
        setTraces(body.traces)
        setSelectedId((current) => body.traces.some(({ id }) => id === current) ? current : body.traces[0]?.id ?? null)
        setError(null)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Inspector unavailable')
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 750)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [])

  const selected = useMemo(() => traces.find(({ id }) => id === selectedId) ?? null, [selectedId, traces])

  async function clear() {
    const response = await fetch('/api/llm_inspector', { method: 'DELETE' })
    if (!response.ok) return setError('Could not clear the inspector')
    setTraces([])
    setSelectedId(null)
  }

  return (
    <div className="mx-auto flex h-[min(860px,calc(100vh-3rem))] w-[min(1440px,calc(100vw-3rem))] flex-col overflow-hidden rounded-xl border border-[#474b46] bg-[#111312] shadow-2xl">
      <header className="flex shrink-0 items-center gap-4 border-b border-[#393c3a] bg-[#191c1a] px-4 py-3 text-[#e5e8e1]">
        <div className="flex size-9 items-center justify-center rounded-md border border-[#4d524b] bg-[#111312] font-mono text-lg text-[#d9ff65]">λ</div>
        <div>
          <h2 className="font-mono text-sm font-semibold tracking-[0.08em]">LLM WIRE INSPECTOR</h2>
          <p className="mt-0.5 text-[11px] text-[#8f968d]">Process-local · last 50 calls · credentials excluded</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-2 rounded-full border border-[#3d4633] bg-[#1d2419] px-2.5 py-1 font-mono text-[10px] uppercase text-[#a9c964]"><span className="size-1.5 animate-pulse rounded-full bg-[#d9ff65]" /> Live</span>
          <button type="button" onClick={() => void clear()} className="rounded border border-[#454944] px-3 py-1.5 font-mono text-[10px] uppercase text-[#aeb3ab] hover:border-[#bd6950] hover:text-[#e38b70]">Clear</button>
          <button type="button" onClick={onClose} aria-label="Close LLM inspector" className="flex size-8 items-center justify-center rounded border border-[#454944] text-lg text-[#aeb3ab] hover:border-[#d9ff65] hover:text-[#d9ff65]">×</button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="LLM calls" className="scrollbar-subtle max-h-48 w-full shrink-0 overflow-auto border-b border-[#393c3a] bg-[#171918] md:max-h-none md:w-72 md:border-b-0 md:border-r">
          {traces.length === 0 && <div className="px-5 py-10 text-center font-mono text-[11px] leading-relaxed text-[#777e76]">No provider calls yet.<br />Run an Extraction, Schema Suggestion, or chat.</div>}
          {traces.map((trace) => (
            <button key={trace.id} type="button" onClick={() => setSelectedId(trace.id)} className={`block w-full border-b border-[#2d302e] px-3 py-3 text-left transition-colors ${selectedId === trace.id ? 'bg-[#282d25]' : 'hover:bg-[#202320]'}`}>
              <div className="flex items-center gap-2">
                <span className={`size-1.5 shrink-0 rounded-full ${trace.status === 'running' ? 'animate-pulse bg-[#d9ff65]' : trace.status === 'complete' ? 'bg-[#77bd8a]' : trace.status === 'cancelled' ? 'bg-[#d2a55f]' : 'bg-[#e2705c]'}`} />
                <span className="truncate font-mono text-[11px] font-semibold uppercase text-[#d9ddd6]">{trace.operation}</span>
                <time className="ml-auto font-mono text-[9px] text-[#707770]">{new Date(trace.startedAt).toLocaleTimeString([], { hour12: false })}</time>
              </div>
              <p className="mt-1.5 truncate font-mono text-[10px] text-[#969d94]">{trace.provider} / {trace.model}</p>
              <p className="mt-1 font-mono text-[9px] uppercase text-[#697069]">{trace.profile} · {elapsed(trace)}</p>
            </button>
          ))}
        </nav>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#101211] p-3">
          {error && <p className="mb-3 rounded border border-[#703c32] bg-[#2a1916] px-3 py-2 font-mono text-[11px] text-[#e38b70]">{error}</p>}
          {selected ? <div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row"><Payload label="To provider" direction="→" value={selected.request} /><Payload label="From provider" direction="←" value={selected.response} /></div> : <div className="flex flex-1 items-center justify-center font-mono text-xs text-[#737a72]">Select a call to inspect its complete payload.</div>}
        </main>
      </div>
    </div>
  )
}

function Launcher() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Inspect LLM messages" title="Inspect LLM messages" className="fixed bottom-4 right-4 z-40 flex size-10 items-center justify-center rounded-full border border-[#4d524b] bg-[#111312] font-mono text-lg text-[#d9ff65] shadow-lg hover:border-[#d9ff65]">λ</button>
      {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-label="LLM message inspector" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}><Inspector onClose={() => setOpen(false)} /></div>}
    </>
  )
}

export function mountLlmInspector(): () => void {
  const host = document.createElement('div')
  host.id = 'llm-inspector'
  document.body.append(host)
  const root = createRoot(host)
  root.render(<StrictMode><Launcher /></StrictMode>)
  return () => {
    root.unmount()
    host.remove()
  }
}
