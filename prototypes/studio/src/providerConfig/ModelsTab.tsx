import { type ReactNode, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { ExtractionModelListing, ExtractionModelRole } from '../../shared/extraction.contract'
import {
  selectedRoute,
  usesNuextractProtocol,
  type DeploymentModels,
  type IngestionModelListing,
  type IngestionModelRole,
  type ModelConfig,
  type ModelConnection,
  type ProviderDescriptor,
  type Route,
  type RouteKey,
} from '../../shared/modelConfig.contract'
import { ListingPicker, RoutePicker } from './ChoicePickers'
import type { ProbeView } from './useProbeLifecycle'

const FROM_CONNECTIONS = 'Choose any model from your connections.'
const FROM_DEPLOYMENT = 'Choose among the models this deployment runs.'
const INGESTION_ROLES: readonly { role: IngestionModelRole; label: string; hint: string; group: string; unserved: string }[] = [
  {
    role: 'ocr',
    label: 'Text recognition',
    hint: 'Transcribes scanned pages; native PDFs are read from their text layer',
    group: 'OCR models this deployment knows',
    unserved: 'Not loaded on the OCR server',
  },
  {
    role: 'layout',
    label: 'Page regions',
    hint: 'Finds columns, tables and blocks before text is read',
    group: 'Layout detectors this deployment runs',
    unserved: 'Not available',
  },
]
const EXTRACTION_ROLES: readonly { role: ExtractionModelRole; label: string; hint: string }[] = [
  { role: 'fields', label: 'Field values', hint: "Reads each field's value off the source" },
  { role: 'reasoning', label: 'Reasoning', hint: 'Finds record starts, grounds values, picks between candidates' },
]

type Props = {
  draft: ModelConfig
  deployment: DeploymentModels
  descriptor: (connection: Pick<ModelConnection, 'provider'>) => ProviderDescriptor | undefined
  probes: Readonly<Record<string, ProbeView>>
  extractionListing: ExtractionModelListing | null
  ingestionListing: IngestionModelListing | null
  assign: (task: RouteKey, target: Route | null) => void
  setExtractionModel: (role: ExtractionModelRole, key: string) => void
  setIngestionModel: (role: IngestionModelRole, key: string) => void
}

/** Which model does what, as the three steps of a researcher's work. A step at its defaults is one sentence. */
export function ModelsTab({
  draft,
  deployment,
  descriptor,
  probes,
  extractionListing,
  ingestionListing,
  assign,
  setExtractionModel,
  setIngestionModel,
}: Props) {
  const routable = [...deployment.connections, ...draft.connections]
  const { interaction, schemaSuggestion } = draft.routes
  const [editing, setEditing] = useState<number | null>(() =>
    Object.keys(draft.ingestionModels).length ? 1 : interaction || schemaSuggestion ? 2 : Object.keys(draft.extractionModels).length ? 3 : null,
  )
  const ingestionLabel = (role: IngestionModelRole, key: string) =>
    ingestionListing?.models[role].find((model) => model.key === key)?.label ?? key
  const extractionRepo = (key: string) => extractionListing?.models.find((model) => model.key === key)?.repo ?? key

  // Where Schema Suggestion runs, set or followed; NuExtract's protocol follows from it and is never a choice.
  const suggestion = selectedRoute(draft.routes, 'schemaSuggestion', deployment.defaultRoute)
  const suggestionConnection = routable.find(({ id }) => id === suggestion?.connectionId)
  const suggestionProvider = suggestionConnection && descriptor(suggestionConnection)
  const nuextract = suggestion && suggestionProvider ? usesNuextractProtocol(suggestionProvider, suggestion.modelId) : false

  return (
    <div className="configuration-view models-overview space-y-3 p-3 sm:p-4">
        <Step
          n={1}
          title="Reading documents"
          source={`${FROM_DEPLOYMENT} Applies to new uploads and reprocessing.`}
          open={editing === 1}
          onOpen={() => setEditing(1)}
          onClose={() => setEditing(null)}
          onReset={() => INGESTION_ROLES.forEach(({ role }) => setIngestionModel(role, ''))}
          summary={
            ingestionListing ? (
              <>
                Scanned pages are read by <Model>{ingestionLabel('ocr', draft.ingestionModels.ocr ?? ingestionListing.defaults.ocr)}</Model>, page regions found
                by <Model>{ingestionLabel('layout', draft.ingestionModels.layout ?? ingestionListing.defaults.layout)}</Model>.
              </>
            ) : (
              "Scanned pages are read and their page regions found by the deployment's default models."
            )
          }
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {INGESTION_ROLES.map(({ role, label, hint, group, unserved }) => (
              <Labeled key={role} label={label} hint={hint}>
                <ListingPicker
                  ariaLabel={label}
                  group={group}
                  value={draft.ingestionModels[role] ?? ''}
                  defaultKey={ingestionListing?.defaults[role]}
                  choices={ingestionListing?.models[role].map(({ key, label: name, serving }) => ({ key, name, serving })) ?? null}
                  unserved={unserved}
                  onChange={(key) => setIngestionModel(role, key)}
                />
              </Labeled>
            ))}
          </div>
        </Step>

        <Step
          n={2}
          title="Schema & chat"
          source={FROM_CONNECTIONS}
          open={editing === 2}
          onOpen={() => setEditing(2)}
          onClose={() => setEditing(null)}
          onReset={() => {
            assign('interaction', null)
            assign('schemaSuggestion', null)
          }}
          summary={
            interaction || schemaSuggestion ? (
              <>
                Assistant: <Model>{interaction?.modelId ?? deployment.defaultRoute?.modelId ?? 'No model configured'}</Model>.
                {' '}Schema Suggestion: <Model>{suggestion?.modelId ?? 'No model configured'}</Model>.
              </>
            ) : deployment.defaultRoute ? (
              <>
                Chat, schema editing and Schema Suggestion use <Model>{deployment.defaultRoute.modelId}</Model>, the deployment's
                model.
              </>
            ) : (
              'No model is configured yet.'
            )
          }
          note={nuextract ? 'Schema Suggestion uses the NuExtract protocol for this model.' : undefined}
        >
          <AssistantChoice draft={draft} deployment={deployment} routable={routable} probes={probes} assign={assign} />
        </Step>

        <Step
          n={3}
          title="Extracting data"
          source={FROM_DEPLOYMENT}
          open={editing === 3}
          onOpen={() => setEditing(3)}
          onClose={() => setEditing(null)}
          onReset={() => EXTRACTION_ROLES.forEach(({ role }) => setExtractionModel(role, ''))}
          summary={
            extractionListing ? (
              <>
                <Model>{extractionRepo(draft.extractionModels.fields ?? extractionListing.defaults.fields)}</Model> reads field values,{' '}
                <Model>{extractionRepo(draft.extractionModels.reasoning ?? extractionListing.defaults.reasoning)}</Model> reasons over the source.
              </>
            ) : (
              "The deployment's default models read field values and reason over the source."
            )
          }
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {EXTRACTION_ROLES.map(({ role, label, hint }) => (
              <Labeled key={role} label={label} hint={hint}>
                <ListingPicker
                  ariaLabel={label}
                  group="Extraction models this deployment runs"
                  value={draft.extractionModels[role] ?? ''}
                  defaultKey={extractionListing?.defaults[role]}
                  choices={
                    extractionListing?.models
                      .filter((model) => model.roles.includes(role))
                      .map(({ key, repo, serving }) => ({ key, name: repo, serving })) ?? null
                  }
                  unserved="Not serving"
                  onChange={(key) => setExtractionModel(role, key)}
                />
              </Labeled>
            ))}
          </div>
        </Step>
    </div>
  )
}

const Model = ({ children }: { children: ReactNode }) => <span title={typeof children === 'string' ? children : undefined} className="break-all font-mono text-ink">{children}</span>

/** A step of the work: a summary sentence at its defaults, its pickers once changed. "Use defaults" folds it back. */
function Step({
  n,
  title,
  source,
  summary,
  open,
  onOpen,
  onClose,
  onReset,
  note,
  children,
}: {
  n: number
  title: string
  source: string
  summary: ReactNode
  open: boolean
  onOpen: () => void
  onClose: () => void
  onReset: () => void
  note?: string
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
      <div aria-hidden="true" className="flex flex-col items-center">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface text-[12px] font-bold text-ink-muted">
          {n}
        </span>
      </div>
      <section aria-labelledby={titleId} data-editing={open} className="model-step min-w-0 rounded-xl border border-line bg-surface p-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 id={titleId} className="text-[13px] font-bold text-ink">{title}</h3>
          {open ? (
            <button
              type="button"
              className="text-[11.5px] font-semibold text-ink-muted transition-colors hover:text-accent"
              onClick={() => {
                onReset()
                if (open) onClose()
              }}
            >
              Use defaults
            </button>
          ) : (
            <button type="button" className="shrink-0 text-[11.5px] font-semibold text-accent hover:underline" onClick={onOpen}>Change</button>
          )}
        </div>
        <p className="model-step-description mb-2 text-[11px] text-ink-faint">{source}</p>
        <div hidden={!open}>{children}</div>
        {!open && <p className="model-step-summary text-[12px] text-ink-muted">{summary}</p>}
        {open && note && <p className="mt-3 text-[11.5px] text-ink-faint">{note}</p>}
      </section>
    </div>
  )
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold text-ink-muted">{label}</span>
      {hint && <span className="model-field-hint -mt-0.5 text-[10.5px] text-ink-faint">{hint}</span>}
      {children}
    </div>
  )
}

