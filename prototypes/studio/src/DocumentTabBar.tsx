import ActionsMenu from './ActionsMenu'
import type { DocumentTab } from './useOpenDocumentTabs'
import type { ReactNode } from 'react'

export type DocumentTabBarProps = {
  /** Null until the project's name is known: the chip waits for it. */
  projectName: string | null
  tabs: DocumentTab[]
  activeSourceDocumentId: string | null
  onActivate: (sourceDocumentId: string) => void
  onClose: (sourceDocumentId: string) => void
  onNavigateProject: () => void
  /** Present only when this document was opened from a Batch Extraction's
   *  review grid — offers a direct way back to it. */
  onBackToReviewGrid?: () => void
  /** DocumentWorkspace (App.tsx) portals its run action and transient status
      into this node, so they share the tab-strip row instead of costing a
      second one. */
  slotRef: (element: HTMLDivElement | null) => void
  /** The active tab's review ring slot (results review redesign §2.4), portalled into by DocumentWorkspace. */
  ringSlotRef?: (element: HTMLSpanElement | null) => void
  navigationToggle?: ReactNode
}

/** The open project as a chip before the tabs: the name opens the project's Sources tab; the caret offers "Back to
 *  review grid" when the document came from one, and is a plain mark otherwise. */
function ProjectChip({ name, onNavigateProject, onBackToReviewGrid }: {
  name: string
  onNavigateProject: () => void
  onBackToReviewGrid?: () => void
}) {
  return (
    <div className="flex shrink-0 items-center self-center">
      <button
        type="button"
        className="flex h-7 max-w-48 cursor-pointer items-center rounded-l-[3px] border border-line bg-surface px-2 text-compact font-semibold text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
        aria-label={`Open project ${name}`}
        onClick={onNavigateProject}
      >
        <span className="truncate">{name}</span>
      </button>
      {onBackToReviewGrid ? (
        <ActionsMenu
          label="Project actions"
          align="left"
          trigger={<span aria-hidden="true">▾</span>}
          triggerClassName="rounded-l-none border-l-0"
          items={[{ id: 'grid', label: 'Back to review grid', onSelect: onBackToReviewGrid }]}
        />
      ) : (
        <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-r-[3px] border border-l-0 border-line text-ink-faint">▾</span>
      )}
    </div>
  )
}

/**
 * VS Code-style tab strip for Source Documents open within a Project
 * Context, in one row: the project chip, the tabs, then the workspace's slot.
 */
function DocumentTabBar({
  projectName,
  tabs,
  activeSourceDocumentId,
  onActivate,
  onClose,
  onNavigateProject,
  onBackToReviewGrid,
  slotRef,
  ringSlotRef,
  navigationToggle,
}: DocumentTabBarProps) {
  return (
    // h-14 matches the sidebar logo header (AppFrame.tsx) so the two border-b lines meet at the same height across the
    // divider. On a narrow viewport the row wraps and the slot takes its own line.
    <div className="flex min-h-14 shrink-0 flex-wrap items-end gap-2 border-b border-line bg-surface pl-2 sm:h-14 sm:flex-nowrap">
      {navigationToggle}
      {projectName !== null && (
        <ProjectChip name={projectName} onNavigateProject={onNavigateProject} onBackToReviewGrid={onBackToReviewGrid} />
      )}
      <div
        role="tablist"
        aria-label="Open Source Documents"
        className="scrollbar-subtle flex h-14 min-w-0 flex-1 items-end gap-1 overflow-x-auto sm:h-auto"
      >
      {tabs.map((tab) => {
        const active = tab.sourceDocumentId === activeSourceDocumentId
        return (
          <div
            key={tab.sourceDocumentId}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className={`group flex min-w-0 max-w-52 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-3 py-2 outline-none transition-colors ${
              active
                ? 'bg-canvas text-ink'
                : 'text-ink-muted hover:bg-canvas/60 hover:text-ink'
            }`}
            onClick={() => onActivate(tab.sourceDocumentId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onActivate(tab.sourceDocumentId)
              }
            }}
          >
            <span
              className={`min-w-0 flex-1 truncate text-xs font-medium ${
                active ? 'font-semibold text-ink' : ''
              }`}
              title={tab.name}
            >
              {tab.name}
            </span>
            {/* The ring draws first (order-first); its spoken progress follows the name. */}
            {active && <span ref={ringSlotRef} className="contents" />}
            <button
              type="button"
              aria-label={`Close ${tab.name}`}
              className="shrink-0 rounded-sm text-ink-faint opacity-0 outline-none transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.sourceDocumentId)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
      </div>
      <div
        ref={slotRef}
        className="scrollbar-subtle flex w-full shrink-0 items-center gap-3 self-center overflow-x-auto border-t border-line px-3 py-2 sm:w-auto sm:border-t-0 sm:py-0"
      />
    </div>
  )
}

export default DocumentTabBar
