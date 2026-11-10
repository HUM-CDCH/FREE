import type { MenuItem } from './ResultsMenu'
import { isDeveloperUiEnabled } from './developerUi'
import type { EvidenceLink } from '../shared/groundedExtraction'
import type { SelectionChannel } from './selectionChannel'
import PanelToggleIcon from './PanelToggleIcon'
import { Button } from './ui'
import SchemaPanel, { type SchemaPanelProps } from './SchemaPanel'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SchemaEditorController } from './currentSchemaRevision'
import { nodesToTemplate } from 'extraction/schema'
import { countTemplateFields } from '../shared/template'
import type { PinnedExtractionSource, DurableReviewProgress } from './durableExtractionApi'
import { DurableResults } from './DurableResults'
import { durableRailModel, statusLine } from './durableRailModel'
import RailChat, { type RailChatProps } from './RailChat'
import RegenerateDialog from './RegenerateDialog'
import { continuation, PAUSE_DESCRIPTION } from './extractionControl'
import { useSchemaChat, type ChatScope } from './useSchemaChat'
import type { CurrentResultSchema } from './resultSchema'
import { useDurableReading, type DurableReader } from './durableReader'
import type { SavedReviewCut } from './durableReviewLinks'
import type { ExtractionController } from './useExtraction'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import EvidenceTab from './EvidenceTab'
import type { ParsedDocument, ParsedEvidenceAnchor } from 'extraction/parsed-document'
/** The rail's views. The chat is its home and the only way the work goes on; the others open from it and lead back. */
export type RailView = 'chat' | 'evidence' | 'schema' | 'results' | 'history'

export type ExtractionInspection = {
  attempt: ExtractionAttempt | null
  /** The explicit result/decision cut to open `attempt` on; null opens its live cut. */
  cut: SavedReviewCut | null
  readOnly: boolean
  /** The inspected Extraction's pinned parsed document, or the open one while it is unknown. */
  parsedDocument: ParsedDocument | null
  /** The workspace's reader of `attempt`, which outlives the Results view; null until it is made. */
  reader: DurableReader | null
}

type RightRailProps = {
  open: boolean
  onToggle: () => void
  view: RailView
  onViewChange: (view: RailView) => void
  schema: SchemaEditorController
  onGenerateInstructions?: (instruction: string) => void
  onClearDraft: () => void | Promise<void>
  extraction: ExtractionController
  inspection: ExtractionInspection
  /** The latest Extraction's reader: the banner reports its connection once admission is settled. */
  latestReader?: DurableReader | null
  /** Acknowledged Current Schema Revision, for the Results panel's comparison. */
  currentSchemaRevision: CurrentResultSchema | null
  /** Why the tab strip's Run cannot start now (its disabled title); Results' empty state says it. */
  runUnavailableReason?: string | null
  sourceDocumentName: string
  /** The open project, whose chat this is. */
  projectName?: string | null
  sourceRepresentationId: string
  schemaName?: string | null
  onRenameSchema?: (name: string) => Promise<string | null>
  recordScope?: SchemaPanelProps['recordScope']
  boundaries?: SchemaPanelProps['boundaries']
  /** Entries the workspace adds to the Results header's ⋯ menu: "Open latest reviewed". */
  resultsMenuItems?: readonly MenuItem[]
  /** The document's Extractions, above the shown one's own History; read only while `visible`. */
  documentHistory?: (visible: boolean) => ReactNode
  /** Set while Results shows an Extraction that is not the document's latest: opens the latest. */
  onOpenLatest?: (() => void) | null
  onValueHistory?: (extractionId: string, valueId: string, name: string) => void
  onSelectEvidence: (anchor: ParsedEvidenceAnchor, link?: EvidenceLink) => void
  /** The workspace's channel: requests to select a value come in; Results' marks and dimming go out. */
  selection: SelectionChannel
  onPinnedDocument?: (id:string,source:PinnedExtractionSource|null)=>void
  onReviewProgress?:(progress:DurableReviewProgress|null)=>void
  onReviewFinalized?:()=>void
  /** Run extraction from the chat's step, where the workspace offers it. */
  run?: { start: () => void; available: boolean } | null
  /** The latest Extraction's commands, which the chat's step offers while it can go on. */
  control?: { command: (action: 'pause' | 'resume' | 'retry' | 'stop') => void; busy: boolean } | null
  /** The project's workflow, which the chat's steps lead. */
  project?: RailChatProps['project']
  /** Where the chat is kept: with its project, the turn to this document said in it. */
  chatScope?: ChatScope | null
}

