import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ProjectContextRail } from './projectContexts/ProjectContextRail'
import { StudioHome } from './projectContexts/StudioHome'
import { useProjectContexts } from './projectContexts/useProjectContexts'
import ProviderConfigPage from './providerConfig/ProviderConfigPage'
import DocumentTabBar from './DocumentTabBar'
import PanelToggleIcon from './PanelToggleIcon'
import { useOpenDocumentTabs } from './useOpenDocumentTabs'
import { useShiftWheelHorizontalScroll } from './useShiftWheelHorizontalScroll'
import type { NavigableRoute, Route } from './projectNavigation'
import type { DocumentSnapshot } from './projectContexts/transport'
import type { ProjectContextRouteState } from './projectContexts/useProjectContexts'
import type { projectContextErrorSchema } from '../shared/projectContext.contract'
import type { z } from 'zod'
import RouteLoadBoundary from './RouteLoadBoundary.tsx'
import { Button, EmptyState, ModalDialog, Spinner } from './ui'
import { browserStudioPath } from './studioUrl.js'

const collapsedWidth = 46
const navMin = 150
const navMax = 400
const clampNavWidth = (width: number) =>
  Math.min(navMax, Math.max(navMin, width))

type Failure = z.output<typeof projectContextErrorSchema>

type AppFrameProps = {
  route: Route
  routedProjectContext: ProjectContextRouteState
  openDocument: DocumentSnapshot | null
  opening: boolean
  failure: Failure | null
  onNavigate: (route: NavigableRoute) => void
  onRetry: () => void
  onInitialResourceLoadFailure: () => void
}

const DocumentWorkspace = lazy(() => import('./App'))
const ProjectContextPage = lazy(
  () => import('./projectContexts/ProjectContextPage'),
)

