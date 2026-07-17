import type { ExtractionController } from './useExtraction'
import { Button, Overline, SegmentedControl, Spinner } from './ui'

type ResultsTabProps = {
  controller: ExtractionController
  schemaReady: boolean
}

const preClasses =
  'scrollbar-subtle m-0 min-h-0 flex-1 overflow-auto whitespace-pre bg-canvas px-4 py-3.5 font-mono text-[11px] leading-relaxed text-ink'

function ResultsTab({ controller, schemaReady }: ResultsTabProps) {
  const { state } = controller

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-9.5 shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-1.5">
        <Overline as="h2">Extraction results</Overline>
        <SegmentedControl
          aria-label="Extraction strategy"
          value={controller.strategy}
          onChange={controller.setStrategy}
          options={[
            { value: 'catalog', label: 'Catalog' },
            { value: 'article', label: 'Article' },
          ]}
        />
      </header>

      {state.status === 'ready' && (
        <>
          <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
            {state.warnings.length > 0 && (
              <ul className="mb-2 space-y-1" aria-label="Extraction warnings">
                {state.warnings.map((warning) => (
                  <li
                    key={warning}
                    className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-ink"
                  >
                    {warning}
                  </li>
                ))}
              </ul>
            )}
            <Button variant="secondary" size="sm" onClick={() => void controller.runExtraction()}>
              Rerun {controller.strategy}
            </Button>
          </div>
          <pre className={preClasses}>{JSON.stringify(state.result, null, 2)}</pre>
        </>
      )}

      {state.status === 'running' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
          <Spinner
            label={`Running ${controller.strategy} extraction...`}
            hint="This can take a while on large source documents."
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
              ? `Run ${controller.strategy} extraction against the completed canonical document.`
              : 'Generate a schema in the Schema tab first, then run extraction.'}
          </p>
          <Button
            variant="primary"
            size="md"
            className="mt-4"
            disabled={!controller.canRun}
            onClick={() => void controller.runExtraction()}
          >
            {schemaReady ? `Run ${controller.strategy}` : 'Generate a schema first'}
          </Button>
        </div>
      )}
    </div>
  )
}

export default ResultsTab
