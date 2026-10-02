import { isDeveloperUiEnabled } from './developerUi'
import PanelToggleIcon from './PanelToggleIcon'
import SchemaPanel, { type FieldContext } from './SchemaPanel'
import { useState, useSyncExternalStore } from 'react'
import type { SchemaEditorController } from './currentSchemaRevision'
import { enumerateFieldPaths, nodesToTemplate } from 'extraction/schema'
import { countTemplateFields } from '../shared/template'
import ResultsTab, { type RunExtractionStrategy } from './ResultsTab'
import type { ExtractionController } from './useExtraction'
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
  /** Absent when the open view starts no Extraction; Results then offers no run. */
  onRunExtraction?: () => void | Promise<void>
  runExtractionDisabled: boolean
  runExtractionStrategy: RunExtractionStrategy
  inspection: ExtractionInspection
  /** Acknowledged Current Schema Revision, for the Results panel's comparison. */
  currentSchemaRevision: { schemaRevisionId: string; revisionNumber: number } | null
  sourceDocumentName: string
  sourceRepresentationId: string
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
  schema,
  onGenerateInstructions,
  onClearDraft,
  extraction,
  onRunExtraction,
  runExtractionDisabled,
  runExtractionStrategy,
  inspection,
  currentSchemaRevision,
  sourceDocumentName,
  sourceRepresentationId,
  schemaName,
  onRenameSchema,
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

  const schemaSnap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const schemaReady = schemaSnap.view === 'editing'
  const schemaFieldCount = schemaReady
    ? countTemplateFields(nodesToTemplate(schemaSnap.draft!.schemaNodes))
    : 0
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
          fieldContext={fieldContext}
        />
      </div>
      <div id="rail-panel-results" aria-labelledby="rail-tab-results" role="tabpanel" tabIndex={0} className="min-h-0 flex-1" hidden={activeTab !== 'results'}>
        <ResultsTab
          onEditField={editField}
          key={inspection.attempt?.extractionId ?? 'none'}
          controller={extraction}
          onRunExtraction={onRunExtraction}
          runExtractionDisabled={runExtractionDisabled}
          runExtractionStrategy={runExtractionStrategy}
          inspectedAttempt={inspection.readOnly ? inspection.attempt ?? undefined : undefined}
          readOnly={inspection.readOnly}
          schemaReady={schemaReady}
          documentMarkdown={documentMarkdown}
          pinnedSchema={inspection.pinnedSchema}
          exportSchema={inspection.exportSchema}
          currentSchemaRevision={currentSchemaRevision}
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
