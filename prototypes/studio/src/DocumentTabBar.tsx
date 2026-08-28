import type { DocumentTab } from './useOpenDocumentTabs'

export type DocumentTabBarProps = {
  projectName: string
  /** The active tab's Source Document name; omitted while none is active. */
  documentName: string | null
  tabs: DocumentTab[]
  activeSourceDocumentId: string | null
  onActivate: (sourceDocumentId: string) => void
  onClose: (sourceDocumentId: string) => void
  onNavigateProject: () => void
  /** DocumentWorkspace (App.tsx) portals its PDF/Extraction controls into
      this node, so they share the tab-strip row instead of costing a
      second one. */
  slotRef: (element: HTMLDivElement | null) => void
}

/**
 * VS Code-style tab strip for Source Documents open within a Project
 * Context, plus the `Project > Document` breadcrumb underneath it.
 */
function DocumentTabBar({
  projectName,
  documentName,
  tabs,
  activeSourceDocumentId,
  onActivate,
  onClose,
  onNavigateProject,
  slotRef,
}: DocumentTabBarProps) {
  return (
    <div className="flex shrink-0 flex-col bg-surface">
      {/* h-14 matches the sidebar logo header (AppFrame.tsx) so the two
          border-b lines meet at the same height across the divider. */}
      <div className="flex min-h-14 flex-wrap items-end gap-1 border-b border-line pl-12 sm:h-14 sm:flex-nowrap sm:pl-1.5">
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
              <button
                type="button"
                aria-label={`Close ${tab.name}`}
                className="shrink-0 rounded-sm text-ink-faint opacity-0 outline-none transition-opacity hover:text-danger focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent group-hover:opacity-100"
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
          className="scrollbar-subtle flex w-[calc(100%+3rem)] shrink-0 -ml-12 items-center gap-3 overflow-x-auto border-t border-line px-3 py-2 sm:ml-0 sm:w-auto sm:border-t-0"
        />
      </div>
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-1.5 border-b border-line px-3 py-1.5 text-[11px]"
      >
        <button
          type="button"
          className="cursor-pointer font-semibold text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
          onClick={onNavigateProject}
        >
          {projectName}
        </button>
        {documentName && (
          <>
            <span aria-hidden="true" className="text-ink-faint">
              ›
            </span>
            <span className="min-w-0 truncate font-medium text-ink">
              {documentName}
            </span>
          </>
        )}
      </nav>
    </div>
  )
}

export default DocumentTabBar
