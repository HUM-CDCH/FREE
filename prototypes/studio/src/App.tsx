import {
  authenticatedFetch,
  reportAuthenticationRequired,
} from './auth/authenticatedFetch.ts'
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { PDFViewer, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PDFViewerOptions } from 'pdfjs-dist/types/web/pdf_viewer'
import RightRail from './RightRail'
import type { RailTab } from './RightRail'
import { useDurableCurrentSchemaRevision } from './useCurrentSchemaRevision'
import { SchemaSaveStatus } from './SchemaSaveStatus'
import { deleteModelOperation, requestSchema } from './api'
import {
  decodeParsedDocument,
  type ParsedDocument,
} from 'extraction/parsed-document'
import { useEvidenceOverlays } from './useEvidenceOverlays'
import { METHOD_CHANGED, useExtraction } from './useExtraction'
import { resultsBadgeFor } from './resultsBadge'
import { useToast } from './useToast'
import { savedMethodFor, useSavedMethod } from './savedMethod'
import type { ExtractionAttempt, ExtractionStrategy } from '../shared/extraction.contract'
import { Button, Spinner, Toast } from './ui'
import { PageNavigation } from './PageNavigation'
import { createThumbnailRenderer } from './PageThumbnails'
import PagePager from './PagePager'
import { AnnotationEditorType, AnnotationMode } from 'pdfjs-dist'
import type { DocumentSnapshot } from './projectContexts/transport'
import { getSchemaRevision, renameExtractionSchema } from './schemaRevisions'
import { defaultSchemaName } from './schemaNames'
import { strategyOf, type SchemaDefinition } from 'extraction/schema'
import { browserStudioPath } from './studioUrl.js'
import { CATALOG_RECIPES } from '../shared/catalogRecipes.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const COLLAPSED_WIDTH = 46
const RAIL_MIN = 264
const RAIL_MAX = 560
const ANNOTATION_HIGHLIGHT_COLORS = 'annotation=#FFF066'

// Highlight-on-selection is temporarily disabled: pdf.js's HIGHLIGHT editor
// mode calls `selection.empty()` on mouseup to turn a text selection into a
// highlight annotation, which left nothing for the browser's native copy to
// act on. Flip this back to true to restore highlight creation once that's
// worth the copy/paste tradeoff again.
const HIGHLIGHT_ANNOTATIONS_ENABLED = false

// Mirrors the target check in pdf.js's free-highlight pointerdown handler
// (AnnotationEditorLayer #textLayerPointerDown): the text-layer background
// and its non-text children.
function isFreeHighlightTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false
  }

  const textLayer = target.closest('.textLayer')
  if (!textLayer) {
    return false
  }

  return (
    target === textLayer ||
    target.getAttribute('role') === 'img' ||
    target.classList.contains('endOfContent') ||
    target.classList.contains('textLayerImages') ||
    target.classList.contains('textLayerImagePlaceholder')
  )
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  )
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; pageCount: number }
  | { status: 'error'; message: string }

// The parsing service's Markdown index of the current document, built on upload.
type DocIndex =
  | { status: 'parsing' }
  | { status: 'ready'; markdown: string; document: ParsedDocument | null }
  | { status: 'error'; message: string }

async function readMarkdown(url: string, signal: AbortSignal): Promise<string> {
  const response = await authenticatedFetch(url, { signal })
  if (!response.ok)
    throw new Error(
      `Could not fetch Source Document Markdown (HTTP ${response.status}).`,
    )
  return response.text()
}

async function readParsedDocument(
  url: string,
  signal: AbortSignal,
): Promise<ParsedDocument> {
  const response = await authenticatedFetch(url, { signal })
  if (!response.ok)
    throw new Error(
      `Could not fetch parsed Source Document (HTTP ${response.status}).`,
    )
  return decodeParsedDocument(await response.json())
}

export type DocumentWorkspaceProps = {
  pdfUrl: string
  filename: string
  projectContextId: string
  sourceRepresentationId: string
  /** Whether `sourceRepresentationId` is the Source Document's current Source
      Representation Revision. An Extraction opened on an earlier one starts no
      new run: a run posts the open revision, and the document route shows
      attempts on its current one only. */
  sourceRepresentationCurrent: boolean
  markdownUrl: string
  parsedDocumentUrl: string
  extractionSchema: DocumentSnapshot['extractionSchema']
  persistedExtraction: DocumentSnapshot['latestAttempt']
  latestReviewedExtraction?: DocumentSnapshot['latestReviewed']
  onOpenExtraction: (extractionId: string) => void
  /** Only the loader sees a retained resource fail; reported once, on open. */
  onInitialResourceLoadFailure?: () => void
  /** A run was refused because reprocessing superseded this Source Representation: read the document again, and
      keep this workspace if that read fails. */
  onSourceSuperseded?: () => void
  /** DocumentTabBar's (AppFrame.tsx) trailing slot, in its own tab-strip row —
      portalled into so the PDF controls share that row instead of a second one. */
  tabBarSlot?: HTMLElement | null
  /** How long the first generation's automatic name may wait for its answer before the renames queued behind it go
      ahead (default 20 s; tests shorten it). */
  automaticRenameTimeoutMs?: number
}

/** An admission refusal useExtraction reported through `onMethodChanged`: nothing was started. */
type RunRefusal = { message: string; code: string }

type PinnedAttemptSchema = SchemaDefinition & {
  schemaRevisionId: string
  revisionNumber: number
}

