import {
  authenticatedFetch,
  reportAuthenticationRequired,
} from './auth/authenticatedFetch.ts'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { PDFViewer, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PDFViewerOptions } from 'pdfjs-dist/types/web/pdf_viewer'
import RightRail from './RightRail'
import type { RailTab } from './RightRail'
import type { RunExtractionStrategy } from './ResultsTab'
import { useDurableCurrentSchemaRevision } from './useCurrentSchemaRevision'
import { deleteModelOperation, requestSchema } from './api'
import {
  decodeParsedDocument,
  type ParsedDocument,
} from 'extraction/parsed-document'
import { useEvidenceOverlays } from './useEvidenceOverlays'
import { useExtraction } from './useExtraction'
import { savedMethodFor, useSavedMethod } from './savedMethod'
import { SavedMethodSummary } from './SavedMethodSummary'
import type { ExtractionAttempt, ExtractionStrategy } from '../shared/extraction.contract'
import ExtractionFinishedDialog from './ExtractionFinishedDialog'
import { Button, Spinner } from './ui'
import { AnnotationEditorType, AnnotationMode } from 'pdfjs-dist'
import type { DocumentSnapshot } from './projectContexts/transport'
import { getSchemaRevision, renameExtractionSchema } from './schemaRevisions'
import type { SchemaDefinition } from 'extraction/schema'
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
}

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
}: DocumentWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const toastTimerRef = useRef<number | undefined>(undefined)
  const pdfViewerRef = useRef<PDFViewer | null>(null)
  const activeSourceRepresentationIdRef = useRef(sourceRepresentationId)
  useEffect(() => {
    activeSourceRepresentationIdRef.current = sourceRepresentationId
  }, [sourceRepresentationId])

  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [zoomPercent, setZoomPercent] = useState(100)
  const schema = useDurableCurrentSchemaRevision({
    projectContextId,
    extractionSchema,
    debounceMs: 1500,
    sourceRepresentationId,
    onCommitMessage: (message) => showToast(message),
  })
  const schemaSnap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const [schemaName, setSchemaName] = useState(extractionSchema?.name ?? null)
  const [savingForRun, setSavingForRun] = useState(false)
  // One-shot per-run selection: each new run defaults back to Article, and the
  // selector never changes the strategy of an active or persisted attempt.
  const [nextExtractionStrategy, setNextExtractionStrategy] =
    useState<ExtractionStrategy>('ARTICLE')
  // Catalog only, one-shot like the strategy: '' keeps generic model discovery of record boundaries.
  const [nextCatalogRecipe, setNextCatalogRecipe] = useState('')
  const [railOpen, setRailOpen] = useState(true)
  const [railWidth, setRailWidth] = useState(344)
  const [railTab, setRailTab] = useState<RailTab>('schema')
  const [resultPath, setResultPath] = useState<string[] | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Whether the toast on screen explains the refresh that is about to replace
  // this document's Source Representation, so that switch must not clear it.
  const [toastOutlivesSwitch, setToastOutlivesSwitch] = useState(false)
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
  const [finishedExtractionReport, setFinishedExtractionReport] = useState<{
    attempt: ExtractionAttempt
    schemaNodes: SchemaDefinition['schemaNodes']
  } | null>(null)
  // A run started here reports once it terminates; restored or reconnected
  // runs never open the dialog.
  const pendingReportRef = useRef<{ extractionId: string; schemaNodes: SchemaDefinition['schemaNodes'] } | null>(null)
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
    setNextExtractionStrategy('ARTICLE')
    setNextCatalogRecipe('')
    setSelectedInspectionId(persistedExtraction?.extractionId ?? null)
    setKnownSchemas(reopenedSchemas)
    setResultPath(null)
    if (!toastOutlivesSwitch) setToast(null)
    setToastOutlivesSwitch(false)
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
      // Runtime setDocument(null) clears viewer state, but the shipped type omits null.
      ;(pdfViewer.setDocument as (pdfDocument: pdfjsLib.PDFDocumentProxy | null) => void).call(
        pdfViewer,
        null,
      )
      abortController.abort()
      if (loadingTask) void loadingTask.destroy()
    }
  }, [onInitialResourceLoadFailure, pdfUrl])

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


  useEffect(
    () => () => {
      window.clearTimeout(toastTimerRef.current)
    },
    [],
  )

  function showToast(message: string, { outlivesSwitch = false, durationMs = 2600 } = {}) {
    window.clearTimeout(toastTimerRef.current)
    setToast(message)
    setToastOutlivesSwitch(outlivesSwitch)
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      setToastOutlivesSwitch(false)
    }, durationMs)
  }

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
    await schema.generate((signal) =>
      requestSchema(
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
      ),
      // Stop cancels the workflow; leaving the page only detaches (the controller's dispose).
      { cancel: () => deleteModelOperation(`suggestion:${operationId}`) },
    )
    // The first successful generation initializes the Extraction Schema;
    // name it the way initializeSchemaRevision's caller always has.
    if (!hadSchema && schema.snapshot().extractionSchemaId !== null)
      setSchemaName((name) => name ?? 'Extraction Schema')
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

  const statusStyles: Record<LoadState['status'], { dot: string; text?: string }> = {
    loading: { dot: 'animate-pulse bg-amber-500' },
    ready: { dot: 'bg-green' },
    error: { dot: 'bg-danger', text: 'text-danger' },
  }
  const schemaReady = schemaSnap.view === 'editing'
  //
  // const schemaStale =
  //   templateState.status === 'ready' &&
  //   templateState.inputsKey !== annotationInputsKey(annotationItems, annotationsMode)

  const effectiveRailOpen = railOpen
  const effectiveRailWidth = effectiveRailOpen ? railWidth : COLLAPSED_WIDTH

  // The account's saved method: a run submits what it saw, and admission refuses it if an Apply changed it since.
  const saved = useSavedMethod()
  const [methodConflict, setMethodConflict] = useState<string | null>(null)
  const extraction = useExtraction({
    schemaReady,
    indexing,
    initialAttempt: persistedExtraction,
    documentKey: sourceRepresentationId,
    reviewTarget: sourceRepresentationId
      ? {
          sourceRepresentationId,
          schemaRevisionId: schemaSnap.extractableSchemaRevisionId,
        }
      : null,
    // Completion preserves the rail tab and inspected snapshot; a completion
    // report temporarily takes focus until dismissed or Review now is chosen.
    onTerminal: (attempt, isRerun) => {
      if (pendingReportRef.current?.extractionId === attempt.extractionId) {
        const { schemaNodes } = pendingReportRef.current
        pendingReportRef.current = null
        if (attempt.outcome === 'SUCCEEDED')
          setFinishedExtractionReport({ attempt, schemaNodes })
      }
      selectNextRunAfter(attempt)
      if (attempt.failure?.code === 'cancelled')
        showToast('Extraction cancelled — no result was saved')
      else if (attempt.executionStatus === 'FAILED')
        showToast('Extraction failed — see details in Results')
      else
        showToast(
          isRerun
            ? '↻ Re-run complete — view the JSON in the Results tab'
            : '✓ Extraction complete — view the JSON in the Results tab',
        )
    },
    onError: () => showToast('Extraction failed — see details in Results'),
    // Nothing started. The refresh either keeps this Source Representation, now no longer current (Run is then
    // disabled), or moves to the reprocessed one; either way the notice outlives that switch.
    onSuperseded: () => {
      showToast('This document has been reprocessed — no new Extraction was started', {
        outlivesSwitch: true,
        durationMs: 6000,
      })
      onSourceSuperseded?.()
    },
    onMethodChanged: setMethodConflict,
  })

  /**
   * The one-shot selection for the next run once `attempt` is acknowledged or has ended: a failed Catalog attempt is
   * run again with its own recipe; anything else defaults back to Article.
   */
  function selectNextRunAfter(attempt: ExtractionAttempt) {
    const repeat = attempt.executionStatus === 'FAILED' && attempt.strategy === 'CATALOG'
    setNextExtractionStrategy(repeat ? 'CATALOG' : 'ARTICLE')
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

  async function runExtraction() {
    if (savingForRun || running || !sourceRepresentationCurrent || saved.state.status !== 'ready') return
    const savedState = saved.state
    setSavingForRun(true)
    const targetSourceRepresentationId = sourceRepresentationId
    try {
      const revision = await schema.flush()
      if (
        activeSourceRepresentationIdRef.current !==
        targetSourceRepresentationId
      )
        return
      if (!revision)
        throw new Error('Save the Current Schema Revision before extraction.')
      const strategy = nextExtractionStrategy
      // The unified Catalog has no recipe: one Catalog method for every new Catalog Extraction.
      const catalogRecipe = savedState.unifiedCatalog ? null : nextCatalogRecipe || null
      const method = savedMethodFor(savedState, strategy, catalogRecipe)
      setMethodConflict(null)
      // The researcher asked for this run, so it is what they now inspect;
      // its schema is known before the server acknowledges the attempt.
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
      const acknowledged = await extraction.runExtraction(
        method,
        {
          sourceRepresentationId: targetSourceRepresentationId,
          schemaRevisionId: revision.schemaRevisionId,
        },
        strategy,
        catalogRecipe,
      )
      if (!acknowledged) return
      selectNextRunAfter(acknowledged)
      if (acknowledged.executionStatus === 'COMPLETED' || acknowledged.executionStatus === 'FAILED') {
        if (acknowledged.outcome === 'SUCCEEDED')
          setFinishedExtractionReport({ attempt: acknowledged, schemaNodes: revision.schemaNodes })
      } else
        pendingReportRef.current = { extractionId: acknowledged.extractionId, schemaNodes: revision.schemaNodes }
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : 'Save the Current Schema Revision before extraction.',
      )
    } finally {
      setSavingForRun(false)
    }
  }

  const runExtractionUnavailable =
    saved.state.status !== 'ready' ||
    savingForRun ||
    running ||
    !sourceRepresentationId ||
    !sourceRepresentationCurrent ||
    !schemaReady ||
    indexing ||
    schemaSnap.save?.status === 'conflict' ||
    schemaSnap.save?.status === 'error'
  const runLabel = running
    ? extraction.cancellationRequested
      ? 'Cancellation requested…'
      : 'Cancel extraction'
    : extraction.hasResults
      ? '↻ Re-run extraction'
      : '▶ Run extraction'
  // The one-shot selection runExtraction posts, named on every Results-tab run
  // action so none of them promises to repeat the inspected attempt.
  const runExtractionStrategy: RunExtractionStrategy =
    nextExtractionStrategy === 'CATALOG'
      ? {
          strategy: 'CATALOG',
          boundaries:
            CATALOG_RECIPES.find((recipe) => recipe.id === nextCatalogRecipe)?.label ??
            'Model discovery',
        }
      : { strategy: 'ARTICLE' }

  const hintText =
    running
      ? 'Extraction is running. Follow its status in the Results tab'
      : extraction.hasResults
      ? 'View the extracted JSON in the Results tab'
      : !sourceRepresentationCurrent
        ? 'Go back to the current Source Representation to run a new Extraction'
        : schemaReady
          ? 'Press Run extraction to apply the schema across the whole document'
          : 'Open the Schema tab to generate the extraction schema for this document'

  return (
    <div
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-canvas text-ink"
      onCopy={handleClipboard}
      onCut={handleClipboard}
      onPaste={handleClipboard}
      onKeyDown={handleKeyDown}
    >
      {/* Portalled into DocumentTabBar's (AppFrame.tsx) own tab-strip row —
          these controls share that row instead of a second one, so the open
          Source Document's Extraction controls cost no extra vertical space.
          The document's name is already on its tab and in the breadcrumb, so
          it isn't repeated here. */}
      {tabBarSlot && createPortal(
        <>
          {indexing && (
            <span className="shrink-0 text-xs font-medium text-ink-muted">Indexing document…</span>
          )}
          {docIndex.status === 'error' && (
            <span className="shrink-0 text-xs font-medium text-danger" title={docIndex.message}>
              Indexing failed
            </span>
          )}
          {inspectionChoices.length > 1 && (
            <select aria-label="Extraction snapshot" value={inspectedAttempt?.extractionId ?? ''} onChange={(event) => setSelectedInspectionId(event.target.value)} className="rounded-md border border-line bg-surface px-2 py-1 text-xs">
              {inspectionChoices.map((choice) => <option key={choice.extractionId} value={choice.extractionId}>{choice.label}</option>)}
            </select>
          )}
          {reviewedOnAnotherSource && latestReviewedExtraction && (
            <Button
              variant="secondary"
              onClick={() => onOpenExtraction(latestReviewedExtraction.extractionId)}
            >
              Open latest reviewed
            </Button>
          )}
          <p
            aria-live="polite"
            className={`hidden w-fit shrink-0 items-center gap-2 rounded-full border border-line bg-surface-muted py-1 pl-2.5 pr-3 text-xs font-medium text-ink-muted sm:inline-flex ${statusStyles[loadState.status].text ?? ''}`}
          >
            <span aria-hidden="true" className={`size-1.5 rounded-full ${statusStyles[loadState.status].dot}`} />
            {loadState.status === 'loading' && 'Loading PDF…'}
            {loadState.status === 'ready' && `${loadState.pageCount} pages`}
            {loadState.status === 'error' && loadState.message}
          </p>
          {loadState.status === 'ready' && (
            <div
              className="flex shrink-0 items-center rounded-full border border-line bg-surface-muted p-0.5"
              role="group"
              aria-label="PDF zoom"
            >
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
                className="min-w-11 rounded-full px-1.5 text-center text-xs font-medium text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink"
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
          <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-muted">
            Strategy
            <select
              aria-label="Extraction strategy"
              value={running ? latestAttempt.strategy : nextExtractionStrategy}
              disabled={running || savingForRun}
              onChange={(event) =>
                setNextExtractionStrategy(event.target.value as ExtractionStrategy)
              }
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
            >
              <option value="ARTICLE">Article</option>
              <option value="CATALOG">Catalog</option>
            </select>
          </label>
          {!running && nextExtractionStrategy === 'CATALOG' && !(saved.state.status === 'ready' && saved.state.unifiedCatalog) && (
            <label className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-muted">
              Boundaries
              <select
                aria-label="Record boundaries"
                value={nextCatalogRecipe}
                disabled={savingForRun}
                onChange={(event) => setNextCatalogRecipe(event.target.value)}
                title="How catalogue entries are found: by the model, or by a numbered-catalogue recipe with source-backed evidence"
                className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
              >
                <option value="">Model discovery</option>
                {CATALOG_RECIPES.map((recipe) => (
                  <option key={recipe.id} value={recipe.id}>{recipe.label}</option>
                ))}
              </select>
            </label>
          )}
          {!running && (
            <SavedMethodSummary variant="toolbar" saved={saved.state} conflict={methodConflict}
              method={saved.state.status === 'ready'
                ? savedMethodFor(saved.state, nextExtractionStrategy, nextExtractionStrategy === 'CATALOG' && !saved.state.unifiedCatalog ? nextCatalogRecipe || null : null)
                : null}
              onRefresh={() => { setMethodConflict(null); void saved.refresh() }} />
          )}
          <Button
            variant="primary"
            size="md"
            disabled={
              running
                ? extraction.cancellationRequested
                : runExtractionUnavailable
            }
            title={
              running
                ? extraction.cancellationRequested
                  ? 'Waiting for the Extraction to stop'
                  : 'Cancel the active Extraction'
                : !sourceRepresentationCurrent
                  ? 'This view shows an Extraction on an earlier Source Representation. Go back to the current one to run a new Extraction.'
                  : schemaReady
                    ? nextExtractionStrategy === 'CATALOG'
                      ? 'Find catalogue entries and extract one record per entry'
                      : 'Run one values extraction across the whole Source Document'
                    : 'Generate a schema in the Schema tab first'
            }
            onClick={() =>
              running
                ? void extraction.requestCancellation()
                : void runExtraction()
            }
          >
            {runLabel}
          </Button>
        </>,
        tabBarSlot,
      )}
      <div className="min-h-0 flex-1 overflow-hidden p-1 sm:p-3">
        <div className="relative flex h-full min-h-0 overflow-hidden rounded-lg border border-line sm:rounded-2xl">
          <section className="relative min-h-0 min-w-0 flex-1" aria-label="PDF document">
            <div className="pdf-viewer scrollbar-subtle absolute inset-0 overflow-auto py-4 sm:py-8" ref={setContainerNode}>
              <div className="pdfViewer" ref={setViewerNode} />
            </div>
            {loadState.status === 'loading' && (
              <Spinner
                className="absolute inset-0 z-20 justify-center bg-canvas/85 backdrop-blur-[1px]"
                ariaLabel="Loading Source Document"
              />
            )}
            {toast && (
              <div className="pointer-events-none absolute inset-x-4 top-4 z-20 flex justify-center">
                <p className="animate-fadeup min-w-0 truncate rounded-xl border border-line-strong bg-surface px-4.5 py-2 text-xs font-semibold text-ink shadow-float">
                  {toast}
                </p>
              </div>
            )}
            <div className="pointer-events-none absolute inset-x-4 bottom-4 z-10 hidden justify-center sm:flex">
              <p className="flex min-w-0 items-center gap-2 rounded-full bg-ink px-4 py-2 text-xs font-medium text-canvas shadow-float">
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent-soft" />
                <span className="truncate">{hintText}</span>
              </p>
            </div>
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
            className={`min-h-0 shrink-0 border-l border-line bg-surface max-[859px]:absolute max-[859px]:inset-y-0 max-[859px]:right-0 max-[859px]:z-30 ${
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
              onRunExtraction={sourceRepresentationCurrent ? runExtraction : undefined}
              runExtractionDisabled={runExtractionUnavailable}
              runExtractionStrategy={runExtractionStrategy}
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
              sourceDocumentName={filename}
              schemaName={schemaName}
              onRenameSchema={async (name) => {
                const extractionSchemaId = schemaSnap.extractionSchemaId
                if (!projectContextId || !extractionSchemaId)
                  return 'No durable schema is open.'
                try {
                  const renamed = await renameExtractionSchema(
                    projectContextId,
                    extractionSchemaId,
                    name,
                  )
                  setSchemaName(renamed.name)
                  return null
                } catch (error) {
                  return error instanceof Error
                    ? error.message
                    : 'Schema could not be renamed.'
                }
              }}
              onSelectEvidence={selectEvidenceAnchor}
              onResultPathChange={setResultPath}
            />
          </aside>
        </div>
      </div>
      {finishedExtractionReport && (
        <ExtractionFinishedDialog
          key={finishedExtractionReport.attempt.extractionId}
          attempt={finishedExtractionReport.attempt}
          documentName={filename}
          schemaNodes={finishedExtractionReport.schemaNodes}
          onReviewNow={() => {
            setRailTab('results')
            setFinishedExtractionReport(null)
          }}
          onDismiss={() => setFinishedExtractionReport(null)}
        />
      )}
    </div>
  )
}

export default DocumentWorkspace
