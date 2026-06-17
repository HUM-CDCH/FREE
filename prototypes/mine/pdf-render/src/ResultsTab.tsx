import type { ExtractionController } from './useExtraction'

type ResultsTabProps = {
  controller: ExtractionController
  schemaReady: boolean
}

// Shared with the prior ExportModal preview: scrollable, monospace, read-only.
const preClasses =
  'scrollbar-subtle m-0 min-h-0 flex-1 overflow-auto whitespace-pre bg-canvas px-4 py-3.5 font-mono text-[11px] leading-relaxed text-ink'

function ResultsTab({ controller, schemaReady }: ResultsTabProps) {
  const { state } = controller

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-9.5 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">
          Extraction results
        </h2>
      </header>

      {state.status === 'ready' && <pre className={preClasses}>{JSON.stringify(state.result, null, 2)}</pre>}

      {state.status === 'running' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <span
            aria-hidden="true"
            className="animate-spin-slow size-7 rounded-full border-[3px] border-line border-t-accent"
          />
          <p className="text-[13px] font-semibold text-ink">Extracting…</p>
          <p className="max-w-[34ch] text-[11.5px] leading-snug text-ink-muted">
            This can take a while on large documents.
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
              ? 'Run extraction to apply the schema across the document. The raw JSON result will appear here.'
              : 'Generate a schema in the Schema tab first, then run extraction.'}
          </p>
          <button
            className="mt-4 cursor-pointer rounded-lg border border-accent bg-accent px-4 py-2 text-[12.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:border-line disabled:bg-line disabled:text-ink-muted"
            type="button"
            disabled={!controller.canRun}
            onClick={() => void controller.runExtraction()}
          >
            {schemaReady ? '▶ Run extraction' : 'Generate a schema first'}
          </button>
        </div>
      )}
    </div>
  )
}

export default ResultsTab
