import { isDeveloperUiEnabled } from './developerUi'
import PanelToggleIcon from './PanelToggleIcon'
import SchemaPanel, { type FieldContext, type SchemaPanelProps } from './SchemaPanel'
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SchemaEditorController } from './currentSchemaRevision'
import { enumerateFieldPaths, nodesToTemplate } from 'extraction/schema'
import { countTemplateFields } from '../shared/template'
import ResultsTab from './ResultsTab'
import { DurableResults } from './DurableResults'
import type { ExtractionController } from './useExtraction'
import { resultsBadgeFor } from './resultsBadge'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import EvidenceTab from './EvidenceTab'
import type { SchemaDefinition } from 'extraction/schema'
import type { ParsedDocument, ParsedEvidenceAnchor } from 'extraction/parsed-document'
export type RailTab = 'evidence' | 'schema' | 'results'

export type ExtractionInspection = {
  attempt: ExtractionAttempt | null
  readOnly: boolean
  documentMarkdown: string | null
  parsedDocument: ParsedDocument | null
  reviewDecisions: ExtractionAttempt['reviewDecisions']
  pinnedSchema: (SchemaDefinition & {
    revisionNumber?: number
    schemaRevisionId?: string
  }) | null
  /** Extraction Schema of the inspected Extraction Result, current or historical. */
  exportSchema: SchemaDefinition | null
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
  onSelectEvidence: (anchor: ParsedEvidenceAnchor) => void
  onResultPathChange: (path: string[] | null) => void
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
}: RightRailProps) {
  const [fieldContext, setFieldContext] = useState<FieldContext | null>(null)
  const editField = (nodeId: string, path: (string | number)[]) => {
    const attempt = inspection.attempt
    const pinned = inspection.pinnedSchema
    if (!attempt || !pinned) return
    const node = enumerateFieldPaths(pinned.schemaNodes).find((field) => field.id === nodeId)?.node
    if (!node) return
    schema.closeHistoricalPreview()
    setFieldContext({ extractionId: attempt.extractionId, schemaRevisionId: attempt.schemaRevisionId,
      revisionNumber: pinned.revisionNumber, nodeId, nodeType: node.type, resultPaths: [path] })
    onTabChange('schema')
  }
  const { documentMarkdown, parsedDocument, reviewDecisions } = inspection
  const showDeveloperUi = isDeveloperUiEnabled()
  const activeTab = !showDeveloperUi && tab === 'evidence' ? 'schema' : tab

  // Each Evidence anchor's first page, for the export's Evidence sheet.
  const evidencePages = useMemo(() => new Map(parsedDocument?.evidence_index.anchors.flatMap((anchor) => {
    const page = anchor.producer_observations[0]?.page_number
    return page === undefined ? [] : [[anchor.anchor_id, page] as const]
  }) ?? []), [parsedDocument])
  const schemaSnap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const schemaReady = schemaSnap.view === 'editing'
  const schemaFieldCount = schemaReady
    ? countTemplateFields(nodesToTemplate(schemaSnap.draft!.schemaNodes))
    : 0
  const resultsBadge = resultsBadgeFor(extraction)
  const tabs: {
    key: RailTab
    label: string
    badge?: { label: string } | null
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
  ]

  if (!open) {
    return (
      <div className="flex h-full flex-col items-center">
        <button
          className="flex cursor-pointer items-center justify-center py-3 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
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
        {tabs.map(({ key, label, badge }) => {
          const active = activeTab === key
          return (
            <button
              key={key}
              className={`flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 border-b-2 px-1 pb-2.5 pt-3 text-[13px] font-bold outline-none transition-colors hover:text-ink focus-visible:text-ink ${
                active ? 'border-accent text-ink' : 'border-transparent text-ink-muted'
              }`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`rail-panel-${key}`}
              id={`rail-tab-${key}`}
              onClick={() => onTabChange(key)}
            >
              {/* At the 264px rail a worded badge shows its number only, so the label stays whole; truncating it is the
                  last resort. The badge keeps one line. */}
              <span className="min-w-0 truncate">{label}</span>
              {badge && <TabBadge label={badge.label} active={active} />}
            </button>
          )
        })}
        <button
          className="flex cursor-pointer items-center justify-center border-b-2 border-transparent px-2.5 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
          type="button"
          title="Collapse panel"
          onClick={onToggle}
        >
          <PanelToggleIcon side="right" />
        </button>
      </div>

      {/* All tab bodies stay mounted so chat drafts and schema edit state survive tab switches. */}
      {showDeveloperUi && (
        <div id="rail-panel-evidence" aria-labelledby="rail-tab-evidence" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={activeTab !== 'evidence'}>
          <EvidenceTab document={parsedDocument} reviewDecisions={reviewDecisions} onSelectAnchor={onSelectEvidence} />
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
          fieldContext={fieldContext}
        />
      </div>
      <div id="rail-panel-results" aria-labelledby="rail-tab-results" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={activeTab !== 'results'}>
        <DurableResults
          key={(inspection.attempt ?? extraction.attempt)?.extractionId ?? 'none'}
          attempt={inspection.attempt ?? extraction.attempt}
          document={parsedDocument}
          currentSchema={currentSchemaRevision?.schemaRevisionId ?? null}
          readOnly={inspection.readOnly}
          onEvidence={id=> {const anchor=parsedDocument?.evidence_index.anchors.find(a=>a.anchor_id===id);if(anchor)onSelectEvidence(anchor)}}
          fallback={<ResultsTab
          onEditField={editField}
          key={inspection.attempt?.extractionId ?? 'none'}
          controller={extraction}
          inspectedAttempt={inspection.readOnly ? inspection.attempt ?? undefined : undefined}
          readOnly={inspection.readOnly}
          schemaReady={schemaReady}
          documentMarkdown={documentMarkdown}
          pinnedSchema={inspection.pinnedSchema}
          exportSchema={inspection.exportSchema}
          currentSchemaRevision={currentSchemaRevision}
          runUnavailableReason={runUnavailableReason}
          sourceDocumentName={sourceDocumentName}
          evidencePages={evidencePages}
          onResultPathChange={onResultPathChange}
          headerExtras={resultsHeaderExtras}
          onSelectEvidence={(anchorId) => {
            const anchor = parsedDocument?.evidence_index.anchors.find(
              (candidate) => candidate.anchor_id === anchorId,
            )
            if (anchor) onSelectEvidence(anchor)
          }}
        />}/>
      </div>
    </div>
  )
}

export default RightRail