function EmptyWorkspace({
  route,
  branch,
  routedDocumentContained,
  failure,
  onRetry,
}: {
  route: Route
  branch: ProjectContextRouteState['branch']
  routedDocumentContained: boolean | null
  failure: Failure | null
  onRetry: () => void
}) {
  let title = 'That Project Context reference is invalid'
  let description = 'Choose a valid Project Context from the rail.'
  let tone: 'neutral' | 'danger' = 'danger'
  let retry = false

  // A `project` route renders ProjectContextPage and a `root` route renders
  // StudioHome, each owning its own loading and failure copy; only a
  // `document` route joins `badReference` here.
  if (route.kind === 'document') {
    if (branch?.status === 'loading') {
      return (
        <div
          className="flex h-full items-center justify-center text-sm text-ink-muted"
          aria-busy="true"
        >
          Loading Project Context…
        </div>
      )
    }
    if (branch?.status === 'error') {
      title =
        branch.failure.code === 'not_found'
          ? 'That Project Context no longer exists'
          : 'Could not load this Project Context'
      description = branch.failure.message
      tone = 'danger'
    } else if (routedDocumentContained === false) {
      title = 'That Source Document is not in this Project Context'
      description = 'Choose one of its Source Documents in the rail.'
      tone = 'danger'
    } else if (route.kind === 'document' && failure) {
      // Only unavailability can recover; a missing snapshot or a rejected
      // reference stays failed however often it is read again.
      retry =
        failure.code === 'persistence_unavailable' ||
        failure.code === 'source_artifact_unavailable'
      title = retry
        ? 'That Source Document could not be opened'
        : 'That Source Document cannot be reopened'
      description = failure.message
      tone = 'danger'
    } else {
      title = 'No Source Document open'
      description =
        'Choose a Source Document in the rail to read it, annotate it, and run extraction against it.'
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <EmptyState
        className="max-w-sm bg-surface"
        icon="▢"
        title={title}
        description={description}
        tone={tone}
      />
      {retry && (
        <Button variant="secondary" size="md" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

export default function AppFrame({
  route,
  routedProjectContext,
  openDocument,
  opening,
  failure,
  onNavigate,
  onRetry,
  onInitialResourceLoadFailure,
}: AppFrameProps) {
  const [navOpen, setNavOpen] = useState(true)
  const [narrowNavOpen, setNarrowNavOpen] = useState(false)
  const [navWidth, setNavWidth] = useState(212)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [providersOpen, setProvidersOpen] = useState(false)
  const providerTrigger = useRef<HTMLButtonElement>(null)
  const providerInitialFocus = useRef<HTMLButtonElement>(null)
  const [tabBarSlot, setTabBarSlot] = useState<HTMLDivElement | null>(null)
  const resizeControllerRef = useRef<AbortController | null>(null)
  const tabs = useOpenDocumentTabs()
  const { projects } = useProjectContexts()
  useShiftWheelHorizontalScroll()

  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth)
      if (window.innerWidth < 860) setNarrowNavOpen(false)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const narrowViewport = viewportWidth < 860
  // On a narrow viewport the rail is an overlay, so anything that moves the
  // researcher somewhere else also dismisses it.
  const closeNarrowNav = () => setNarrowNavOpen(false)
  const effectiveNavOpen = narrowViewport ? narrowNavOpen : navOpen
  const effectiveNavWidth = effectiveNavOpen
    ? narrowViewport
      ? Math.min(navWidth, viewportWidth - 48)
      : navWidth
    : narrowViewport
      ? 0
      : collapsedWidth
  const { branch: routedBranch, documentContained: routedDocumentContained } =
    routedProjectContext
  const routedProjectContextId =
    route.kind === 'project' || route.kind === 'document'
      ? route.projectContextId
      : null
  // Selection stays on the Source Document that is actually open; the
  // requested one becomes active only once it has opened.
  const selection: NavigableRoute | null =
    opening && route.kind === 'document'
      ? openDocument
        ? {
            kind: 'document',
            projectContextId: openDocument.projectContext.projectContextId,
            sourceDocumentId: openDocument.sourceDocument.sourceDocumentId,
          }
        : {
            kind: 'project',
            projectContextId: route.projectContextId,
            tab: 'sources',
          }
      : route.kind === 'badReference'
        ? null
        : route
  // Durable hydration: the PDF, its name, and its Markdown all come from the
  // reopened representation. Rail state, PDF position, focus, and drafts do not.
  const workspace = useMemo(
    () =>
      openDocument && {
        projectContextId: openDocument.projectContext.projectContextId,
        pdfUrl: openDocument.sourceRepresentation.resources.sourcePdfUrl,
        filename: openDocument.sourceDocument.name,
        sourceRepresentationId:
          openDocument.sourceRepresentation.sourceRepresentationId,
        markdownUrl: openDocument.sourceRepresentation.resources.markdownUrl,
        parsedDocumentUrl:
          openDocument.sourceRepresentation.resources.parsedDocumentUrl,
        // DocumentWorkspace no longer reads annotationSet — the Annotation tab was
        // retired in favor of SchemaPanel's own doc chat. The DB layer still
        // returns it; only this pass-through stopped. Left in place, commented
        // out, rather than deleted.
        // annotationSet: openDocument.annotationSet,
        extractionSchema: openDocument.extractionSchema,
        persistedExtraction: openDocument.latestAttempt,
        latestReviewedExtraction: openDocument.latestReviewed,
        tabBarSlot,
      },
    [openDocument, tabBarSlot],
  )

  // Keeps open tabs in sync with routes reached other than a tab-strip or
  // rail click — a deep link, browser back/forward, or the Project Context
  // page's own document list.
  useEffect(() => {
    if (route.kind !== 'document' || !workspace) return
    if (
      tabs.activeSourceDocumentIdFor(route.projectContextId) ===
      route.sourceDocumentId
    )
      return
    tabs.open(route.projectContextId, route.sourceDocumentId, workspace.filename)
    // `tabs` itself is a fresh object every render; its individual functions
    // are the stable (useCallback) identities this effect actually depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, workspace, tabs.activeSourceDocumentIdFor, tabs.open])

  useEffect(() => () => {
    if (!resizeControllerRef.current) return
    resizeControllerRef.current.abort()
    document.body.style.cursor = ''
  }, [])

  function isRoutedDocument(projectContextId: string, sourceDocumentId: string) {
    return (
      route.kind === 'document' &&
      route.projectContextId === projectContextId &&
      route.sourceDocumentId === sourceDocumentId
    )
  }

  function openSourceDocument(
    projectContextId: string,
    sourceDocumentId: string,
    name: string,
  ) {
    tabs.open(projectContextId, sourceDocumentId, name)
    if (narrowViewport) closeNarrowNav()
    if (!isRoutedDocument(projectContextId, sourceDocumentId))
      onNavigate({ kind: 'document', projectContextId, sourceDocumentId })
  }

  function activateTab(sourceDocumentId: string) {
    if (!routedProjectContextId) return
    tabs.activate(routedProjectContextId, sourceDocumentId)
    if (!isRoutedDocument(routedProjectContextId, sourceDocumentId))
      onNavigate({
        kind: 'document',
        projectContextId: routedProjectContextId,
        sourceDocumentId,
      })
  }

  function closeTab(sourceDocumentId: string) {
    if (!routedProjectContextId) return
    const nextActiveSourceDocumentId = tabs.close(
      routedProjectContextId,
      sourceDocumentId,
    )
    if (!isRoutedDocument(routedProjectContextId, sourceDocumentId)) return
    if (nextActiveSourceDocumentId)
      onNavigate({
        kind: 'document',
        projectContextId: routedProjectContextId,
        sourceDocumentId: nextActiveSourceDocumentId,
      })
    else
      onNavigate({
        kind: 'project',
        projectContextId: routedProjectContextId,
        tab: 'sources',
      })
  }

  const openProjectTabs = routedProjectContextId
    ? tabs.tabsFor(routedProjectContextId)
    : []
  const activeTabSourceDocumentId = routedProjectContextId
    ? tabs.activeSourceDocumentIdFor(routedProjectContextId)
    : null
  const activeProjectName =
    projects.find(
      (project) => project.projectContextId === routedProjectContextId,
    )?.name ?? ''
  const activeDocumentName =
    route.kind === 'document'
      ? (workspace?.filename ??
        openProjectTabs.find(
          (tab) => tab.sourceDocumentId === route.sourceDocumentId,
        )?.name ??
        null)
      : null
  const hasOpenDocumentTabs = Boolean(
    routedProjectContextId && openProjectTabs.length > 0,
  )
  const narrowNavToggle = narrowViewport && !effectiveNavOpen && (
    <button
      className={`grid size-10 shrink-0 place-items-center rounded-md border border-line bg-surface/95 text-ink-muted shadow-sm backdrop-blur outline-none transition-colors hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/40 ${
        hasOpenDocumentTabs ? 'self-center' : 'fixed left-2 top-2 z-30'
      }`}
      type="button"
      aria-label="Open project navigation"
      title="Open project navigation"
      onClick={() => setNarrowNavOpen(true)}
    >
      <PanelToggleIcon side="left" />
    </button>
  )

  function startResize(event: React.MouseEvent) {
    event.preventDefault()
    resizeControllerRef.current?.abort()
    const controller = new AbortController()
    resizeControllerRef.current = controller
    const startX = event.clientX
    const startWidth = navWidth
    const onMove = (moveEvent: MouseEvent) =>
      setNavWidth(clampNavWidth(startWidth + moveEvent.clientX - startX))
    const onUp = () => {
      controller.abort()
      if (resizeControllerRef.current === controller)
        resizeControllerRef.current = null
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove, { signal: controller.signal })
    window.addEventListener('mouseup', onUp, { signal: controller.signal })
  }

  const toggleNav = () => {
    if (!narrowViewport) setNavOpen((open) => !open)
    else setNarrowNavOpen((open) => !open)
  }

  const navigateFromRail = (nextRoute: NavigableRoute) => {
    if (narrowViewport) closeNarrowNav()
    onNavigate(nextRoute)
  }

  return (
    <main className="flex h-dvh overflow-hidden bg-canvas text-ink">
      {/* React 19 hoists this into <head>; no title-sync effect needed. */}
      <title>
        {workspace ? `FREE Studio — ${workspace.filename}` : 'FREE Studio'}
      </title>
      {narrowViewport && effectiveNavOpen && (
        <button
          className="fixed inset-0 z-30 cursor-default bg-ink/45 backdrop-blur-[1px]"
          type="button"
          aria-label="Close project navigation"
          onClick={closeNarrowNav}
        />
      )}
      <div
        style={{ width: effectiveNavWidth }}
        className={`flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface transition-[width] duration-200 motion-reduce:transition-none ${
          narrowViewport
            ? 'fixed inset-y-0 left-0 z-40 shadow-xl'
            : 'relative'
        }`}
      >
        <div
          className={`flex h-14 shrink-0 items-center gap-2.5 border-b border-line ${
            effectiveNavOpen ? 'justify-start px-4' : 'justify-center px-2'
          }`}
        >
          <a
            href={browserStudioPath('/projects')}
            aria-label="Studio home"
            className="outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return
              event.preventDefault()
              if (route.kind !== 'root') navigateFromRail({ kind: 'root' })
            }}
          >
            <img
              src={browserStudioPath('/free-logo.png')}
              alt=""
              className="size-20 shrink-0 -translate-y-1 object-contain"
            />
          </a>
          {/* {effectiveNavOpen && (
            <h1 className="text-[17px] font-extrabold tracking-[0.06em]">
              FREE
            </h1>
          )} */}
          {effectiveNavOpen && (
            <button
              data-rail-toggle
              className="ml-auto cursor-pointer rounded-sm p-1 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
              type="button"
              aria-label="Collapse Project Contexts"
              title="Collapse Project Contexts"
              onClick={toggleNav}
            >
              <PanelToggleIcon side="left" />
            </button>
          )}
        </div>
        <aside className="min-h-0 flex-1" aria-label="Project navigation">
          <ProjectContextRail
            open={effectiveNavOpen}
            selection={selection}
            routedProjectContextId={routedProjectContextId}
            onToggle={toggleNav}
            onNavigate={navigateFromRail}
            onOpenSourceDocument={openSourceDocument}
            onConfigure={(opener) => {
              providerTrigger.current = opener
              setProvidersOpen(true)
            }}
          />
        </aside>
      </div>
      {effectiveNavOpen && !narrowViewport && (
        <div
          className="z-5 -ml-1.25 w-1.25 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
          role="separator"
          aria-label="Resize Project Context rail"
          aria-orientation="vertical"
          aria-valuemin={navMin}
          aria-valuemax={navMax}
          aria-valuenow={navWidth}
          tabIndex={0}
          title="Drag to resize"
          onMouseDown={startResize}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            setNavWidth((width) =>
              clampNavWidth(width + (event.key === 'ArrowLeft' ? -10 : 10)),
            )
          }}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!hasOpenDocumentTabs && narrowNavToggle}
        {routedProjectContextId && openProjectTabs.length > 0 && (
          <DocumentTabBar
            projectName={activeProjectName}
            documentName={activeDocumentName}
            tabs={openProjectTabs}
            activeSourceDocumentId={activeTabSourceDocumentId}
            onActivate={activateTab}
            onClose={closeTab}
            onNavigateProject={() =>
                onNavigate({
                kind: 'project',
                projectContextId: routedProjectContextId,
                tab: 'sources',
              })
            }
            slotRef={setTabBarSlot}
            navigationToggle={narrowNavToggle}
          />
        )}
        <section
          className="relative min-h-0 min-w-0 flex-1"
          aria-label={
            route.kind === 'root'
              ? 'Projects'
              : route.kind === 'project'
                ? 'Project Context'
                : 'Source Document'
          }
        >
          {workspace ? (
            <RouteLoadBoundary
              key="source-document-workspace"
              resource="The Source Document workspace"
            >
              <Suspense
                fallback={
                  <Spinner
                    className="h-full justify-center bg-canvas"
                    ariaLabel="Loading Source Document"
                    label="Loading Source Document…"
                    hint="Preparing the PDF and document index."
                  />
                }
              >
                {/* Keyed to the Project Context, not the Source Document: the
                    Schema panel is a Project Context resource and must survive
                    switching between the project's Source Documents. Switching
                    Project Contexts still starts clean. */}
                <DocumentWorkspace
                  key={workspace.projectContextId}
                  {...workspace}
                  onInitialResourceLoadFailure={onInitialResourceLoadFailure}
                />
              </Suspense>
            </RouteLoadBoundary>
          ) : route.kind === 'project' ? (
            <RouteLoadBoundary
              key="project-context-page"
              resource="The Project Context page"
            >
              <Suspense
                fallback={<div aria-busy="true">Loading Project Context…</div>}
              >
                {/* Keyed to the Project Context only: switching resource tabs
                    is a route change within one page, not a new page. */}
                <ProjectContextPage
                  key={route.projectContextId}
                  projectContextId={route.projectContextId}
                  resource={route}
                  onNavigate={onNavigate}
                  onOpenSourceDocument={openSourceDocument}
                />
              </Suspense>
            </RouteLoadBoundary>
          ) : route.kind === 'root' ? (
            <StudioHome onNavigate={onNavigate} />
          ) : (
            <EmptyWorkspace
              route={route}
              branch={routedBranch}
              routedDocumentContained={routedDocumentContained}
              failure={failure}
              onRetry={onRetry}
            />
          )}
          {opening && (
            <Spinner
              // The whole column dims so the previous Source Document stays
              // readable-in-place but unusable while the next one opens.
              className="absolute inset-0 z-20 justify-center bg-canvas/70 backdrop-blur-[1px]"
              ariaLabel="Loading Source Document"
              label="Loading Source Document…"
              hint="Preparing the PDF and document index."
            />
          )}
        </section>
      </div>
      {providersOpen && (
        <ModalDialog
          className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-4xl overflow-y-auto border-0 bg-transparent p-0 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
          ariaLabel="Provider configuration"
          initialFocusRef={providerInitialFocus}
          returnFocusRef={providerTrigger}
          onDismiss={() => setProvidersOpen(false)}
        >
          <ProviderConfigPage
            initialFocusRef={providerInitialFocus}
            onClose={() => setProvidersOpen(false)}
          />
        </ModalDialog>
      )}
    </main>
  )
}