const VIEW_TITLES: Record<Exclude<RailView, 'chat'>, string> = {
  evidence: 'Evidence', schema: 'Template', results: 'Results', history: 'History',
}

/** An Extraction still at work: its line shows it running, with no Run beside it. */
const ACTIVE_STATUSES: ReadonlySet<ExtractionAttempt['executionStatus']> = new Set(['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'])

const iconButtonClass ='grid size-7 shrink-0 cursor-pointer place-items-center rounded-[3px] text-ink-muted outline-none transition-colors hover:text-ink focus-visible:text-ink'

function HistoryIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3l2 1.5" />
    </svg>
  )
}

/** A workflow line's own action: generating the template, or running this document's extraction. Its name is told
 *  apart from the chat step's options, which say the same things. */
type WorkflowAction = { label: ReactNode; name: string; tone: 'positive' | 'secondary' | 'danger'; disabled: boolean; reason: string | null; run: () => void }

const workflowButton = 'inline-flex h-6 min-w-7 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border px-2 text-compact font-semibold outline-none transition-colors disabled:cursor-default disabled:opacity-45'
const workflowTone: Record<WorkflowAction['tone'], string> = {
  positive: 'border-green bg-green text-white hover:brightness-108',
  secondary: 'border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-muted',
  danger: 'border-danger/40 bg-surface text-danger hover:border-danger hover:bg-danger-soft',
}

/** "Again": a circular arrow, drawn so it sits on the text's line at any font, unlike the ⟳ glyph. */
function AgainIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="block">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </svg>
  )
}

/** One step of the workflow under the chat's header: where the template or the results are now, a way to open them
 *  in full, and the step's own action, always within reach whatever the chat's step is. */
function WorkflowLine({ step, label, detail, state, onOpen, action }: {
  step: number; label: string; detail: string; state: 'todo' | 'busy' | 'done'; onOpen: () => void; action: WorkflowAction | null
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-1.5 py-1">
      {state === 'busy'
        ? <span aria-hidden="true" className="size-4 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-ink" />
        : <span aria-hidden="true" className={`grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${state === 'done' ? 'bg-green text-white' : 'border border-line-strong text-ink-muted'}`}>
            {state === 'done' ? '✓' : step}
          </span>}
      <span className="shrink-0 text-compact font-bold text-ink">{label}</span>
      <span className="min-w-0 flex-1 truncate text-compact text-ink-muted" title={detail}>{detail}</span>
      <button type="button" onClick={onOpen} aria-label={`Open ${label.toLowerCase()}: ${detail}`} title={`Open ${label.toLowerCase()}`}
        className={`${workflowButton} ${workflowTone.secondary}`}>
        {label === 'Template' ? 'View' : 'Open'}
      </button>
      {action && (
        <button type="button" onClick={action.run} disabled={action.disabled} aria-label={action.name}
          title={action.reason ? `${action.name}: ${action.reason}` : action.name} className={`${workflowButton} ${workflowTone[action.tone]}`}>
          {action.label}
        </button>
      )}
    </div>
  )
}

