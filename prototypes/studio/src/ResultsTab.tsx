import { useEffect, useMemo, useState } from 'react'
import { requestMarkdown } from './api'
import ResultValue from './ResultValue'
import type { ResultPath } from './ResultValue'
import { isRecord } from './template'
import { resultStats } from './resultStats'
import type { ExtractionController } from './useExtraction'

type ResultsTabProps = {
  controller: ExtractionController
  schemaReady: boolean
  pdfSource: { url: string; filename: string } | null
  documentMarkdown: string | null
  onValueClick?: (value: string) => void
}

type View = 'review' | 'json' | 'markdown'

type MarkdownState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ready'; markdown: string }
  | { status: 'error'; message: string }

const preClasses =
  'scrollbar-subtle m-0 min-h-0 flex-1 overflow-auto whitespace-pre bg-canvas px-4 py-3.5 font-mono text-[11px] leading-relaxed text-ink'

function summaryItem(label: string, value: string | number) {
  return (
    <span className="rounded-full border border-line bg-surface-muted px-2 py-1 text-xs font-semibold text-ink-muted">
      {label}: <span className="font-mono text-ink">{value}</span>
    </span>
  )
}

function setAtPath(obj: unknown, path: ResultPath, value: string): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path
  if (Array.isArray(obj)) {
    const idx = parseInt(head, 10)
    if (isNaN(idx)) return obj
    const arr = [...obj]
    arr[idx] = setAtPath(arr[idx], rest, value)
    return arr
  }
  if (isRecord(obj)) {
    return { ...obj, [head]: setAtPath((obj as Record<string, unknown>)[head], rest, value) }
  }
  return value
}

function getAtPath(obj: unknown, path: string[]): unknown {
  return path.reduce(
    (cur, key) =>
      Array.isArray(cur) ? cur[parseInt(key, 10)] :
      isRecord(cur) ? (cur as Record<string, unknown>)[key] :
      undefined,
    obj,
  )
}

