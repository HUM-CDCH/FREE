import { lazy, Suspense, useEffect, useState } from 'react'
import ProjectNav from './ProjectNav'
import ProviderConfigPage from './providerConfig/ProviderConfigPage'
import type { NavigableRoute, Route } from './projectNavigation'
import type { DocumentSnapshot } from './projectContexts'
import type { projectContextErrorSchema } from '../shared/projectContext.contract'
import type { z } from 'zod'
import { Button, EmptyState } from './ui'
import type { ProjectBranch, RailTree } from './useRailTree'

const collapsedWidth = 46
const navMin = 150
const navMax = 400
const clampNavWidth = (width: number) =>
  Math.min(navMax, Math.max(navMin, width))

type Failure = z.output<typeof projectContextErrorSchema>

type AppFrameProps = {
  route: Route
  tree: RailTree
  openDocument: DocumentSnapshot | null
  opening: boolean
  failure: Failure | null
  onNavigate: (route: NavigableRoute) => void
  onRetry: () => void
  onInitialResourceLoadFailure: () => void
}

type DevDocument = { pdfUrl: string; filename: string }
const DocumentWorkspace = lazy(() => import('./App'))

function EmptyWorkspace({
  route,
  branch,
  routedDocumentContained,
  failure,
  onRetry,
}: {
  route: Route
  branch: ProjectBranch | undefined
  routedDocumentContained: boolean | null
  failure: Failure | null
  onRetry: () => void
}) {
  let title = 'No Project Context open'
  let description =
    'Choose a Project Context in the rail to browse its Source Documents.'
  let tone: 'neutral' | 'danger' = 'neutral'
  let retry = false

  if (route.kind === 'badReference') {
    title = 'That Project Context reference is invalid'
    description = 'Choose a valid Project Context from the rail.'
    tone = 'danger'
  } else if (route.kind === 'project' || route.kind === 'document') {
    if (branch?.status === 'loading') {
      return (
        <div className="flex h-full flex-col">
          <div className="h-14 shrink-0 border-b border-line bg-surface" />
          <div
            className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-muted"
            aria-busy="true"
          >
            Loading Project Context…
          </div>
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
    <div className="flex h-full flex-col">
      <div className="h-14 shrink-0 border-b border-line bg-surface" />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8">
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
    </div>
  )
}

export default function AppFrame({
  route,
  tree,
  openDocument,
  opening,
  failure,
  onNavigate,
  onRetry,
  onInitialResourceLoadFailure,
}: AppFrameProps) {
  const [navOpen, setNavOpen] = useState(true)
  const [navWidth, setNavWidth] = useState(212)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [providersOpen, setProvidersOpen] = useState(false)
  const [devDocument, setDevDocument] = useState<DevDocument | null>(null)

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!providersOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProvidersOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [providersOpen])

  useEffect(
    () => () => {
      if (devDocument?.pdfUrl.startsWith('blob:'))
        URL.revokeObjectURL(devDocument.pdfUrl)
    },
    [devDocument],
  )

  const effectiveNavOpen = navOpen && viewportWidth >= 860
  const effectiveNavWidth = effectiveNavOpen ? navWidth : collapsedWidth
  const routedProjectContextId =
    route.kind === 'project' || route.kind === 'document'
      ? route.projectContextId
      : null
  const branch = routedProjectContextId
    ? tree.branches[routedProjectContextId]
    : undefined

  // Selection stays on the Source Document that is actually open; the requested
  // one becomes active only once it has opened.
  let activeProjectContextId = tree.activeProjectContextId
  let activeSourceDocumentId = tree.activeSourceDocumentId
  if (devDocument) {
    activeProjectContextId = null
    activeSourceDocumentId = null
  } else if (opening) {
    activeSourceDocumentId =
      openDocument?.sourceDocument.sourceDocumentId ?? null
  }
  const railTree = {
    ...tree,
    activeProjectContextId,
    activeSourceDocumentId,
  }
  // Durable hydration: the PDF, its name, and its Markdown all come from the
  // reopened representation. Rail state, PDF position, focus, and drafts do not.
  const reopenedAttempt = openDocument?.latestAttempt ?? null
  const reopened = openDocument && {
    projectContextId: openDocument.projectContext.projectContextId,
    pdfUrl:
      reopenedAttempt?.sourceRepresentation.resources.sourcePdfUrl ??
      openDocument.sourceRepresentation.resources.sourcePdfUrl,
    filename: openDocument.sourceDocument.name,
    sourceRepresentationId:
      reopenedAttempt?.sourceRepresentationRevisionId ??
      openDocument.sourceRepresentation.sourceRepresentationId,
    markdownUrl:
      reopenedAttempt?.sourceRepresentation.resources.markdownUrl ??
      openDocument.sourceRepresentation.resources.markdownUrl,
    parsedDocumentUrl:
      reopenedAttempt?.sourceRepresentation.resources.parsedDocumentUrl ??
      openDocument.sourceRepresentation.resources.parsedDocumentUrl,
    annotationSet: openDocument.annotationSet,
    extractionSchema:
      reopenedAttempt
        ? {
            ...reopenedAttempt.extractionSchema,
            schemaRevisionId: reopenedAttempt.schemaRevisionId,
          }
        : openDocument.extractionSchema,
    persistedExtraction: reopenedAttempt,
    latestReviewedExtraction: openDocument.latestReviewed,
  }
  const workspace = devDocument
    ? {
        ...devDocument,
        projectContextId: null,
        sourceRepresentationId: null,
        markdownUrl: null,
        parsedDocumentUrl: null,
        annotationSet: null,
        extractionSchema: null,
        persistedExtraction: null,
        latestReviewedExtraction: null,
      }
    : reopened

  function startResize(event: React.MouseEvent) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = navWidth
    const onMove = (moveEvent: MouseEvent) =>
      setNavWidth(clampNavWidth(startWidth + moveEvent.clientX - startX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <main className="flex h-dvh overflow-hidden bg-canvas text-ink">
      {/* React 19 hoists this into <head>; no title-sync effect needed. */}
      <title>
        {workspace ? `FREE Studio — ${workspace.filename}` : 'FREE Studio'}
      </title>
      <div
        style={{ width: effectiveNavWidth }}
        className="flex shrink-0 flex-col border-r border-line bg-surface"
      >
        <div
          className={`flex h-14 shrink-0 items-center gap-2.5 border-b border-line ${
            effectiveNavOpen ? 'justify-start px-4' : 'justify-center px-2'
          }`}
        >
          <img
            src="/free-logo.png"
            alt=""
            className="size-7.5 shrink-0 object-contain"
          />
          {effectiveNavOpen && (
            <h1 className="text-[17px] font-extrabold tracking-[0.06em]">
              FREE
            </h1>
          )}
        </div>
        <aside className="min-h-0 flex-1" aria-label="Project navigation">
          <ProjectNav
            tree={railTree}
            open={effectiveNavOpen}
            onToggle={() => setNavOpen((open) => !open)}
            onNavigate={(nextRoute) => {
              setDevDocument(null)
              onNavigate(nextRoute)
            }}
            onConfigure={() => setProvidersOpen(true)}
            onOpenDevDocument={(sourceDocument) =>
              setDevDocument({
                pdfUrl: URL.createObjectURL(sourceDocument),
                filename: sourceDocument.name,
              })
            }
          />
        </aside>
      </div>
      {effectiveNavOpen && (
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
      <section
        className="relative min-h-0 min-w-0 flex-1"
        aria-label="Source Document"
      >
        {workspace ? (
          <Suspense
            fallback={
              <div aria-busy="true">Loading Source Document…</div>
            }
          >
            {/* Keyed so a different Source Document starts with no carried-over
                annotations, schema draft, focus, or scroll position. */}
            <DocumentWorkspace
              key={workspace.pdfUrl}
              {...workspace}
              onInitialResourceLoadFailure={
                devDocument ? undefined : onInitialResourceLoadFailure
              }
            />
          </Suspense>
        ) : (
          <EmptyWorkspace
            route={route}
            branch={branch}
            routedDocumentContained={tree.routedDocumentContained}
            failure={failure}
            onRetry={onRetry}
          />
        )}
        {opening && (
          <div
            // The whole column dims so the previous Source Document stays
            // readable-in-place but unusable while the next one opens.
            className="absolute inset-0 z-20 flex items-center justify-center bg-canvas/70 backdrop-blur-[1px]"
            aria-busy="true"
            aria-live="polite"
          >
            <p className="rounded-full border border-line bg-surface px-4 py-1.5 text-xs font-medium text-ink-muted shadow-sm">
              Opening Source Document…
            </p>
          </div>
        )}
      </section>
      {providersOpen && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-ink/55 px-4 py-10 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-label="Provider configuration"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setProvidersOpen(false)
          }}
        >
          <ProviderConfigPage onClose={() => setProvidersOpen(false)} />
        </div>
      )}
    </main>
  )
}
