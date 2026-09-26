import { type ReactNode, useId, useState } from 'react'
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
  const ingestionLabel = (role: IngestionModelRole, key: string) =>
    ingestionListing?.models[role].find((model) => model.key === key)?.label ?? key
  const extractionRepo = (key: string) => extractionListing?.models.find((model) => model.key === key)?.repo ?? key

  // Where Schema Suggestion runs, set or followed; NuExtract's protocol follows from it and is never a choice.
  const suggestion = selectedRoute(draft.routes, 'schemaSuggestion', deployment.defaultRoute)
  const suggestionConnection = routable.find(({ id }) => id === suggestion?.connectionId)
  const suggestionProvider = suggestionConnection && descriptor(suggestionConnection)
  const nuextract = suggestion && suggestionProvider ? usesNuextractProtocol(suggestionProvider, suggestion.modelId) : false

  return (
    <ol className="flex flex-col p-5">
      <Step
        n={1}
        title="Reading documents"
        source={`${FROM_DEPLOYMENT} Applies to new uploads and reprocessing.`}
        custom={Object.keys(draft.ingestionModels).length > 0}
        onReset={() => INGESTION_ROLES.forEach(({ role }) => setIngestionModel(role, ''))}
        summary={
          ingestionListing ? (
            <>
              Scanned pages are read by <Model>{ingestionLabel('ocr', ingestionListing.defaults.ocr)}</Model>, page regions found
              by <Model>{ingestionLabel('layout', ingestionListing.defaults.layout)}</Model>.
            </>
          ) : (
            "Scanned pages are read and their page regions found by the deployment's default models."
          )
        }
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
        custom={interaction !== null || schemaSuggestion !== null}
        onReset={() => {
          assign('interaction', null)
          assign('schemaSuggestion', null)
        }}
        summary={
          deployment.defaultRoute ? (
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
        custom={Object.keys(draft.extractionModels).length > 0}
        onReset={() => EXTRACTION_ROLES.forEach(({ role }) => setExtractionModel(role, ''))}
        summary={
          extractionListing ? (
            <>
              <Model>{extractionRepo(extractionListing.defaults.fields)}</Model> reads field values,{' '}
              <Model>{extractionRepo(extractionListing.defaults.reasoning)}</Model> reasons over the source.
            </>
          ) : (
            "The deployment's default models read field values and reason over the source."
          )
        }
        last
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
    </ol>
  )
}

const Model = ({ children }: { children: ReactNode }) => <span className="font-mono text-ink">{children}</span>

/** A step of the work: a summary sentence at its defaults, its pickers once changed. "Use defaults" folds it back. */
function Step({
  n,
  title,
  source,
  summary,
  custom,
  onReset,
  note,
  last = false,
  children,
}: {
  n: number
  title: string
  source: string
  summary: ReactNode
  custom: boolean
  onReset: () => void
  note?: string
  last?: boolean
  children: ReactNode
}) {
  const [opened, setOpened] = useState(false)
  const open = custom || opened
  const titleId = useId()
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
      <div aria-hidden="true" className="flex flex-col items-center">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface text-[12px] font-bold text-ink-muted">
          {n}
        </span>
        {!last && <span className="w-px flex-1 bg-line-strong" />}
      </div>
      <section aria-labelledby={titleId} className={`min-w-0 rounded-xl border border-line bg-surface p-4 ${last ? '' : 'mb-3'}`}>
        <div className="flex items-baseline justify-between gap-3">
          <h3 id={titleId} className="text-[13px] font-bold text-ink">{title}</h3>
          {open ? (
            <button
              type="button"
              className="text-[11.5px] font-semibold text-ink-muted transition-colors hover:text-accent"
              onClick={() => {
                onReset()
                setOpened(false)
              }}
            >
              Use defaults
            </button>
          ) : (
            <button type="button" className="text-[11.5px] font-semibold text-accent hover:underline" onClick={() => setOpened(true)}>
              Change
            </button>
          )}
        </div>
        <p className="mb-3 text-[11px] text-ink-faint">{source}</p>
        {open ? children : <p className="text-[12px] text-ink-muted">{summary}</p>}
        {note && <p className="mt-3 text-[11.5px] text-ink-faint">{note}</p>}
      </section>
    </li>
  )
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold text-ink-muted">{label}</span>
      {hint && <span className="-mt-0.5 text-[10.5px] text-ink-faint">{hint}</span>}
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
  const followAssistant = () => {
    assign('schemaSuggestion', null)
    setDifferent(false)
  }
  const deploymentDefault = deployment.defaultRoute ? `Deployment default · ${deployment.defaultRoute.modelId}` : 'No model configured'
  return (
    <div>
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
      <div className="mt-3 border-t border-line pt-3">
        {schemaSuggestion !== null || different ? (
          <div className="flex flex-col gap-1.5">
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
            <button type="button" className="font-semibold text-accent hover:underline" onClick={() => setDifferent(true)}>
              Use a different model
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
