import { isDeveloperUiEnabled } from './developerUi'
import PanelToggleIcon from './PanelToggleIcon'
// The Annotation and Chat tabs were retired: the Annotation tab's highlight-set
// list and the generic document Chat tab were folded into SchemaPanel's own
// pre-generation chat. Left in place, commented out, rather than deleted.
// import AnnotationSetTab from './AnnotationSidebar'
// import type { AnnotationSetItem } from './AnnotationSidebar'
// import ChatTab from './ChatTab'
import SchemaPanel from './SchemaPanel'
import type { TemplateState } from './SchemaPanel'
import type { SchemaDefinition, SchemaNode } from '../shared/schemaNode'
import ResultsTab from './ResultsTab'
import type { ExtractionController } from './useExtraction'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import EvidenceTab from './EvidenceTab'
import type { ParsedDocument, ParsedEvidenceAnchor } from '../shared/parsedDocument'
import type {
  SchemaRevision,
  SchemaRevisionSummary,
} from '../shared/schemaRevision.contract'

export type RailTab = 'evidence' | 'schema' | 'results'

export type ExtractionInspection = {
  attempt: ExtractionAttempt | null
  readOnly: boolean
  documentMarkdown: string | null
  parsedDocument: ParsedDocument | null
  reviewDecisions: ExtractionAttempt['reviewDecisions']
  pinnedSchema: SchemaDefinition | null
  /** Extraction Schema of the inspected Extraction Result, current or historical. */
  exportSchema: SchemaDefinition | null
}

type RightRailProps = {
  open: boolean
  onToggle: () => void
  tab: RailTab
  onTabChange: (tab: RailTab) => void
  schemaState: TemplateState
  schemaReady: boolean
  schemaFieldCount: number
  onGenerate: (instruction: string) => void
  onCancelGenerate: () => void
  onResetSchema: () => void
  onNodesChange: (
    nodes: SchemaNode[],
    message: string,
    recordDescription?: string,
  ) => void
  beforeSchemaEdit: () => Promise<void>
  schemaHistory: SchemaRevisionSummary[]
  currentSchemaRevisionNumber?: number
  loadSchemaRevision: (schemaRevisionId: string) => Promise<SchemaRevision>
  extraction: ExtractionController
  inspection: ExtractionInspection
  sourceDocumentName: string
  schemaName?: string | null
  onRenameSchema?: (name: string) => Promise<string | null>
  onSelectEvidence: (anchor: ParsedEvidenceAnchor) => void
  onResultPathChange: (path: string[] | null) => void
}

function TabBadge({ label, active, done }: { label: string; active: boolean; done?: boolean }) {
  const tone = done
    ? 'bg-green-soft text-green'
    : `text-accent ${active ? 'bg-accent-soft' : 'bg-accent-ghost'}`
  return (
    <span
      className={`inline-grid h-4 min-w-4.5 place-items-center rounded-full px-1.5 font-mono text-[10px] leading-none tabular-nums ${tone}`}
    >
      {label}
    </span>
  )
}

function RightRail({
  open,
  onToggle,
  tab,
  onTabChange,
  schemaState,
  schemaReady,
  schemaFieldCount,
  onGenerate,
  onCancelGenerate,
  onResetSchema,
  onNodesChange,
  beforeSchemaEdit,
  schemaHistory,
  currentSchemaRevisionNumber,
  loadSchemaRevision,
  extraction,
  inspection,
  sourceDocumentName,
  schemaName,
  onRenameSchema,
  onSelectEvidence,
  onResultPathChange,
}: RightRailProps) {
  const { documentMarkdown, parsedDocument, reviewDecisions } = inspection
  const showDeveloperUi = isDeveloperUiEnabled()
  const activeTab = !showDeveloperUi && tab === 'evidence' ? 'schema' : tab

  const resultsBadge = extraction.hasResults ? { label: '✓', done: true } : null

  const tabs: {
    key: RailTab
    label: string
    badge?: { label: string; done?: boolean } | null
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
        <span className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted [writing-mode:vertical-rl]">
          {tabs.map(({ label }) => label).join(' · ')}
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-stretch border-b border-line" role="tablist">
        {tabs.map(({ key, label, badge }) => {
          const active = activeTab === key
          return (
            <button
              key={key}
              className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 border-b-2 px-1 pb-2.5 pt-3 text-[13px] font-bold outline-none transition-colors hover:text-ink focus-visible:text-ink ${
                active ? 'border-accent text-ink' : 'border-transparent text-ink-muted'
              }`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`rail-panel-${key}`}
              id={`rail-tab-${key}`}
              onClick={() => onTabChange(key)}
            >
              <span>{label}</span>
              {badge && <TabBadge label={badge.label} active={active} done={badge.done} />}
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
      {/* The Annotation tab (highlight-set list) and the generic document Chat
          tab were retired — folded into SchemaPanel's own pre-generation chat.
          Left in place, commented out, rather than deleted.
      <div id="rail-panel-annot" aria-labelledby="rail-tab-annot" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={tab !== 'annot'}>
        <AnnotationSetTab
          items={annotationItems}
          onSelectItem={onSelectAnnotation}
          onRemoveItem={onRemoveAnnotation}
        />
      </div>
      */}
      {showDeveloperUi && (
        <div id="rail-panel-evidence" aria-labelledby="rail-tab-evidence" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={activeTab !== 'evidence'}>
          <EvidenceTab document={parsedDocument} reviewDecisions={reviewDecisions} onSelectAnchor={onSelectEvidence} />
        </div>
      )}
      {/*
      <div id="rail-panel-chat" aria-labelledby="rail-tab-chat" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={tab !== 'chat'}>
        <ChatTab documentMarkdown={documentMarkdown} />
      </div>
      */}
      <div id="rail-panel-schema" aria-labelledby="rail-tab-schema" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={activeTab !== 'schema'}>
        <SchemaPanel
          state={schemaState}
          onGenerate={onGenerate}
          onCancelGenerate={onCancelGenerate}
          onResetSchema={onResetSchema}
          onNodesChange={onNodesChange}
          beforeSchemaEdit={beforeSchemaEdit}
          history={schemaHistory}
          currentRevisionNumber={currentSchemaRevisionNumber}
          loadRevision={loadSchemaRevision}
          documentMarkdown={documentMarkdown}
          sourceDocumentName={sourceDocumentName}
          schemaName={schemaName}
          onRenameSchema={onRenameSchema}
        />
      </div>
      <div id="rail-panel-results" aria-labelledby="rail-tab-results" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={activeTab !== 'results'}>
        <ResultsTab
          key={inspection.attempt?.extractionId ?? 'none'}
          controller={extraction}
          inspectedAttempt={inspection.readOnly ? inspection.attempt ?? undefined : undefined}
          readOnly={inspection.readOnly}
          schemaReady={schemaReady}
          documentMarkdown={documentMarkdown}
          pinnedSchema={inspection.pinnedSchema}
          exportSchema={inspection.exportSchema}
          sourceDocumentName={sourceDocumentName}
          onResultPathChange={onResultPathChange}
          onSelectEvidence={(anchorId) => {
            const anchor = parsedDocument?.evidence_index.anchors.find(
              (candidate) => candidate.anchor_id === anchorId,
            )
            if (anchor) onSelectEvidence(anchor)
          }}
        />
      </div>
    </div>
  )
}

export default RightRail
