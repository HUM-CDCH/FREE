import PanelToggleIcon from './PanelToggleIcon'
import AnnotationSetTab from './AnnotationSidebar'
import type { AnnotationSetItem } from './AnnotationSidebar'
import ChatTab from './ChatTab'
import SchemaPanel from './SchemaPanel'
import type { TemplateState } from './SchemaPanel'
import type { SchemaNode } from '../shared/schemaNode'
import ResultsTab from './ResultsTab'
import type { ExtractionController } from './useExtraction'
import type { AnnotationsMode } from './api'
import EvidenceTab from './EvidenceTab'
import type { ParsedDocumentV2, ParsedEvidenceAnchor } from './parsedDocument'

export type RailTab = 'annot' | 'evidence' | 'chat' | 'schema' | 'results'

type RightRailProps = {
  open: boolean
  onToggle: () => void
  tab: RailTab
  onTabChange: (tab: RailTab) => void
  annotationItems: AnnotationSetItem[]
  onSelectAnnotation: (id: string) => void
  onRemoveAnnotation: (id: string) => void
  schemaState: TemplateState
  schemaStale: boolean
  schemaReady: boolean
  schemaFieldCount: number
  onGenerate: () => void
  onNodesChange: (nodes: SchemaNode[], message: string) => void
  annotationsMode: AnnotationsMode
  onAnnotationsModeChange: (mode: AnnotationsMode) => void
  extraction: ExtractionController
  documentMarkdown: string | null
  parsedDocument: ParsedDocumentV2 | null
  reviewedOccurrenceIdsByAnchor: ReadonlyMap<string, readonly string[]>
  onSelectEvidence: (anchor: ParsedEvidenceAnchor) => void
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
  annotationItems,
  onSelectAnnotation,
  onRemoveAnnotation,
  schemaState,
  schemaStale,
  schemaReady,
  schemaFieldCount,
  onGenerate,
  onNodesChange,
  annotationsMode,
  onAnnotationsModeChange,
  extraction,
  documentMarkdown,
  parsedDocument,
  reviewedOccurrenceIdsByAnchor,
  onSelectEvidence,
}: RightRailProps) {
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
          Annot · Evidence · Chat · Schema · Results
        </span>
      </div>
    )
  }

  const resultsBadge = extraction.hasResults ? { label: '✓', done: true } : null

  const tabs: { key: RailTab; label: string; badge?: { label: string; done?: boolean } | null }[] = [
    {
      key: 'annot',
      label: 'Annot.',
      badge: annotationItems.length ? { label: String(annotationItems.length) } : null,
    },
    { key: 'evidence', label: 'Evidence', badge: parsedDocument ? { label: String(parsedDocument.evidence_index.anchors.length) } : null },
    { key: 'chat', label: 'Chat' },
    { key: 'schema', label: 'Schema', badge: schemaFieldCount ? { label: String(schemaFieldCount) } : null },
    { key: 'results', label: 'Results', badge: resultsBadge },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-stretch border-b border-line" role="tablist">
        {tabs.map(({ key, label, badge }) => {
          const active = tab === key
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
      <div id="rail-panel-annot" aria-labelledby="rail-tab-annot" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={tab !== 'annot'}>
        <AnnotationSetTab
          items={annotationItems}
          onSelectItem={onSelectAnnotation}
          onRemoveItem={onRemoveAnnotation}
        />
      </div>
      <div id="rail-panel-evidence" aria-labelledby="rail-tab-evidence" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={tab !== 'evidence'}>
        <EvidenceTab document={parsedDocument} reviewedOccurrenceIdsByAnchor={reviewedOccurrenceIdsByAnchor} onSelectAnchor={onSelectEvidence} />
      </div>
      <div id="rail-panel-chat" aria-labelledby="rail-tab-chat" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={tab !== 'chat'}>
        <ChatTab documentMarkdown={documentMarkdown} />
      </div>
      <div id="rail-panel-schema" aria-labelledby="rail-tab-schema" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={tab !== 'schema'}>
        <SchemaPanel
          state={schemaState}
          stale={schemaStale}
          onGenerate={onGenerate}
          onNodesChange={onNodesChange}
          annotationCount={annotationItems.length}
          annotationsMode={annotationsMode}
          onAnnotationsModeChange={onAnnotationsModeChange}
          documentMarkdown={documentMarkdown}
        />
      </div>
      <div id="rail-panel-results" aria-labelledby="rail-tab-results" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={tab !== 'results'}>
        <ResultsTab
          controller={extraction}
          schemaReady={schemaReady}
          documentMarkdown={documentMarkdown}
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
