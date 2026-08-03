import { lazy, Suspense, useEffect, useState } from 'react'
import historicalPdfUrl from '../../../examples/1790-06-17-1.pdf?url'
import ellekildePdfUrl from '../../../examples/Beretning_Ellekilde_8_13.pdf?url'
import collagenPdfUrl from '../../../examples/Zhang et al. 2024 - Properties of skin collagen from southern catfish (Silurus meridionalis) fed with raw and cooked food.pdf?url'
import ProjectNav from './ProjectNav'
import ProviderConfigPage from './providerConfig/ProviderConfigPage'
import type { NavigableRoute, Route } from './projectNavigation'
import { EmptyState } from './ui'
import { useRailTree, type ProjectBranch } from './useRailTree'

const collapsedWidth = 46
const navMin = 150
const navMax = 400
const clampNavWidth = (width: number) =>
  Math.min(navMax, Math.max(navMin, width))

type AppFrameProps = {
  route: Route
  onNavigate: (route: NavigableRoute) => void
}

type DevDocument = { pdfUrl: string; filename: string }
const DocumentWorkspace = lazy(() => import('./App'))
// ponytail: seeded demo IDs point at bundled assets; replace this lookup when
// durable Source Document artifact reads land.
const seededPdfUrls: Readonly<Record<string, string>> = {
  '51000000-0000-4000-8001-000000000001': ellekildePdfUrl,
  '51000000-0000-4000-8001-000000000002': historicalPdfUrl,
  '51000000-0000-4000-8001-000000000003': collagenPdfUrl,
}

function EmptyWorkspace({ route, branch }: {
  route: Route
  branch: ProjectBranch | undefined
}) {
  let title = 'No Project Context open'
  let description =
    'Choose a Project Context in the rail to browse its Source Documents.'
  let tone: 'neutral' | 'danger' = 'neutral'

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
    } else {
      title = 'No Source Document open'
      description =
        'Choose a Source Document in the rail to read it, annotate it, and run extraction against it.'
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="h-14 shrink-0 border-b border-line bg-surface" />
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <EmptyState
          className="max-w-sm bg-surface"
          icon="▢"
          title={title}
          description={description}
          tone={tone}
        />
      </div>
    </div>
  )
}

export default function AppFrame({ route, onNavigate }: AppFrameProps) {
  const [navOpen, setNavOpen] = useState(true)
  const [navWidth, setNavWidth] = useState(212)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [providersOpen, setProvidersOpen] = useState(false)
  const [devDocument, setDevDocument] = useState<DevDocument | null>(null)
  // A dev-picked Source Document has no durable identity to mark active.
  const railRoute = devDocument ? ({ kind: 'root' } as const) : route
  const tree = useRailTree(railRoute)

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
  const seededPdfUrl =
    route.kind === 'document' ? seededPdfUrls[route.sourceDocumentId] : undefined
  const routedDocument =
    route.kind === 'document' && branch?.status === 'ready'
      ? branch.detail.sourceDocuments.find(
          (document) => document.sourceDocumentId === route.sourceDocumentId,
        )
      : undefined
  const seededDocument =
    seededPdfUrl && routedDocument
      ? {
          pdfUrl: seededPdfUrl,
          filename: routedDocument.name,
        }
      : null
  const openDocument = devDocument ?? seededDocument

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
            tree={tree}
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
      <section className="min-h-0 min-w-0 flex-1" aria-label="Studio workspace">
        {openDocument ? (
          <Suspense fallback={<div aria-busy="true">Opening Source Document…</div>}>
            <DocumentWorkspace
              pdfUrl={openDocument.pdfUrl}
              filename={openDocument.filename}
              markdownUrl={null}
            />
          </Suspense>
        ) : (
          <EmptyWorkspace route={route} branch={branch} />
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
