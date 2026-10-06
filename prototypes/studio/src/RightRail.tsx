import { isDeveloperUiEnabled } from './developerUi'
import type { EvidenceLink } from '../shared/groundedExtraction'
import type { RailMarkState } from './useEvidenceOverlays'
import PanelToggleIcon from './PanelToggleIcon'
import { Button } from './ui'
import SchemaPanel, { type SchemaPanelProps } from './SchemaPanel'
import { useCallback, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import type { SchemaEditorController } from './currentSchemaRevision'
import { nodesToTemplate } from 'extraction/schema'
import { countTemplateFields } from '../shared/template'
import type { PinnedExtractionSource, DurableReviewProgress } from './durableExtractionApi'
import { DurableResults } from './DurableResults'
import type { SavedReviewCut } from './durableReviewLinks'
import type { ExtractionController } from './useExtraction'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import EvidenceTab from './EvidenceTab'
import type { ParsedDocument, ParsedEvidenceAnchor } from 'extraction/parsed-document'
export type RailTab = 'evidence' | 'schema' | 'results' | 'history'

export type ExtractionInspection = {
  attempt: ExtractionAttempt | null
  /** The explicit result/decision cut to open `attempt` on; null opens its live cut. */
  cut: SavedReviewCut | null
  readOnly: boolean
  /** The inspected Extraction's pinned parsed document, or the open one while it is unknown. */
  parsedDocument: ParsedDocument | null
}

type RightRailProps = {
  open: boolean
  onToggle: () => void
  tab: RailTab
  onTabChange: (tab: RailTab) => void
  schema: SchemaEditorController
  onGenerateInstructions?: (instruction: string) => void
  onClearDraft: () => void | Promise<void>
  extraction: ExtractionController
  inspection: ExtractionInspection
  /** Acknowledged Current Schema Revision, for the Results panel's comparison. */
  currentSchemaRevision: { schemaRevisionId: string; revisionNumber: number } | null
  /** Why the tab strip's Run cannot start now (its disabled title); Results' empty state says it. */
  runUnavailableReason?: string | null
  sourceDocumentName: string
  sourceRepresentationId: string
  schemaName?: string | null
  onRenameSchema?: (name: string) => Promise<string | null>
  recordScope?: SchemaPanelProps['recordScope']
  boundaries?: SchemaPanelProps['boundaries']
  /** Controls the Results header shows beside the attempt details: the snapshot choice, "Open latest reviewed". */
  resultsHeaderExtras?: ReactNode
  onSelectEvidence: (anchor: ParsedEvidenceAnchor, precision?: EvidenceLink['precision']) => void
  onResultPathChange: (path: string[] | null) => void
  /** The one-by-one value's Evidence link, for the document's dimming (results review redesign §7.3). */
  onFocusEvidence?: (link: EvidenceLink | null) => void
  /** The rail's values for the document's marks, and the handle a mark selects a value through (§7.2). */
  onMarksChange?: (marks: RailMarkState | null) => void
  selectValueRef?: RefObject<((key: string) => void) | null>
  onPinnedDocument?: (id:string,source:PinnedExtractionSource|null)=>void
  onReviewProgress?:(progress:DurableReviewProgress|null)=>void
  onReviewFinalized?:()=>void
}

/** A tab's count. Under a 300px tab strip (the 264px rail) a worded one ("7 to check") shows its number only, so the
 *  tab's label stays whole; its full words stay its name and title. */
function TabBadge({ label, active }: { label: string; active: boolean }) {
  const tone = `text-accent ${active ? 'bg-accent-soft' : 'bg-accent-ghost'}`
  const count = /^\d+(?=\D)/.exec(label)?.[0]
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-grid h-4 min-w-4.5 shrink-0 place-items-center whitespace-nowrap rounded-full px-1.5 font-mono text-overline leading-none tabular-nums ${tone}`}
    >
      {count ? (
        <>
          <span className="@max-[300px]:hidden">{label}</span>
          <span className="hidden @max-[300px]:inline">{count}</span>
        </>
      ) : label}
    </span>
  )
}

function RightRail({
  open,
  onToggle,
  tab,
  onTabChange,
  schema,
  onGenerateInstructions,
  onClearDraft,
  extraction,
  inspection,
  currentSchemaRevision,
  runUnavailableReason = null,
  sourceDocumentName,
  sourceRepresentationId,
  schemaName,
  onRenameSchema,
  recordScope,
  boundaries,
  resultsHeaderExtras,
  onSelectEvidence,
  onResultPathChange,
  onFocusEvidence,
  onMarksChange,
  selectValueRef,
  onPinnedDocument,
  onReviewProgress,
  onReviewFinalized,
}: RightRailProps) {
  const { parsedDocument } = inspection
  const selectNativeEvidence=useCallback((id:string,occurrenceIds?:readonly string[],precision?:EvidenceLink['precision'])=> {
    const anchor=parsedDocument?.evidence_index.anchors.find(each=>each.anchor_id===id)
    if(!anchor)return
    if(!occurrenceIds)onSelectEvidence(anchor,precision)
    else if(anchor.kind==='text')onSelectEvidence({...anchor,producer_observations:anchor.producer_observations.filter(occurrence=>occurrenceIds.includes(occurrence.occurrence_id))},precision)
    else onSelectEvidence({...anchor,producer_observations:anchor.producer_observations.filter(occurrence=>occurrenceIds.includes(occurrence.occurrence_id))},precision)
  },[parsedDocument,onSelectEvidence])
  const showDeveloperUi = isDeveloperUiEnabled()

  const schemaSnap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const schemaReady = schemaSnap.view === 'editing'
  const schemaFieldCount = schemaReady
    ? countTemplateFields(nodesToTemplate(schemaSnap.draft!.schemaNodes))
    : 0
  const shown = inspection.attempt ?? extraction.attempt
  const activeTab = (!showDeveloperUi && tab === 'evidence') || (!shown && tab === 'history') ? 'schema' : tab
  // Results renders its guidance and saved versions into this tab's body.
  const [historySlot, setHistorySlot] = useState<HTMLDivElement | null>(null)
  // The tab names the shown Extraction's lifecycle; its review counts live in the Results header.
  const resultsBadge = shown ? { label: shown.executionStatus.toLowerCase() } : null
  const tabs: {
    key: RailTab
    label: string
    badge?: { label: string } | null
    /** An icon-only tab, so four tabs keep "Results" and its badge whole at the 264px rail. */
    icon?: ReactNode
  }[] = [
    ...(showDeveloperUi
      ? [
          {
            key: 'evidence' as const,
            label: 'Evidence',
            badge: parsedDocument
              ? {
                  label: String(
                    parsedDocument.evidence_index.anchors.length,
                  ),
                }
              : null,
          },
        ]
      : []),
    {
      key: 'schema',
      label: 'Schema',
      badge: schemaFieldCount ? { label: String(schemaFieldCount) } : null,
    },
    { key: 'results', label: 'Results', badge: resultsBadge },
    ...(shown ? [{ key: 'history' as const, label: 'History', icon: (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3l2 1.5" />
      </svg>
    ) }] : []),
  ]

  if (!open) {
    return (
      <div className="flex h-full flex-col items-center">
        <button
          className="flex cursor-pointer items-center justify-center py-3 text-ink-muted outline-none transition-colors hover:text-ink focus-visible:text-ink"
          type="button"
          title="Expand panel"
          onClick={onToggle}
        >
          <PanelToggleIcon side="right" />
        </button>
        <span className="mt-0.5 text-overline font-bold uppercase tracking-[0.14em] text-ink-muted [writing-mode:vertical-rl]">
          {tabs.map(({ label }) => label).join(' · ')}
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="@container flex shrink-0 items-stretch border-b border-line" role="tablist">
        {tabs.map(({ key, label, badge, icon }) => {
          const active = activeTab === key
          return (
            <button
              key={key}
              className={`flex min-w-0 ${icon ? 'flex-none px-3' : 'flex-1 px-1'} cursor-pointer items-center justify-center gap-1.5 border-b-2 pb-2.5 pt-3 text-[13px] font-bold outline-none transition-colors hover:text-ink focus-visible:text-ink ${
                active ? 'border-accent text-ink' : 'border-transparent text-ink-muted'
              }`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`rail-panel-${key}`}
              id={`rail-tab-${key}`}
              onClick={() => onTabChange(key)}
              aria-label={icon ? label : undefined}
              title={icon ? label : undefined}
            >
              {/* At the 264px rail a worded badge shows its number only, so the label stays whole; truncating it is the
                  last resort. The badge keeps one line. */}
              {icon ?? <span className="min-w-0 truncate">{label}</span>}
              {badge && <TabBadge label={badge.label} active={active} />}
            </button>
          )
        })}
        <button
          className="flex cursor-pointer items-center justify-center border-b-2 border-transparent px-2.5 text-ink-muted outline-none transition-colors hover:text-ink focus-visible:text-ink"
          type="button"
          title="Collapse panel"
          onClick={onToggle}
        >
          <PanelToggleIcon side="right" />
        </button>
      </div>

      {/* Status belongs to the latest run, including an unanswered re-run while prior results remain visible. */}
      {extraction.monitorError && <div className="flex shrink-0 flex-col items-start gap-2 border-b border-line px-3 py-3">
        <p role="alert" className="m-0 text-compact text-danger">{extraction.monitorError}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={extraction.reconnect}>Reconnect</Button>
          {extraction.retryAdmission&&<Button onClick={()=>void extraction.retryAdmission?.()}>Retry original request</Button>}
        </div>
      </div>}

      {/* All tab bodies stay mounted so chat drafts and schema edit state survive tab switches. */}
      {showDeveloperUi && (
        <div id="rail-panel-evidence" aria-labelledby="rail-tab-evidence" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={activeTab !== 'evidence'}>
          <EvidenceTab document={parsedDocument} onSelectAnchor={onSelectEvidence} />
        </div>
      )}
      <div id="rail-panel-schema" aria-labelledby="rail-tab-schema" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={activeTab !== 'schema'}>
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
        />
      </div>
      <div id="rail-panel-results" aria-labelledby="rail-tab-results" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={activeTab !== 'results'}>
        {shown ? <DurableResults
          key={`${shown.extractionId}:${inspection.cut ? `${inspection.cut.snapshotVersion}:${inspection.cut.feedbackVersion}` : 'live'}`}
          attempt={shown}
          initialCut={inspection.cut}
          document={parsedDocument}
          documentRevisionId={sourceRepresentationId}
          currentSchema={currentSchemaRevision?.schemaRevisionId ?? null}
          readOnly={inspection.readOnly}
          onEvidence={selectNativeEvidence}
          onResultPathChange={onResultPathChange}
          onFocusEvidence={onFocusEvidence}
          onMarksChange={onMarksChange}
          selectValueRef={selectValueRef}
          headerExtras={resultsHeaderExtras}
          onStatusChange={extraction.acceptDurableStatus}
          onReviewProgress={onReviewProgress}
          onReviewFinalized={onReviewFinalized}
          onPinnedDocument={onPinnedDocument}
          historySlot={historySlot}
          historyShown={activeTab === 'history'}
          onShowResults={() => onTabChange('results')}
          onShowHistory={() => onTabChange('history')}
        /> : <div className="flex h-full min-h-0 flex-col items-center justify-center px-6 text-center">
          <p className="m-0 text-content font-semibold text-ink">No results yet</p>
          <p className="mt-1.5 mb-0 max-w-[34ch] text-compact leading-snug text-ink-muted">
            {schemaReady ? 'Run extraction to apply the schema across the source document.' : 'Generate a schema in the Schema tab first, then run extraction.'}
          </p>
          {!inspection.readOnly && schemaReady && <p className="mt-1.5 mb-0 text-compact font-semibold text-ink">{runUnavailableReason ?? 'Press ▶ Run extraction above.'}</p>}
        </div>}
      </div>
      {shown && <div ref={setHistorySlot} id="rail-panel-history" aria-labelledby="rail-tab-history" role="tabpanel" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto" hidden={activeTab !== 'history'} />}
    </div>
  )
}

export default RightRail
