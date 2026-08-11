import { useEffect, useMemo, useState } from 'react'
import ResultValue from './ui/ResultValue'
import { Overline, SegmentedControl, Spinner, Button } from './ui'
import { isRecord } from '../shared/template'
import { resultStats } from './resultStats'
import type { ExtractionController } from './useExtraction'

type ResultsTabProps = {
  controller: ExtractionController
  schemaReady: boolean
  documentMarkdown: string | null
  onSelectEvidence?: (anchorId: string) => void
  onResultPathChange?: (path: string[] | null) => void
}

type View = 'review' | 'json' | 'markdown'

const preClasses =
  'scrollbar-subtle m-0 min-h-0 flex-1 overflow-auto whitespace-pre bg-canvas px-4 py-3.5 font-mono text-[11px] leading-relaxed text-ink'

function summaryItem(label: string, value: string | number) {
  return (
    <span className="rounded-full border border-line bg-surface-muted px-2 py-1 text-[11px] font-semibold text-ink-muted">
      {label}: <span className="font-mono text-ink">{value}</span>
    </span>
  )
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

function ResultsTab({ controller, schemaReady, documentMarkdown, onSelectEvidence, onResultPathChange }: ResultsTabProps) {
  const { state } = controller
  const [view, setView] = useState<View>('review')
  const stats = useMemo(() => (state.status === 'ready' ? resultStats(state.result) : null), [state])

  const [navPath, setNavPath] = useState<string[]>([])
  const [backStack, setBackStack] = useState<string[][]>([])
  const [forwardStack, setForwardStack] = useState<string[][]>([])
  const [previousState, setPreviousState] = useState(state)

  useEffect(
    () => onResultPathChange?.(view === 'review' ? navPath : null),
    [navPath, onResultPathChange, view],
  )


  if (previousState !== state) {
    setPreviousState(state)
    setNavPath([])
    setBackStack([])
    setForwardStack([])
  }

  const displayResult = state.status === 'ready' ? state.result : null
  const evidenceAnchorIdByPath = useMemo(
    () =>
      new Map(
        state.status === 'ready'
          ? state.evidenceLinks.map((link) => [
              JSON.stringify(link.resultPath.map(String)),
              link.evidenceAnchorId,
            ])
          : [],
      ),
    [state],
  )

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-9.5 shrink-0 items-center gap-2 border-b border-line px-4">
        <Overline as="h2">Extraction results</Overline>
      </header>

      {state.status === 'ready' && stats && (
        <>
          <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
            <div className="flex flex-wrap gap-1.5">
              {summaryItem(
                'Status',
                controller.attempt?.complete === false ? 'incomplete' : 'ready',
              )}
              {controller.attempt &&
                summaryItem('Strategy', controller.attempt.strategy.toLowerCase())}
              {summaryItem('Fields', stats.fields)}
              {summaryItem('Missing', stats.missing)}
              {summaryItem('Grounded', state.evidenceLinks.length)}
              {stats.arrayItems > 0 && summaryItem('Array items', stats.arrayItems)}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <SegmentedControl
                aria-label="Result view"
                value={view}
                onChange={setView}
                options={[
                  { value: 'review', label: 'Review' },
                  { value: 'json', label: 'Raw JSON' },
                  { value: 'markdown', label: 'Markdown' },
                ]}
              />
              <div className="flex gap-1.5">
                {controller.review.available && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!controller.review.canAccept}
                    title={
                      controller.review.reviewedExtractionId
                        ? 'This result is already saved with its Review Decisions'
                        : 'Save this result and its reviewed Evidence to the Source Representation'
                    }
                    onClick={() => void controller.review.accept()}
                  >
                    {controller.review.reviewedExtractionId
                      ? 'Review saved'
                      : controller.review.saving
                        ? 'Saving…'
                        : 'Accept result'}
                  </Button>
                )}
                <Button variant="secondary" size="sm" onClick={() => void controller.runExtraction()}>
                  Rerun
                </Button>
              </div>
            </div>
            {controller.attempt?.complete === false && (
              <div
                className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11.5px] leading-snug text-amber-900"
                role="status"
              >
                <p className="font-semibold">Incomplete Extraction</p>
                <p>
                  Successful records remain visible.{' '}
                  {controller.attempt.diagnostics.catalog?.codes.join(', ') ||
                    'See the persisted stage diagnostics for details.'}
                </p>
              </div>
            )}
            {controller.review.error && (
              <p role="alert" className="mt-2 text-[11.5px] leading-snug text-danger">
                {controller.review.error}
              </p>
            )}
            {state.ungroundedCount > 0 && (
              <p className="mt-2 text-[11.5px] leading-snug text-ink-muted">
                {state.ungroundedCount} value{state.ungroundedCount === 1 ? '' : 's'} could not be grounded and will not create Evidence highlights.
              </p>
            )}
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
                    onNavigateTo={isRecord(val) || Array.isArray(val) ? navTo : undefined}
                    defaultExpanded={navPath.length === 0}
                    expandText={navPath.length > 0}
                    getEvidenceAnchorId={(path) =>
                      evidenceAnchorIdByPath.get(JSON.stringify(path))
                    }
                    onSelectEvidence={onSelectEvidence}
                  />
                ))}
              </div>
            </div>
          )}

          {view === 'json' && <pre className={preClasses}>{JSON.stringify(displayResult, null, 2)}</pre>}

          {view === 'markdown' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {documentMarkdown ? (
                <pre className={preClasses}>{documentMarkdown}</pre>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
                  <p className="text-[13px] font-semibold text-ink">Markdown unavailable</p>
                  <p className="mt-1.5 max-w-[34ch] text-[11.5px] leading-snug text-ink-muted">
                    Parsed Markdown has not been received for this source document.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {state.status === 'running' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
          <Spinner
            label={`Running ${controller.strategy === 'CATALOG' ? 'Catalog' : 'Article'} extraction…`}
            hint="The server is extracting values, grounding Evidence, and saving the terminal attempt."
          />
        </div>
      )}

      {state.status === 'error' && (
        <div className="m-3.25 rounded-xl border border-danger/40 bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-danger">Extraction failed</p>
          <p className="mt-1 wrap-anywhere text-[12px] leading-snug text-ink-muted">{state.message}</p>
          <Button variant="primary" size="md" className="mt-2.5" onClick={() => void controller.runExtraction()}>
            Retry extraction
          </Button>
        </div>
      )}

      {state.status === 'idle' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-[13.5px] font-semibold text-ink">No results yet</p>
          <p className="mt-1.5 max-w-[34ch] text-[11.5px] leading-snug text-ink-muted">
            {schemaReady
              ? 'Run extraction to apply the schema across the source document.'
              : 'Generate a schema in the Schema tab first, then run extraction.'}
          </p>
          <Button
            variant="primary"
            size="md"
            className="mt-4"
            disabled={!controller.canRun}
            onClick={() => void controller.runExtraction()}
          >
            {schemaReady ? 'Run extraction' : 'Generate a schema first'}
          </Button>
        </div>
      )}

      {state.status === 'cancelled' && (
        <div className="m-3.25 rounded-xl border border-line bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-ink">Extraction cancelled</p>
          <Button variant="primary" size="md" className="mt-2.5" onClick={() => void controller.runExtraction()}>
            Run a new extraction
          </Button>
        </div>
      )}
    </div>
  )
}

export default ResultsTab