export function DocumentWorkspace({
  pdfUrl,
  filename,
  projectContextId,
  sourceRepresentationId,
  sourceRepresentationCurrent,
  markdownUrl,
  parsedDocumentUrl,
  extractionSchema,
  persistedExtraction,
  latestReviewedExtraction = null,
  onOpenExtraction,
  onInitialResourceLoadFailure,
  onSourceSuperseded,
  tabBarSlot = null,
  automaticRenameTimeoutMs = 20_000,
}: DocumentWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const pdfViewerRef = useRef<PDFViewer | null>(null)
  const activeSourceRepresentationIdRef = useRef(sourceRepresentationId)
  useEffect(() => {
    activeSourceRepresentationIdRef.current = sourceRepresentationId
  }, [sourceRepresentationId])

  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [zoomPercent, setZoomPercent] = useState(100)
  const { toast, showToast, dismissToast, holdToast, consumeSwitch } = useToast()
  const schema = useDurableCurrentSchemaRevision({
    projectContextId,
    extractionSchema,
    debounceMs: 1500,
    sourceRepresentationId,
    onCommitMessage: (message) => showToast(message),
  })
  const schemaSnap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const [schemaName, setSchemaName] = useState(extractionSchema?.name ?? null)
  // Renames of the schema run one at a time, in the order they were asked for, so the server keeps the last one asked;
  // each records the server's answer and shows it unless a later rename has started, which shows its own. A late
  // first-generation name can then never replace a rename the researcher made meanwhile (on screen or on the server).
  const renameQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const renameSequenceRef = useRef(0)
  const durableSchemaNameRef = useRef(extractionSchema?.name ?? null)
  /** Renames the schema; null on success, else why not. `unchangedName` is the server's name should this rename fail
   *  (the first generation's, which the server created before naming it). With `timeoutMs` the request is given up
   *  (aborted, so it fails) once it has waited that long for its answer, and the queue goes on with the next rename: a
   *  stalled automatic name never strands the researcher's rename behind it. Giving up stops the waiting, not
   *  necessarily the server, which may still apply the abandoned name after the next one. The queue makes that unlikely
   *  (the next rename is sent only once this one is given up on) but cannot exclude it. */
  function renameSchema(extractionSchemaId: string, name: string, unchangedName?: string, timeoutMs?: number): Promise<string | null> {
    const sequence = ++renameSequenceRef.current
    const request = renameQueueRef.current.then(() => {
      if (timeoutMs === undefined) return renameExtractionSchema(projectContextId, extractionSchemaId, name)
      // Counted from when the request is sent, not from when it joined the queue.
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), timeoutMs)
      return renameExtractionSchema(projectContextId, extractionSchemaId, name, abort.signal).finally(() => clearTimeout(timer))
    })
    renameQueueRef.current = request.catch(() => undefined)
    const latest = () => sequence === renameSequenceRef.current
    return request.then(
      (renamed) => {
        durableSchemaNameRef.current = renamed.name
        if (latest()) setSchemaName(renamed.name)
        return null
      },
      (error: unknown) => {
        if (unchangedName !== undefined) durableSchemaNameRef.current = unchangedName
        if (latest()) setSchemaName(durableSchemaNameRef.current)
        return error instanceof Error ? error.message : 'Schema could not be renamed.'
      },
    )
  }
  const [savingForRun, setSavingForRun] = useState(false)
  // The page the viewer shows (pdf.js `pagechanging`).
  const [currentPage, setCurrentPage] = useState(1)
  const [pagesOpen, setPagesOpen] = useState(true)
  const pageNavigationId = useId()
  const pagesToggleRef = useRef<HTMLButtonElement>(null)
  // Article or Catalog is the schema's own saved record scope (the Current Schema Revision's, or the choice its next
  // save declares); null until one is chosen. The selector never changes the strategy of an active or persisted attempt.
  const nextExtractionStrategy: ExtractionStrategy | null =
    schemaSnap.recordScope === null ? null : strategyOf(schemaSnap.recordScope)
  // Generic Catalog only, a one-shot per-run method choice: '' keeps generic model discovery of record boundaries.
  const [nextCatalogRecipe, setNextCatalogRecipe] = useState('')
  const [railOpen, setRailOpen] = useState(true)
  const [railWidth, setRailWidth] = useState(344)
  const [railTab, setRailTab] = useState<RailTab>('schema')
  const [resultPath, setResultPath] = useState<string[] | null>(null)
  const [selectedInspectionId, setSelectedInspectionId] = useState<string | null>(persistedExtraction?.extractionId ?? null)
  // Extraction Schemas keyed by Schema Revision id, so any attempt — active,
  // restored, or historical — resolves the exact revision it ran with.
  const reopenedSchemas = useMemo(() => {
    const known: Record<string, PinnedAttemptSchema> = {}
    for (const reopenedAttempt of [persistedExtraction, latestReviewedExtraction])
      if (reopenedAttempt)
        known[reopenedAttempt.schemaRevisionId] = {
          schemaRevisionId: reopenedAttempt.schemaRevisionId,
          revisionNumber: reopenedAttempt.extractionSchema.revisionNumber,
          recordDescription: reopenedAttempt.extractionSchema.recordDescription,
          schemaNodes: reopenedAttempt.extractionSchema.schemaNodes,
        }
    return known
  }, [persistedExtraction, latestReviewedExtraction])
  const [knownSchemas, setKnownSchemas] = useState(reopenedSchemas)
  // A run started here offers "Review now" once it succeeds; restored or reconnected runs only say they finished. The
  // run is "started here" from the request on: `admittingRef` while its admission is awaited (an admission already
  // finished reaches onTerminal inside that await), then `pendingReportRef` by its identity.
  const pendingReportRef = useRef<string | null>(null)
  const admittingRef = useRef(false)
  const [docIndex, setDocIndex] = useState<DocIndex>({ status: 'parsing' })
  const resizeControllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    if (!resizeControllerRef.current) return
    resizeControllerRef.current.abort()
    document.body.style.cursor = ''
  }, [])

  // Reset before children render so the previous document never flashes while
  // the effects below tear down its viewer and start the next reads.
  const [renderedSourceRepresentationId, setRenderedSourceRepresentationId] =
    useState(sourceRepresentationId)
  if (renderedSourceRepresentationId !== sourceRepresentationId) {
    setRenderedSourceRepresentationId(sourceRepresentationId)
    setLoadState({ status: 'loading' })
    setZoomPercent(100)
    setNextCatalogRecipe('')
    setSelectedInspectionId(persistedExtraction?.extractionId ?? null)
    setKnownSchemas(reopenedSchemas)
    setResultPath(null)
    if (toast?.outlivesSwitch) consumeSwitch()
    else dismissToast()
    setDocIndex({ status: 'parsing' })
  }

  const indexing = docIndex.status === 'parsing'
  const documentMarkdown = docIndex.status === 'ready' ? docIndex.markdown : null
  const parsedDocument = docIndex.status === 'ready' ? docIndex.document : null
  const setContainerNode = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node
  }, [])

  const setViewerNode = useCallback((node: HTMLDivElement | null) => {
    viewerRef.current = node
  }, [])

  useEffect(() => {
    const container = containerRef.current
    const viewer = viewerRef.current
    if (!container || !viewer) {
      return
    }

    const abortController = new AbortController()
    const eventBus = new EventBus()

    const viewerOptions: PDFViewerOptions = {
      container,
      viewer,
      eventBus,
      annotationMode: AnnotationMode.ENABLE,
      annotationEditorMode: HIGHLIGHT_ANNOTATIONS_ENABLED
        ? AnnotationEditorType.HIGHLIGHT
        : AnnotationEditorType.NONE,
      annotationEditorHighlightColors: ANNOTATION_HIGHLIGHT_COLORS,
    }

    // pdfjs-dist 6 supports abortSignal at runtime, but its PDFViewerOptions type omits it.
    const abortableViewerOptions = {
      ...viewerOptions,
      abortSignal: abortController.signal,
    }

    const pdfViewer = new PDFViewer(abortableViewerOptions)

    // pdf.js starts a free (rectangular) highlight from pointerdown on blank
    // text-layer areas; intercept those during capture, before its own
    // text-layer listener, so only text selections can create highlights.
    // Moot while highlight creation is disabled, but kept alongside the flag
    // so re-enabling HIGHLIGHT_ANNOTATIONS_ENABLED restores this too.
    if (HIGHLIGHT_ANNOTATIONS_ENABLED) {
      container.addEventListener(
        'pointerdown',
        (event) => {
          if (isFreeHighlightTarget(event.target)) {
            event.preventDefault()
            event.stopPropagation()
          }
        },
        { capture: true, signal: abortController.signal },
      )
    }

    const syncZoom = ({ scale }: { scale: number }) => {
      setZoomPercent(Math.round(scale * 100))
    }
    eventBus.on('scalechanging', syncZoom, { signal: abortController.signal })
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => setCurrentPage(pageNumber),
      { signal: abortController.signal })
    setCurrentPage(1)

    container.addEventListener(
      'wheel',
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return
        event.preventDefault()
        // Ctrl/Cmd + wheel zooms around the cursor; trackpad pinch arrives
        // as ctrlKey wheel events with small deltas, so scale smoothly.
        const lineHeight = event.deltaMode === 1 ? 25 : event.deltaMode === 2 ? 120 : 1
        pdfViewer.updateScale({
          scaleFactor: Math.exp(-event.deltaY * 0.0015 * lineHeight),
          origin: [event.clientX, event.clientY],
        })
      },
      { signal: abortController.signal, passive: false },
    )
    document.addEventListener(
      'keydown',
      (event) => {
        if (isEditableTarget(event.target)) return
        const key = event.key
        if (key === '+' || key === '=' || key === 'Add') {
          event.preventDefault()
          pdfViewer.increaseScale()
        } else if (key === '-' || key === 'Subtract') {
          event.preventDefault()
          pdfViewer.decreaseScale()
        } else if (key === '0' || key === 'Numpad0') {
          event.preventDefault()
          pdfViewer.currentScale = 1
        }
      },
      { signal: abortController.signal },
    )

    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null
    pdfViewerRef.current = pdfViewer
    setLoadState({ status: 'loading' })

    async function loadPdf() {
      try {
        loadingTask = pdfjsLib.getDocument({
          url: browserStudioPath(pdfUrl),
          wasmUrl: browserStudioPath('/assets/pdfjs-wasm/'),
        })
        const pdf = await loadingTask.promise
        if (abortController.signal.aborted) {
          return
        }

        setPdfDocument(pdf)
        pdfViewer.setDocument(pdf)
        // setDocument initializes page views asynchronously. Setting a scale
        // before the first page exists makes pdf.js try (and fail) to scroll
        // to page 1 while updating the scale.
        await pdfViewer.firstPagePromise
        if (abortController.signal.aborted) {
          return
        }

        // The base scale stays unset until something calls setScale; pin it to
        // the current (100%) value so updateScale() has a valid baseline.
        if (!pdfViewer.currentScaleValue) {
          pdfViewer.currentScaleValue = String(pdfViewer.currentScale)
        }
        setZoomPercent(Math.round(pdfViewer.currentScale * 100))
        setLoadState({ status: 'ready', pageCount: pdf.numPages })
      } catch (error) {
        if (abortController.signal.aborted) {
          return
        }

        if (error instanceof pdfjsLib.ResponseException && error.status === 401)
          reportAuthenticationRequired()
        setLoadState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to load the PDF.',
        })
        onInitialResourceLoadFailure?.()
      }
    }

    void loadPdf()

    return () => {
      pdfViewerRef.current = null
      setPdfDocument(null)
      // Runtime setDocument(null) clears viewer state, but the shipped type omits null.
      ;(pdfViewer.setDocument as (pdfDocument: pdfjsLib.PDFDocumentProxy | null) => void).call(
        pdfViewer,
        null,
      )
      abortController.abort()
      if (loadingTask) void loadingTask.destroy()
    }
  }, [onInitialResourceLoadFailure, pdfUrl])

  const thumbnails = useMemo(() => (pdfDocument ? createThumbnailRenderer(pdfDocument) : null), [pdfDocument])
  useEffect(() => () => thumbnails?.dispose(), [thumbnails])

  // Read the retained canonical index separately from the viewer so it never
  // reloads the PDF or clears annotations.
  useEffect(() => {
    const abortController = new AbortController()

    void (async () => {
      setDocIndex({ status: 'parsing' })
      try {
        const parsed = await Promise.all([
          readMarkdown(markdownUrl, abortController.signal),
          readParsedDocument(parsedDocumentUrl, abortController.signal),
        ]).then(([markdown, document]) => ({ markdown, document }))
        if (!abortController.signal.aborted) {
          setDocIndex({ status: 'ready', markdown: parsed.markdown, document: parsed.document })
        }
      } catch (error) {
        if (abortController.signal.aborted) return
        setDocIndex({
          status: 'error',
          message: error instanceof Error ? error.message : 'Document indexing failed.',
        })
        onInitialResourceLoadFailure?.()
      }
    })()

    return () => abortController.abort()
  }, [markdownUrl, onInitialResourceLoadFailure, parsedDocumentUrl])


  // Front-end reset only: the durable schema remains the save target, while
  // the editor returns to its ungenerated state.
  async function resetSchema() {
    try {
      await schema.reset()
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : 'Could not save the Current Schema Revision.',
      )
      throw error
    }
  }

  async function handleGenerate(instruction: string) {
    if (indexing) {
      showToast('Document is still being indexed…')
      return
    }
    const hadSchema = schemaSnap.extractionSchemaId !== null
    // The tab's acknowledged head is the base: a reloaded page saves this generation only while it is still current.
    const acknowledged = schema.snapshot().save?.acknowledged ?? null
    const operationId = crypto.randomUUID() // a new user action, a new ID (spec, *Client IDs*)
    await schema.generate(async (signal, declareSourceCoverage) => {
      const done = await requestSchema(
        {
          projectContextId,
          sourceRepresentationRevisionId: sourceRepresentationId,
        },
        signal,
        {
          instruction,
          operationId,
          base: acknowledged && { extractionSchemaId: acknowledged.extractionSchemaId, schemaRevisionId: acknowledged.schemaRevisionId },
        },
      )
      declareSourceCoverage(done.sourceCoverage)
      return done.template
    },
      // Stop cancels the workflow; leaving the page only detaches (the controller's dispose).
      { cancel: () => deleteModelOperation(`suggestion:${operationId}`) },
    )
    // The first successful generation initializes the Extraction Schema; it is named after its Source Document (§5).
    if (!hadSchema) {
      const extractionSchemaId = schema.snapshot().extractionSchemaId
      if (extractionSchemaId) {
        const name = defaultSchemaName(filename)
        setSchemaName(name)
        void renameSchema(extractionSchemaId, name, 'Extraction Schema', automaticRenameTimeoutMs)
      }
    }
  }

  function handleClipboard(event: React.ClipboardEvent<HTMLElement>) {
    if (
      isEditableTarget(event.target) ||
      (event.type !== 'paste' && !window.getSelection()?.isCollapsed)
    ) {
      event.stopPropagation()
      return
    }
    if (event.type === 'paste' && event.clipboardData.types.includes('application/pdfjs')) return
    if (event.type !== 'paste' && event.target instanceof Element && event.target.closest('.pdfViewer')) return
    event.stopPropagation()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (!isEditableTarget(event.target)) return
    const modifier = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (['backspace', 'delete'].includes(key) || (modifier && ['a', 'z', 'y'].includes(key))) {
      event.stopPropagation()
    }
  }

  function startResize(event: React.MouseEvent) {
    event.preventDefault()
    resizeControllerRef.current?.abort()
    const controller = new AbortController()
    resizeControllerRef.current = controller
    const startX = event.clientX
    const startWidth = railWidth
    const onMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX
      setRailWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, startWidth - dx)))
    }
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

  const schemaReady = schemaSnap.view === 'editing'
  //
  // const schemaStale =
  //   templateState.status === 'ready' &&
  //   templateState.inputsKey !== annotationInputsKey(annotationItems, annotationsMode)

  const effectiveRailOpen = railOpen
  const effectiveRailWidth = effectiveRailOpen ? railWidth : COLLAPSED_WIDTH

  // The account's saved method: a run re-reads it at the click and submits that, and admission refuses it if an Apply
  // changed it since.
  const saved = useSavedMethod()
  // The last refusal useExtraction reported for the run in flight; runExtraction reads it after a null acknowledgement.
  const refusalRef = useRef<RunRefusal | null>(null)
  // Whether the account's last ready saved method is the unified Catalog. A run's re-read puts `saved.state` through
  // `loading`, so the Boundaries choice follows this, not the live state, and does not flicker on every click. State
  // adjusted during render, not a ref: a ref may not be read while rendering.
  const [lastReadyUnifiedCatalog, setLastReadyUnifiedCatalog] = useState(false)
  if (saved.state.status === 'ready' && (saved.state.unifiedCatalog === true) !== lastReadyUnifiedCatalog)
    setLastReadyUnifiedCatalog(saved.state.unifiedCatalog === true)
  const reviewTarget = sourceRepresentationId
    ? { sourceRepresentationId, schemaRevisionId: schemaSnap.extractableSchemaRevisionId }
    : null
  // Nothing started. The refresh either keeps this Source Representation, now no longer current (Run is then
  // disabled), or moves to the reprocessed one; either way the notice outlives that switch.
  const onSuperseded = () => {
    showToast('This document has been reprocessed — no new Extraction was started', {
      outlivesSwitch: true,
      durationMs: 6000,
    })
    onSourceSuperseded?.()
  }
  /** The completion notice (decision 04): one toast, no dialog. With `reviewNow` (a run started here that succeeded) it
   *  offers "Review now", which opens the Results tab, and stays eight seconds. */
  function showCompletion(isRerun: boolean, reviewNow: boolean) {
    showToast(
      isRerun ? '↻ Re-run complete — review it in the Results tab' : '✓ Extraction complete — review it in the Results tab',
      reviewNow ? { durationMs: 8000, action: { label: 'Review now', onAction: () => setRailTab('results') } } : undefined,
    )
  }
  const extraction = useExtraction({
    schemaReady,
    indexing,
    initialAttempt: persistedExtraction,
    documentKey: sourceRepresentationId,
    reviewTarget,
    // Completion preserves the rail tab and inspected snapshot; it says so in one toast, whose "Review now" (a run started
    // here that succeeded) opens Results.
    onTerminal: (attempt, isRerun) => {
      // While a run started here is being admitted, the only monitor that can finish is that run's own: starting it
      // stopped any other.
      const reported = admittingRef.current || pendingReportRef.current === attempt.extractionId
      if (reported) pendingReportRef.current = null
      selectNextRunAfter(attempt)
      if (attempt.failure?.code === 'cancelled')
        showToast('Extraction cancelled — no result was saved')
      else if (attempt.executionStatus === 'FAILED')
        showToast('Extraction failed — see details in Results')
      else
        showCompletion(isRerun, reported && attempt.outcome === 'SUCCEEDED')
    },
    onError: () => showToast('Extraction failed — see details in Results'),
    onSuperseded,
    onMethodChanged: (message, code) => {
      refusalRef.current = { message, code }
    },
  })

  /**
   * The one-shot boundaries choice for the next run once `attempt` is acknowledged or has ended: a failed Catalog
   * attempt is run again with its own recipe; anything else returns to model discovery. Article or Catalog itself is
   * the schema's saved record scope and never resets.
   */
  function selectNextRunAfter(attempt: ExtractionAttempt) {
    const repeat = attempt.executionStatus === 'FAILED' && attempt.strategy === 'CATALOG'
    setNextCatalogRecipe(repeat ? attempt.catalogRecipe ?? '' : '')
  }

  // The Current Schema Revision is the acknowledged durable revision; unsaved
  // editor changes never move it, so they cannot mark a result as previous.
  const acknowledgedRevision = schemaSnap.save?.acknowledged ?? extractionSchema
  const currentSchemaRevision = useMemo(
    () => acknowledgedRevision
      ? {
          schemaRevisionId: acknowledgedRevision.schemaRevisionId,
          revisionNumber: acknowledgedRevision.revisionNumber,
        }
      : null,
    [acknowledgedRevision],
  )

  const latestAttempt = extraction.attempt
  const running =
    latestAttempt?.executionStatus === 'QUEUED' ||
    latestAttempt?.executionStatus === 'RUNNING'
  const reviewedOnAnotherSource = latestReviewedExtraction &&
    latestReviewedExtraction.sourceRepresentationRevisionId !== sourceRepresentationId
  const inspectionChoices = latestAttempt && latestReviewedExtraction && !reviewedOnAnotherSource && latestAttempt.extractionId !== latestReviewedExtraction.extractionId
    ? [
        { extractionId: latestAttempt.extractionId, label: 'Latest attempt' },
        { extractionId: latestReviewedExtraction.extractionId, label: 'Latest reviewed' },
      ]
    : []
  const pinnedAttempt = !reviewedOnAnotherSource && selectedInspectionId === latestReviewedExtraction?.extractionId
    ? latestReviewedExtraction
    : null
  const inspectedAttempt = pinnedAttempt ?? latestAttempt
  const inspectionReadOnly = Boolean(inspectedAttempt && latestAttempt && inspectedAttempt.extractionId !== latestAttempt.extractionId)
  const inspectedAttemptSchema =
    inspectedAttempt ? knownSchemas[inspectedAttempt.schemaRevisionId] ?? null : null

  // Any attempt whose revision is not yet known (e.g. one reconciled from a
  // generated identity) reads it from the persisted revision chain.
  const missingSchemaRevisionId =
    inspectedAttempt && !inspectedAttemptSchema ? inspectedAttempt.schemaRevisionId : null
  const extractionSchemaId = schemaSnap.extractionSchemaId
  useEffect(() => {
    if (!missingSchemaRevisionId || !extractionSchemaId) return
    const controller = new AbortController()
    getSchemaRevision(projectContextId, extractionSchemaId, missingSchemaRevisionId, controller.signal)
      .then((revision) => {
        if (controller.signal.aborted) return
        setKnownSchemas((known) => ({
          ...known,
          [revision.schemaRevisionId]: {
            schemaRevisionId: revision.schemaRevisionId,
            revisionNumber: revision.revisionNumber,
            recordDescription: revision.recordDescription,
            schemaNodes: revision.schemaNodes,
          },
        }))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [projectContextId, extractionSchemaId, missingSchemaRevisionId])

  const evidenceFieldNames = useMemo(
    () =>
      inspectedAttemptSchema?.schemaNodes.map((node) => node.name) ?? [],
    [inspectedAttemptSchema],
  )
  const selectEvidenceAnchor = useEvidenceOverlays({
    containerRef,
    viewerRef: pdfViewerRef,
    parsedDocument,
    attempt: inspectedAttempt,
    fieldNames: evidenceFieldNames,
    resultPath,
    active: effectiveRailOpen && railTab === 'results',
  })

  /** Saves pending schema edits as the Current Schema Revision, reads the account's saved method again, then admits the
   *  run over the whole document: what admission pins is what was saved at the click (§2). A `method_changed` refusal
   *  re-reads once and retries; a second refusal starts nothing. A failed admission leaves the revision saved. */
  async function runExtraction() {
    if (savingForRun || running || !sourceRepresentationCurrent) return
    setSavingForRun(true)
    const targetSourceRepresentationId = sourceRepresentationId
    const stillHere = () => activeSourceRepresentationIdRef.current === targetSourceRepresentationId
    try {
      const revision = await schema.flush()
      if (!stillHere()) return
      if (!revision) throw new Error('Save the Current Schema Revision before extraction.')
      // The saved revision's own scope decides what a run is; admission refuses any other.
      if (revision.recordScope === null) throw new Error('Choose Article or Catalog in the schema header before extraction.')
      const strategy = strategyOf(revision.recordScope)
      // The researcher asked for this run, so it is what they now inspect; its schema is known before the server
      // acknowledges the attempt.
      setSelectedInspectionId(null)
      setKnownSchemas((known) => ({
        ...known,
        [revision.schemaRevisionId]: {
          schemaRevisionId: revision.schemaRevisionId,
          revisionNumber: revision.revisionNumber,
          recordDescription: revision.recordDescription,
          schemaNodes: revision.schemaNodes,
        },
      }))
      const target = { sourceRepresentationId: targetSourceRepresentationId, schemaRevisionId: revision.schemaRevisionId }
      for (let round = 0; round < 2; round += 1) {
        // An Apply elsewhere aborts a read in flight, which then resolves null although the settings are ready: read
        // once more before saying they could not be read.
        let savedState = await saved.refresh()
        if (!stillHere()) return
        if (!savedState) {
          savedState = await saved.refresh()
          if (!stillHere()) return
        }
        if (!savedState) throw new Error('Saved advanced settings could not be read. Nothing was started.')
        // The unified Catalog has no recipe: one Catalog method for every new Catalog Extraction.
        const catalogRecipe = savedState.unifiedCatalog ? null : nextCatalogRecipe || null
        refusalRef.current = null
        admittingRef.current = true
        let acknowledged: Awaited<ReturnType<typeof extraction.runExtraction>>
        try {
          acknowledged = await extraction.runExtraction(savedMethodFor(savedState, strategy, catalogRecipe), target, strategy, catalogRecipe)
        } finally {
          admittingRef.current = false
        }
        if (!stillHere()) return
        if (acknowledged) {
          selectNextRunAfter(acknowledged)
          // Finished when acknowledged, it has had its one completion toast (with "Review now") from onTerminal.
          if (acknowledged.executionStatus !== 'COMPLETED' && acknowledged.executionStatus !== 'FAILED')
            pendingReportRef.current = acknowledged.extractionId
          return
        }
        // Set by onMethodChanged during the await above; TypeScript keeps the `null` assignment's narrowing across it.
        const refusal = refusalRef.current as RunRefusal | null
        if (refusal?.code !== METHOD_CHANGED) {
          // A superseded source or a definite rejection already spoke through its own callback; the other refusals
          // (migration, record scope) are told here, now that the saved-method summary is gone.
          if (refusal) showToast(refusal.message, { durationMs: 6000 })
          return
        }
        if (round === 1) showToast('Your saved settings changed. Run again.', { durationMs: 6000 })
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Save the Current Schema Revision before extraction.')
    } finally {
      setSavingForRun(false)
    }
  }

  /** The save failure's Retry: a flush saves the latest draft and scope again. A new failure shows as the status. */
  function retrySchemaSave() {
    void schema.flush().catch(() => undefined)
  }

  const runExtractionUnavailable =
    savingForRun ||
    running ||
    !sourceRepresentationId ||
    !sourceRepresentationCurrent ||
    !schemaReady ||
    nextExtractionStrategy === null ||
    indexing ||
    schemaSnap.save?.status === 'conflict' ||
    schemaSnap.save?.status === 'error'
  // Why Run cannot start now, in the words its title uses; Results' empty state says the same. Null while it can (or
  // while a run is active, when the button is Stop), and for the transient save-before-run, whose title stays the
  // strategy's.
  const runUnavailableReason: string | null = running || !runExtractionUnavailable
    ? null
    : !sourceRepresentationCurrent
      ? 'This view shows an Extraction on an earlier Source Representation. Go back to the current one to run a new Extraction.'
      : schemaSnap.save?.status === 'error'
        ? 'The schema is not saved. Retry the save first.'
        : schemaSnap.save?.status === 'conflict'
          ? 'The schema changed elsewhere. Reload it in the Schema tab first.'
          : indexing
            ? 'The document is still being indexed'
            : !schemaReady
              ? 'Generate a schema in the Schema tab first'
              : nextExtractionStrategy === null
                ? 'Choose Article or Catalog in the schema header'
                : null
  const badge = resultsBadgeFor(extraction)
  const runLabel = running ? (extraction.cancellationRequested ? 'Cancellation requested…' : '■ Stop extraction') : '▶ Run extraction'
  return (
    <div
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-canvas text-ink"
      onCopy={handleClipboard}
      onCut={handleClipboard}
      onPaste={handleClipboard}
      onKeyDown={handleKeyDown}
    >
      {/* Portalled into DocumentTabBar's (AppFrame.tsx) own tab-strip row, so the open Source Document's run action costs
          no extra vertical space. */}
      {tabBarSlot && createPortal(
        <>
          {/* Transient status only (Rulings 2 and 3): the indexing state while it runs, then the save state. A scope choice saves at once; field edits wait out the debounce. Run waits for either, and a failed save
              blocks it until Retry saves the latest draft and scope. Saved, this renders nothing (the panel footer says so). */}
          {indexing && <span className="shrink-0 text-compact font-medium text-ink-muted">Indexing document…</span>}
          {docIndex.status === 'error' && (
            <span className="shrink-0 text-compact font-medium text-danger" title={docIndex.message}>Indexing failed</span>
          )}
          <SchemaSaveStatus save={schemaSnap.save} onRetry={retrySchemaSave} className="max-w-72" />
          {/* Run is the screen's one positive; while a run is active it is Stop, in danger, also once its cancellation is
              requested (then disabled). */}
          <Button
            variant={running ? 'danger' : 'positive'}
            size="md"
            disabled={running ? extraction.cancellationRequested : runExtractionUnavailable}
            title={
              running
                ? extraction.cancellationRequested ? 'Waiting for the Extraction to stop' : 'Cancel the active Extraction'
                : runUnavailableReason ?? (nextExtractionStrategy === 'CATALOG'
                  ? 'Find the catalogue entries and extract one record per entry'
                  : 'Extract one record from the whole document')
            }
            onClick={() => (running ? void extraction.requestCancellation() : void runExtraction())}
          >
            {runLabel}
            {running && !extraction.cancellationRequested && badge && <span className="font-medium opacity-80"> · {badge.label}</span>}
          </Button>
        </>,
        tabBarSlot,
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="relative flex h-full min-h-0 overflow-hidden">
          {/* Reserve COLLAPSED_WIDTH for the schema rail when it becomes an overlay. */}
          <section className="relative flex min-h-0 min-w-0 flex-1 flex-col max-[859px]:mr-[46px]" aria-label="PDF document">
            <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
              <Button ref={pagesToggleRef} aria-expanded={pagesOpen} aria-controls={pageNavigationId}
                disabled={loadState.status !== 'ready'} onClick={() => setPagesOpen((open) => !open)}>
                <span aria-hidden="true">☰</span> Pages
              </Button>
              {loadState.status === 'ready' ? (
                <PagePager page={currentPage} pageCount={loadState.pageCount}
                  onNavigate={(page) => { if (pdfViewerRef.current) pdfViewerRef.current.currentPageNumber = page }} />
              ) : (
                <p role="status" aria-live="polite" className={`text-compact font-medium ${loadState.status === 'error' ? 'text-danger' : 'text-ink-muted'}`}>
                  {loadState.status === 'loading' ? 'Loading PDF…' : loadState.message}
                </p>
              )}
              {loadState.status === 'ready' && (
                <div className="flex shrink-0 items-center rounded-full border border-line bg-surface-muted p-0.5" role="group" aria-label="PDF zoom">
                  <button
                    type="button"
                    aria-label="Zoom out"
                    title="Zoom out (Ctrl + -)"
                    disabled={zoomPercent <= 10}
                    onClick={() => pdfViewerRef.current?.decreaseScale()}
                    className="flex size-6.5 items-center justify-center rounded-full text-[15px] leading-none text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    aria-label="Reset zoom to 100%"
                    title="Reset zoom to 100%"
                    onClick={() => {
                      if (pdfViewerRef.current) pdfViewerRef.current.currentScale = 1
                    }}
                    className="min-w-11 rounded-full px-1.5 text-center text-compact font-medium text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink"
                  >
                    {zoomPercent}%
                  </button>
                  <button
                    type="button"
                    aria-label="Zoom in"
                    title="Zoom in (Ctrl + +)"
                    disabled={zoomPercent >= 2500}
                    onClick={() => pdfViewerRef.current?.increaseScale()}
                    className="flex size-6.5 items-center justify-center rounded-full text-[15px] leading-none text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
                  >
                    +
                  </button>
                </div>
              )}
            </div>
            <div className="relative flex min-h-0 flex-1">
              {loadState.status === 'ready' && pagesOpen && <PageNavigation
                id={pageNavigationId} pageCount={loadState.pageCount} currentPage={currentPage}
                onNavigate={(page) => { if (pdfViewerRef.current) pdfViewerRef.current.currentPageNumber = page }}
                onClose={() => { setPagesOpen(false); pagesToggleRef.current?.focus() }}
                thumbnails={thumbnails} />}
              <div className="relative min-w-0 flex-1">
                <div className="pdf-viewer scrollbar-subtle absolute inset-0 overflow-auto py-4 sm:py-8" ref={setContainerNode}>
                  <div className="pdfViewer" ref={setViewerNode} />
                </div>
              </div>
              {/* Under the 34px toolbar, over the page: the toast never covers the toolbar's controls. Above the loading
                  cover (z-20), which a notice outliving a switch of Source Representation shows under. */}
              {toast && (
                <div className="pointer-events-none absolute inset-x-4 top-3 z-30 flex justify-center">
                  <Toast key={toast.id} message={toast.message} action={toast.action} onDismiss={dismissToast} onHoldChange={holdToast} />
                </div>
              )}
            </div>
            {loadState.status === 'loading' && (
              <Spinner
                className="absolute inset-0 z-20 justify-center bg-canvas/85 backdrop-blur-[1px]"
                ariaLabel="Loading Source Document"
              />
            )}
          </section>
          {effectiveRailOpen && (
            <div
              className="z-5 -mr-0.75 w-1.25 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent-soft max-[859px]:hidden"
              title="Drag to resize"
              onMouseDown={startResize}
            />
          )}
          <aside
            style={{ width: effectiveRailWidth }}
            className={`flex min-h-0 shrink-0 flex-col border-l border-line bg-surface max-[859px]:absolute max-[859px]:inset-y-0 max-[859px]:right-0 max-[859px]:z-30 ${
              effectiveRailOpen
                ? 'max-[859px]:!w-[min(90vw,32rem)] max-[859px]:shadow-xl'
                : ''
            }`}
            aria-label="Evidence, schema and results"
          >
            <RightRail
              open={effectiveRailOpen}
              onToggle={() => setRailOpen((open) => !open)}
              tab={railTab}
              onTabChange={setRailTab}
              schema={schema}
              onGenerateInstructions={handleGenerate}
              onClearDraft={resetSchema}
              extraction={extraction}
              inspection={{
                attempt: inspectedAttempt,
                readOnly: inspectionReadOnly,
                documentMarkdown,
                parsedDocument,
                reviewDecisions: inspectedAttempt?.reviewDecisions ?? [],
                pinnedSchema: inspectedAttemptSchema,
                exportSchema: inspectedAttemptSchema,
              }}
              currentSchemaRevision={currentSchemaRevision}
              runUnavailableReason={runUnavailableReason}
              sourceDocumentName={filename}
              sourceRepresentationId={sourceRepresentationId}
              schemaName={schemaName}
              recordScope={{ value: schemaSnap.recordScope, onChange: (scope) => schema.setRecordScope(scope), disabled: running || savingForRun }}
              boundaries={
                !running && nextExtractionStrategy === 'CATALOG' && !lastReadyUnifiedCatalog
                  ? { value: nextCatalogRecipe, options: CATALOG_RECIPES, onChange: setNextCatalogRecipe, disabled: savingForRun }
                  : null
              }
              resultsHeaderExtras={
                <>
                  {inspectionChoices.length > 1 && (
                    <select aria-label="Extraction snapshot" value={inspectedAttempt?.extractionId ?? ''}
                      onChange={(event) => setSelectedInspectionId(event.target.value)}
                      className="rounded-[3px] border border-line bg-surface px-2 py-1 text-compact">
                      {inspectionChoices.map((choice) => <option key={choice.extractionId} value={choice.extractionId}>{choice.label}</option>)}
                    </select>
                  )}
                  {reviewedOnAnotherSource && latestReviewedExtraction && (
                    <Button variant="secondary" onClick={() => onOpenExtraction(latestReviewedExtraction.extractionId)}>Open latest reviewed</Button>
                  )}
                </>
              }
              onRenameSchema={async (name) => {
                // The live controller, not this render's snapshot: an import or Start blank renames right after initialising.
                const extractionSchemaId = schema.snapshot().extractionSchemaId
                if (!projectContextId || !extractionSchemaId)
                  return 'No durable schema is open.'
                return renameSchema(extractionSchemaId, name)
              }}
              onSelectEvidence={selectEvidenceAnchor}
              onResultPathChange={setResultPath}
            />
          </aside>
        </div>
      </div>
    </div>
  )
}

export default DocumentWorkspace