function ResultsTab({ controller, schemaReady, pdfSource, documentMarkdown, onValueClick }: ResultsTabProps) {
  const { state } = controller
  const [view, setView] = useState<View>('review')
  const [markdown, setMarkdown] = useState<MarkdownState>({ status: 'idle' })
  const [editedResult, setEditedResult] = useState<Record<string, unknown> | null>(
    state.status === 'ready' ? state.result as Record<string, unknown> : null,
  )
  const stats = useMemo(() => (state.status === 'ready' ? resultStats(state.result) : null), [state])

  const [navPath, setNavPath] = useState<string[]>([])
  const [backStack, setBackStack] = useState<string[][]>([])
  const [forwardStack, setForwardStack] = useState<string[][]>([])

  useEffect(() => {
    if (state.status === 'ready') {
      setEditedResult(state.result as Record<string, unknown>)
    } else {
      setEditedResult(null)
    }
    setNavPath([])
    setBackStack([])
    setForwardStack([])
  }, [state])

  function handleResultChange(path: ResultPath, value: string) {
    setEditedResult(prev => prev ? setAtPath(prev, path, value) as Record<string, unknown> : prev)
  }

  const displayResult = editedResult ?? (state.status === 'ready' ? state.result as Record<string, unknown> : null)

  function navTo(newPath: string[]) {
    setBackStack(prev => [...prev, navPath])
    setForwardStack([])
    setNavPath(newPath)
  }

  function goBack() {
    if (backStack.length === 0) return
    const prev = backStack[backStack.length - 1]
    setForwardStack(f => [...f, navPath])
    setNavPath(prev)
    setBackStack(b => b.slice(0, -1))
  }

  function goForward() {
    if (forwardStack.length === 0) return
    const next = forwardStack[forwardStack.length - 1]
    setBackStack(b => [...b, navPath])
    setNavPath(next)
    setForwardStack(f => f.slice(0, -1))
  }

  const currentEntries = useMemo((): Array<{ pathKey: string; displayName: string; value: unknown }> => {
    const node = navPath.length === 0 ? displayResult : (displayResult ? getAtPath(displayResult, navPath) : null)
    if (Array.isArray(node)) return node.map((v, i) => ({ pathKey: String(i), displayName: `Item ${i + 1}`, value: v }))
    if (isRecord(node)) return Object.entries(node as Record<string, unknown>).map(([k, v]) => ({ pathKey: k, displayName: k, value: v }))
    return []
  }, [displayResult, navPath])

  async function copyJson() {
    if (displayResult) {
      await navigator.clipboard.writeText(JSON.stringify(displayResult, null, 2))
    }
  }

  function downloadJson() {
    if (!displayResult) return
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(displayResult, null, 2)], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'free-extraction-result.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function generateMarkdown() {
    if (!pdfSource || markdown.status === 'running') {
      return
    }
    setMarkdown({ status: 'running' })
    try {
      const blob = await (await fetch(pdfSource.url)).blob()
      const done = await requestMarkdown(blob, pdfSource.filename, undefined, documentMarkdown)
      setMarkdown({ status: 'ready', markdown: done.markdown })
    } catch (error) {
      setMarkdown({
        status: 'error',
        message: error instanceof Error ? error.message : 'Markdown generation failed.',
      })
    }
  }

  const tabClasses = (active: boolean) =>
    `cursor-pointer px-2.5 py-1 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
      active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'
    }`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-9.5 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-muted">
          Extraction results
        </h2>
      </header>

      {state.status === 'ready' && stats && (
        <>
          <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
            <div className="flex flex-wrap gap-1.5">
              {summaryItem('Status', 'ready')}
              {summaryItem('Fields', stats.fields)}
              {summaryItem('Missing', stats.missing)}
              {stats.arrayItems > 0 && summaryItem('Array items', stats.arrayItems)}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex overflow-hidden rounded-md border border-line">
                <button className={tabClasses(view === 'review')} type="button" onClick={() => setView('review')}>
                  Review
                </button>
                <button className={tabClasses(view === 'json')} type="button" onClick={() => setView('json')}>
                  Raw JSON
                </button>
                <button
                  className={tabClasses(view === 'markdown')}
                  type="button"
                  onClick={() => setView('markdown')}
                >
                  Markdown
                </button>
              </div>
              <div className="flex gap-1.5">
                {/* <button className="cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-muted hover:border-accent/50 hover:text-accent" type="button" onClick={() => void controller.runExtraction()}>
                  Rerun
                </button> */}
                <button className="cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-ink-muted hover:border-accent/50 hover:text-accent" type="button" onClick={() => void copyJson()}>
                  Copy JSON
                </button>
                <button className="cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-ink-muted hover:border-accent/50 hover:text-accent" type="button" onClick={downloadJson}>
                  Download
                </button>
              </div>
            </div>
          </div>

          {view === 'review' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Breadcrumb bar — always visible */}
              <div className="flex shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2 py-1">
                <button
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[13px] font-bold leading-none text-ink-muted hover:bg-accent-ghost/40 hover:text-ink disabled:cursor-default disabled:opacity-30"
                  type="button"
                  title="Back"
                  disabled={backStack.length === 0}
                  onClick={goBack}
                >‹</button>
                <button
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[13px] font-bold leading-none text-ink-muted hover:bg-accent-ghost/40 hover:text-ink disabled:cursor-default disabled:opacity-30"
                  type="button"
                  title="Forward"
                  disabled={forwardStack.length === 0}
                  onClick={goForward}
                >›</button>
                <span className="mx-1 h-3.5 w-px shrink-0 bg-line" />
                {navPath.map((seg, i) => {
                  const idx = parseInt(seg, 10)
                  const label = !isNaN(idx) && String(idx) === seg ? `Item ${idx + 1}` : seg
                  return (
                    <span key={i} className="flex items-center gap-0.5">
                      {i > 0 && <span className="text-[11px] text-ink-faint">›</span>}
                      {i < navPath.length - 1 ? (
                        <button
                          className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[12px] font-semibold text-ink-muted hover:text-accent"
                          type="button"
                          onClick={() => navTo(navPath.slice(0, i + 1))}
                        >{label}</button>
                      ) : (
                        <span className="px-1.5 py-0.5 text-[12px] font-semibold text-ink">{label}</span>
                      )}
                    </span>
                  )
                })}
              </div>
              {/* Content */}
              <div className="scrollbar-subtle min-h-0 flex-1 overflow-auto bg-canvas px-3 py-2">
                {currentEntries.map(({ pathKey, displayName, value: val }) => (
                  <ResultValue
                    key={pathKey}
                    name={displayName}
                    value={val}
                    path={[...navPath, pathKey]}
                    onChange={handleResultChange}
                    onValueClick={onValueClick}
                    onNavigateTo={isRecord(val) || Array.isArray(val) ? navTo : undefined}
                    defaultExpanded={navPath.length === 0}
                    expandText={navPath.length > 0}
                  />
                ))}
              </div>
            </div>
          )}

          {view === 'json' && <pre className={preClasses}>{JSON.stringify(displayResult, null, 2)}</pre>}

          {view === 'markdown' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {markdown.status === 'ready' ? (
                <pre className={preClasses}>{markdown.markdown}</pre>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
                  {markdown.status === 'error' && (
                    <p className="mb-3 wrap-anywhere text-[12px] leading-snug text-danger">{markdown.message}</p>
                  )}
                  <button
                    className="cursor-pointer rounded-lg border border-accent bg-accent px-4 py-2 text-[12.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-60"
                    type="button"
                    disabled={!pdfSource || markdown.status === 'running'}
                    onClick={() => void generateMarkdown()}
                  >
                    {markdown.status === 'running' ? 'Generating...' : 'Generate markdown'}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {state.status === 'running' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <span
            aria-hidden="true"
            className="animate-spin-slow size-7 rounded-full border-[3px] border-line border-t-accent"
          />
          <p className="text-[13px] font-semibold text-ink">Extracting...</p>
          <p className="max-w-[34ch] text-[13px] leading-snug text-ink-muted">
            This can take a while on large source documents.
          </p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="m-3.25 rounded-xl border border-danger/40 bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-danger">Extraction failed</p>
          <p className="mt-1 wrap-anywhere text-[13px] leading-snug text-ink-muted">{state.message}</p>
          <button
            className="mt-2.5 cursor-pointer rounded-lg border border-accent bg-accent px-3.25 py-1.5 text-xs font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40"
            type="button"
            onClick={() => void controller.runExtraction()}
          >
            Retry extraction
          </button>
        </div>
      )}

      {state.status === 'idle' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-[13.5px] font-semibold text-ink">No results yet</p>
          <p className="mt-1.5 max-w-[34ch] text-[13px] leading-snug text-ink-muted">
            {schemaReady
              ? 'Run extraction to apply the schema across the source document.'
              : 'Generate a schema in the Schema tab first, then run extraction.'}
          </p>
          <button
            className="mt-4 cursor-pointer rounded-lg border border-accent bg-accent px-4 py-2 text-[12.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:border-line disabled:bg-line disabled:text-ink-muted"
            type="button"
            disabled={!controller.canRun}
            onClick={() => void controller.runExtraction()}
          >
            {schemaReady ? 'Run extraction' : 'Generate a schema first'}
          </button>
        </div>
      )}
    </div>
  )
}

export default ResultsTab