function RightRail({
  open,
  onToggle,
  view,
  onViewChange,
  schema,
  onGenerateInstructions,
  onClearDraft,
  extraction,
  inspection,
  latestReader = null,
  currentSchemaRevision,
  runUnavailableReason = null,
  sourceDocumentName,
  projectName = null,
  sourceRepresentationId,
  schemaName,
  onRenameSchema,
  recordScope,
  boundaries,
  resultsMenuItems,
  documentHistory,
  onOpenLatest = null,
  onValueHistory,
  onSelectEvidence,
  selection,
  onPinnedDocument,
  onReviewProgress,
  onReviewFinalized,
  run = null,
  control = null,
  project = null,
  chatScope = null,
}: RightRailProps) {
  const { parsedDocument } = inspection
  // A collapsed rail moves nothing on the document; one-by-one follows its value again on expand (DurableResults).
  const selectNativeEvidence=useCallback((id:string,occurrenceIds?:readonly string[],link?:EvidenceLink)=> {
    if(!open)return
    const anchor=parsedDocument?.evidence_index.anchors.find(each=>each.anchor_id===id)
    if(!anchor)return
    if(!occurrenceIds)onSelectEvidence(anchor,link)
    else if(anchor.kind==='text')onSelectEvidence({...anchor,producer_observations:anchor.producer_observations.filter(occurrence=>occurrenceIds.includes(occurrence.occurrence_id))},link)
    else onSelectEvidence({...anchor,producer_observations:anchor.producer_observations.filter(occurrence=>occurrenceIds.includes(occurrence.occurrence_id))},link)
  },[open,parsedDocument,onSelectEvidence])
  // Collapsing or expanding takes away the button that was showing, so the one now shown takes the focus; a mount
  // moves none.
  const expandButton = useRef<HTMLButtonElement>(null)
  const collapseButton = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current === open) return
    wasOpen.current = open
    const button = open ? collapseButton : expandButton
    button.current?.focus()
  }, [open])
  const showDeveloperUi = isDeveloperUiEnabled()
  // An uncertain admission is reconnected by admission; once settled, the latest reader reads again.
  const latestReading = useDurableReading(latestReader)
  const statusError = extraction.monitorError ?? latestReading?.error ?? null

  // The schema chat lives with the rail, under every tab, so its conversation and next step follow the researcher.
  const chat = useSchemaChat({ schema, sourceRepresentationId, scope: chatScope })
  const latestAttempt = extraction.attempt
  const latestPage = latestReading?.latestPage?.extractionId === latestAttempt?.extractionId ? latestReading?.latestPage ?? null : null
  const latestModel = useMemo(() => latestPage ? durableRailModel(latestPage, null) : null, [latestPage])
  const latestStatus = latestReading?.state && latestModel && latestAttempt
    ? statusLine(latestReading.state, latestModel, latestAttempt.strategy === 'ARTICLE', Boolean(latestPage?.finalization))
    : null
  const schemaSnap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const schemaReady = schemaSnap.view === 'editing'
  const schemaFieldCount = schemaReady
    ? countTemplateFields(nodesToTemplate(schemaSnap.draft!.schemaNodes))
    : 0
  const shown = inspection.attempt ?? extraction.attempt
  // History lists the document's Extractions even when none is shown, e.g. all read an earlier source text.
  const historyAvailable = Boolean(shown || documentHistory)
  const activeView: RailView = (!showDeveloperUi && view === 'evidence') || (!historyAvailable && view === 'history') ? 'chat' : view
  // Results renders its guidance and saved versions into the History view's body.
  const [historySlot, setHistorySlot] = useState<HTMLDivElement | null>(null)
  const scopeWord = recordScope?.value === 'records' ? 'Catalog' : recordScope?.value === 'document' ? 'Article' : null
  const schemaDetail = schemaSnap.view === 'generating' ? 'Generating…'
    : schemaReady ? [`${schemaFieldCount} field${schemaFieldCount === 1 ? '' : 's'}`, scopeWord].filter(Boolean).join(' · ')
      : 'Not created yet'
  // The schema is the project's; results are one document's, named so the chat never reads as that document's own.
  const resultsDetail = `${sourceDocumentName} · ${shown ? shown.executionStatus.toLowerCase() : 'not run yet'}`
  // Each workflow line's own action, reachable whatever step the chat is on: (re)generating the template, or (re)running
  // this document's extraction. What blocks one is said on it.
  const readOnly = inspection.readOnly
  const [regenerating, setRegenerating] = useState(false)
  const generateAction: WorkflowAction | null = !onGenerateInstructions || readOnly ? null
    : schemaSnap.generating
      ? { label: 'Stop', name: 'Stop the template generation', tone: 'danger', disabled: false, reason: null, run: () => schema.cancelGeneration() }
      : (() => {
          const reason = chat.asking !== null || chat.loading ? 'wait for the reply'
            : chat.proposalReview.pending ? 'apply or discard the proposed changes first'
              : schemaSnap.historicalPreview !== null ? 'leave the History preview first' : null
          return schemaReady
            // Generating again asks first, as the Template view's Regenerate does.
            ? { label: <AgainIcon />, name: 'Generate the template again from the document', tone: 'secondary', disabled: reason !== null, reason,
                run: () => setRegenerating(true) }
            : { label: 'Generate', name: 'Generate the template from the document', tone: 'positive', disabled: reason !== null, reason,
                run: () => onGenerateInstructions(chat.instructions.text) }
        })()
  const latestActive = latestAttempt ? ACTIVE_STATUSES.has(latestAttempt.executionStatus) : false
  const runAction: WorkflowAction | null = !run || readOnly || latestActive ? null : (() => {
    const reason = !schemaReady ? 'create the template first' : run.available ? null : runUnavailableReason ?? 'it cannot start now'
    return latestAttempt
      ? { label: <AgainIcon />, name: 'Extract this document again', tone: schemaReady ? 'positive' : 'secondary', disabled: reason !== null, reason, run: run.start }
      : { label: '▶ Run', name: 'Extract this document', tone: schemaReady ? 'positive' : 'secondary', disabled: reason !== null, reason, run: run.start }
  })()

  return (
    <>
    {!open && (
      <div className="flex h-full flex-col items-center">
        <button
          ref={expandButton}
          className="flex cursor-pointer items-center justify-center py-3 text-ink-muted outline-none transition-colors hover:text-ink focus-visible:text-ink"
          type="button"
          title="Expand panel"
          onClick={onToggle}
        >
          <PanelToggleIcon side="right" />
        </button>
        <span className="mt-0.5 text-overline font-bold uppercase tracking-[0.14em] text-ink-muted [writing-mode:vertical-rl]">
          {activeView === 'chat' ? 'Project chat' : `Project chat · ${VIEW_TITLES[activeView]}`}
        </span>
      </div>
    )}
    {/* Collapsed, the rail keeps everything below mounted, so a collapse never destroys work in it. `hidden` beats
        `flex` only through the preflight's `[hidden] { display: none !important }`. */}
    <div hidden={!open} className="flex h-full min-h-0 flex-col">
      {/* As tall as the tab strip and the navigation's header, so the three columns' top lines meet. */}
      <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-line py-1.5 pl-3 pr-1">
        {activeView === 'chat' ? (
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-overline font-bold uppercase tracking-[0.12em] text-ink-muted">Project chat</h2>
            {projectName && <p className="m-0 truncate text-[13px] font-bold text-ink" title={projectName}>{projectName}</p>}
          </div>
        ) : (
          <>
            <button type="button" aria-label="Back to chat" title="Back to chat" onClick={() => onViewChange('chat')}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-[3px] px-1.5 py-1 text-compact font-semibold text-ink-muted outline-none transition-colors hover:text-ink focus-visible:text-ink">
              <span aria-hidden="true">←</span> Chat
            </button>
            <h2 className="m-0 min-w-0 flex-1 truncate text-[13px] font-bold text-ink">{VIEW_TITLES[activeView]}</h2>
          </>
        )}
        {activeView === 'chat' && showDeveloperUi && (
          <button type="button" className={`${iconButtonClass} w-auto px-1.5 text-overline font-bold uppercase`} title="Evidence" aria-label="Evidence"
            onClick={() => onViewChange('evidence')}>Ev{parsedDocument ? ` ${parsedDocument.evidence_index.anchors.length}` : ''}</button>
        )}
        {activeView === 'chat' && historyAvailable && (
          <button type="button" className={iconButtonClass} title="History" aria-label="History" onClick={() => onViewChange('history')}>
            <HistoryIcon />
          </button>
        )}
        <button
          ref={collapseButton}
          className={iconButtonClass}
          type="button"
          title="Collapse panel"
          onClick={onToggle}
        >
          <PanelToggleIcon side="right" />
        </button>
      </div>
      {activeView === 'chat' && (
        <nav aria-label="Template and results" className="flex shrink-0 flex-col divide-y divide-line border-b border-line px-1.5 py-0.5">
          <WorkflowLine step={1} label="Template" detail={schemaDetail} onOpen={() => onViewChange('schema')} action={generateAction}
            state={schemaSnap.generating ? 'busy' : schemaReady ? 'done' : 'todo'} />
          <WorkflowLine step={2} label="Results" detail={resultsDetail} onOpen={() => onViewChange('results')} action={runAction}
            state={latestActive ? 'busy' : shown?.executionStatus === 'COMPLETED' ? 'done' : 'todo'} />
        </nav>
      )}

      {/* Status belongs to the latest run, including an unanswered re-run while prior results remain visible. Mounted only
          while open, so expanding announces its alert. */}
      {open&&shown&&(extraction.admitting||extraction.retryAdmission)&&<p role="status" className="m-0 shrink-0 border-b border-line px-3 py-2 text-compact text-ink-muted">A new extraction has not been acknowledged yet. These are previous results.</p>}
      {open && statusError && <div className="flex shrink-0 flex-col items-start gap-2 border-b border-line px-3 py-3">
        <p role="alert" className="m-0 max-w-full text-compact text-danger [overflow-wrap:anywhere]">{statusError}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={extraction.monitorError ? extraction.reconnect : () => void latestReader?.refresh()}>Reconnect</Button>
          {extraction.retryAdmission&&<Button onClick={()=>void extraction.retryAdmission?.()}>Retry original request</Button>}
        </div>
      </div>}

      {/* Every view's body stays mounted so chat drafts and schema edit state survive leaving a view and a collapse. */}
      {showDeveloperUi && (
        <div id="rail-panel-evidence" role="region" aria-label="Evidence" tabIndex={-1} className="min-h-0 flex-1" hidden={activeView !== 'evidence'}>
          <EvidenceTab document={parsedDocument} onSelectAnchor={onSelectEvidence} />
        </div>
      )}
      <div id="rail-panel-schema" role="region" aria-label="Template" tabIndex={-1} className="min-h-0 flex-1" hidden={activeView !== 'schema'}>
        <SchemaPanel
          schema={schema}
          onGenerateInstructions={onGenerateInstructions}
          onClearDraft={onClearDraft}
          sourceDocumentName={sourceDocumentName}
          sourceRepresentationId={sourceRepresentationId}
          schemaName={schemaName}
          onRenameSchema={onRenameSchema}
          recordScope={recordScope}
          boundaries={boundaries}
          chat={chat}
        />
      </div>
      <div id="rail-panel-results" role="region" aria-label="Results" tabIndex={-1} className="min-h-0 flex-1" hidden={activeView !== 'results'}>
        {shown ? <DurableResults
          key={`${shown.extractionId}:${inspection.cut ? `${inspection.cut.snapshotVersion}:${inspection.cut.feedbackVersion}` : 'live'}`}
          attempt={shown}
          reader={inspection.reader}
          connectionShown={inspection.reader === latestReader}
          initialCut={inspection.cut}
          document={parsedDocument}
          documentRevisionId={sourceRepresentationId}
          currentSchema={currentSchemaRevision}
          onSchema={()=>onViewChange('schema')}
          controlled={shown.extractionId===extraction.attempt?.extractionId}
          sourceDocumentName={sourceDocumentName}
          readOnly={inspection.readOnly}
          onEvidence={selectNativeEvidence}
          selection={selection}
          menuItems={resultsMenuItems}
          onOpenLatest={onOpenLatest}
          onValueHistory={onValueHistory}
          onReviewProgress={onReviewProgress}
          onReviewFinalized={onReviewFinalized}
          onPinnedDocument={onPinnedDocument}
          railOpen={open}
          historySlot={historySlot}
          historyShown={open && activeView === 'history'}
          onShowResults={() => onViewChange('results')}
          onShowHistory={() => onViewChange('history')}
        /> : <div className="flex h-full min-h-0 flex-col items-center justify-center px-6 text-center">
          <p className="m-0 text-content font-semibold text-ink">No results yet</p>
          <p className="mt-1.5 mb-0 max-w-[34ch] text-compact leading-snug text-ink-muted">
            {schemaReady ? 'Run extraction to apply the template across the source document.' : 'Create a template in the chat first, then run extraction.'}
          </p>
          {!inspection.readOnly && schemaReady && <p className="mt-1.5 mb-0 max-w-full text-compact font-semibold text-ink [overflow-wrap:anywhere]">{runUnavailableReason ?? 'The chat offers Run extraction as its next step.'}</p>}
        </div>}
      </div>
      {historyAvailable && <div id="rail-panel-history" role="region" aria-label="History" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto" hidden={activeView !== 'history'}>
        {documentHistory && <div className="p-3 pb-0">{documentHistory(open && activeView === 'history')}</div>}
        <div ref={setHistorySlot} />
      </div>}
      <RailChat
        chat={chat}
        schema={schema}
        sourceDocumentName={sourceDocumentName}
        onGenerate={onGenerateInstructions}
        recordScope={recordScope}
        run={run && { ...run, unavailableReason: runUnavailableReason }}
        control={control && (() => {
          const { blocked, description } = continuation(latestReading?.state)
          return { ...control, continueBlocked: blocked, continueDescription: description, pauseDescription: PAUSE_DESCRIPTION }
        })()}
        latest={latestAttempt ? {
          extractionId: latestAttempt.extractionId,
          schemaRevisionId: latestAttempt.schemaRevisionId,
          status: latestAttempt.executionStatus,
          progress: latestStatus && `${latestStatus.word} ${latestStatus.rest}`.trim(),
          toCheck: latestModel?.counts.toCheck ?? null,
        } : null}
        readOnly={inspection.readOnly}
        project={project}
        resultsShown={open && activeView === 'results'}
        templateShown={open && activeView === 'schema'}
        onShowView={onViewChange}
        mode={activeView === 'chat' ? 'full' : 'step'}
      />
      {regenerating && onGenerateInstructions && schemaReady && (
        <RegenerateDialog instructions={chat.instructions} nodes={schemaSnap.draft!.schemaNodes} generating={schemaSnap.generating}
          onCancel={() => setRegenerating(false)} onRegenerate={onGenerateInstructions} />
      )}
    </div>
    </>
  )
}

export default RightRail
