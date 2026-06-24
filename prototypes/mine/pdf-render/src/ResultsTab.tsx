import { useMemo, useState } from 'react'
import { requestMarkdown } from './api'
import ResultValue from './ResultValue'
import { resultStats } from './resultStats'
import type { ExtractionController } from './useExtraction'

type ResultsTabProps = {
  controller: ExtractionController
  schemaReady: boolean
  pdfSource: { url: string; filename: string } | null
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
    <span className="rounded-full border border-line bg-surface-muted px-2 py-1 text-[11px] font-semibold text-ink-muted">
      {label}: <span className="font-mono text-ink">{value}</span>
    </span>
  )
}

function ResultsTab({ controller, schemaReady, pdfSource }: ResultsTabProps) {
  const { state } = controller
  const [view, setView] = useState<View>('review')
  const [markdown, setMarkdown] = useState<MarkdownState>({ status: 'idle' })
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

  async function generateMarkdown() {
    if (!pdfSource || markdown.status === 'running') {
      return
    }
    setMarkdown({ status: 'running' })
    try {
      const blob = await (await fetch(pdfSource.url)).blob()
      const done = await requestMarkdown(blob, pdfSource.filename)
      setMarkdown({ status: 'ready', markdown: done.markdown })
    } catch (error) {
      setMarkdown({
        status: 'error',
        message: error instanceof Error ? error.message : 'Markdown generation failed.',
      })
    }
  }

  const tabClasses = (active: boolean) =>
    `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
      active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'
    }`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-9.5 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">
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
                <button className="cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-muted hover:border-accent/50 hover:text-accent" type="button" onClick={() => void controller.runExtraction()}>
                  Rerun
                </button>
                <button className="cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-muted hover:border-accent/50 hover:text-accent" type="button" onClick={() => void copyJson()}>
                  Copy JSON
                </button>
                <button className="cursor-pointer rounded-md border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-muted hover:border-accent/50 hover:text-accent" type="button" onClick={downloadJson}>
                  Download
                </button>
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
          <p className="max-w-[34ch] text-[11.5px] leading-snug text-ink-muted">
            This can take a while on large source documents.
          </p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="m-3.25 rounded-xl border border-danger/40 bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-danger">Extraction failed</p>
          <p className="mt-1 wrap-anywhere text-[12px] leading-snug text-ink-muted">{state.message}</p>
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
          <p className="mt-1.5 max-w-[34ch] text-[11.5px] leading-snug text-ink-muted">
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