/** The Assistant model, and Schema Suggestion: it follows the Assistant model while its own route is unset. */
function AssistantChoice({
  draft,
  deployment,
  routable,
  probes,
  assign,
}: Pick<Props, 'draft' | 'deployment' | 'probes' | 'assign'> & { routable: readonly ModelConnection[] }) {
  const { interaction, schemaSuggestion } = draft.routes
  const [different, setDifferent] = useState(false)
  const suggestion = useRef<HTMLDivElement>(null)
  const differentButton = useRef<HTMLButtonElement>(null)
  // Each toggle swaps the control that was pressed for another, so focus moves to what replaced it, not to the page.
  const followAssistant = () => {
    flushSync(() => {
      assign('schemaSuggestion', null)
      setDifferent(false)
    })
    differentButton.current?.focus()
  }
  const chooseDifferent = () => {
    flushSync(() => setDifferent(true))
    suggestion.current?.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')?.focus()
  }
  const deploymentDefault = deployment.defaultRoute ? `Deployment default · ${deployment.defaultRoute.modelId}` : 'No model configured'
  return (
    <div className="model-assistant-choices grid gap-3 sm:grid-cols-2">
      <Labeled label="Assistant model" hint="Document chat and conversational schema editing">
        <RoutePicker
          ariaLabel="Assistant model"
          route={interaction}
          unset={deploymentDefault}
          routable={routable}
          probes={probes}
          onChange={(route) => assign('interaction', route)}
        />
      </Labeled>
      <div className="border-t border-line pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-3">
        {schemaSuggestion !== null || different ? (
          <div ref={suggestion} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] font-semibold text-ink-muted">Schema Suggestion</span>
              <button type="button" className="text-[11.5px] font-semibold text-ink-muted transition-colors hover:text-accent" onClick={followAssistant}>
                Use the assistant model
              </button>
            </div>
            <RoutePicker
              ariaLabel="Schema Suggestion model"
              route={schemaSuggestion}
              unset="Use the assistant model"
              routable={routable}
              probes={probes}
              onChange={(route) => (route ? assign('schemaSuggestion', route) : followAssistant())}
            />
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-ink-muted">
            <p>Schema Suggestion uses the assistant model.</p>
            <button ref={differentButton} type="button" className="font-semibold text-accent hover:underline" onClick={chooseDifferent}>
              Use a different model
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
