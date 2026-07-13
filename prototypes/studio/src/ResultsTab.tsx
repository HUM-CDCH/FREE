import { useMemo, useState } from 'react'
import ResultValue from './ui/ResultValue'
import { Overline, SegmentedControl, Spinner, Button } from './ui'
import { resultStats } from './resultStats'
import type { ExtractionController } from './useExtraction'

type ResultsTabProps = {
  controller: ExtractionController
  schemaReady: boolean
  documentMarkdown: string | null
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

function ResultsTab({ controller, schemaReady, documentMarkdown }: ResultsTabProps) {
  const { state } = controller
  const [view, setView] = useState<View>('review')
  const stats = useMemo(() => (state.status === 'ready' ? resultStats(state.result) : null), [state])

  async function copyJson() {
    if (state.status === 'ready') {
      await navigator.clipboard.writeText(JSON.stringify(state.result, null, 2))
    }
  }

  function downloadJson() {
    if (state.status !== 'ready') {
      return
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'free-extraction-result.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-9.5 shrink-0 items-center gap-2 border-b border-line px-4">
        <Overline as="h2">Extraction results</Overline>
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
                <Button variant="secondary" size="sm" onClick={() => void controller.runExtraction()}>
                  Rerun
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void copyJson()}>
                  Copy JSON
                </Button>
                <Button variant="secondary" size="sm" onClick={downloadJson}>
                  Download
                </Button>
              </div>
            </div>
          </div>

          {view === 'review' && (
            <div className="scrollbar-subtle min-h-0 flex-1 overflow-auto bg-canvas p-3">
              <ResultValue name="Extraction result" value={state.result} />
            </div>
          )}

          {view === 'json' && <pre className={preClasses}>{JSON.stringify(state.result, null, 2)}</pre>}

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
          <Spinner label="Extracting..." hint="This can take a while on large source documents." />
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
    </div>
  )
}

export default ResultsTab
