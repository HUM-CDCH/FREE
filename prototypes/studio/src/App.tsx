import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { PDFViewer, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PDFViewerOptions } from 'pdfjs-dist/types/web/pdf_viewer'
import type { AnnotationSetItem } from './AnnotationSidebar'
import RightRail from './RightRail'
import type { RailTab } from './RightRail'
import type { TemplateState } from './SchemaPanel'
import {
  type SchemaNode,
  schemaDefinitionToTemplate,
  templateToSchemaDefinition,
} from '../shared/schemaNode'
import { countTemplateFields } from '../shared/template'
import { requestSchema, parseDocument, fetchParsedDocument } from './api'
import {
  decodeParsedDocument,
  type ParsedDocument,
  type ParsedEvidenceAnchor,
} from '../shared/parsedDocument'
import {
  anchorOccurrences,
  reviewedAnchorOccurrences,
  type EvidenceOccurrence,
  verifiedEvidenceBbox,
} from './evidenceNavigation'
import type { AnnotationsMode } from './api'
import { useExtraction } from './useExtraction'
import { Button } from './ui'
import { AnnotationEditorType, AnnotationMode } from 'pdfjs-dist'
import type { AnnotationEditorUIManager } from 'pdfjs-dist'
import type { AnnotationEditor } from 'pdfjs-dist/types/src/display/editor/editor'
import type { DocumentSnapshot } from './projectContexts'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import {
  appendSchemaRevision,
  getSchemaRevision,
  initializeSchemaRevision,
  listSchemaRevisions,
} from './schemaRevisions'
import type { SchemaRevisionSummary } from '../shared/schemaRevision.contract'
import {
  createSchemaSaveCoordinator,
  type SchemaSaveCoordinator,
  type SchemaSaveState,
} from './schemaSaveCoordinator'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const COLLAPSED_WIDTH = 46
const RAIL_MIN = 264
const RAIL_MAX = 560
const ANNOTATION_HIGHLIGHT_COLORS = 'annotation=#FFF066'
const EVIDENCE_HIGHLIGHT_COLORS = [
  'rgba(148, 203, 236, 0.28)',
  'rgba(220, 205, 125, 0.28)',
  'rgba(194, 106, 119, 0.24)',
  'rgba(93, 168, 153, 0.24)',
]

function reviewedOccurrenceIds(
  attempt: Pick<ExtractionAttempt, 'reviewDecisions'> | null,
  evidenceAnchorId: string,
) {
  return attempt?.reviewDecisions.find(
    (decision) => decision.evidenceAnchorId === evidenceAnchorId,
  )?.reviewedOccurrenceIds
}

function appendEvidenceOverlay(
  container: HTMLElement,
  document: ParsedDocument,
  occurrence: EvidenceOccurrence,
  options: {
    className: string
    background: string
    border?: string
    evidenceAnchorId?: string
    resultPath?: readonly (string | number)[]
  },
): HTMLElement | null {
  const page = container.querySelector(
    `.page[data-page-number="${occurrence.page_number}"]`,
  )
  if (!(page instanceof HTMLElement)) return null
  const bbox = verifiedEvidenceBbox(document, occurrence)
  const pageMeta = document.pages.find(
    (candidate) => candidate.page_number === occurrence.page_number,
  )
  if (!bbox || !pageMeta) return null
  const overlay = window.document.createElement('div')
  overlay.className = options.className
  overlay.ariaHidden = 'true'
  overlay.dataset.occurrenceId = occurrence.occurrence_id
  if (options.evidenceAnchorId)
    overlay.dataset.evidenceAnchorId = options.evidenceAnchorId
  if (options.resultPath)
    overlay.dataset.resultPath = JSON.stringify(options.resultPath)
  Object.assign(overlay.style, {
    position: 'absolute',
    left: `${bbox.x0 / pageMeta.width_pt * 100}%`,
    top: `${bbox.y0 / pageMeta.height_pt * 100}%`,
    width: `${(bbox.x1 - bbox.x0) / pageMeta.width_pt * 100}%`,
    height: `${(bbox.y1 - bbox.y0) / pageMeta.height_pt * 100}%`,
    border: options.border ?? '0',
    borderRadius: '2px',
    background: options.background,
    pointerEvents: 'none',
    zIndex: options.border ? '5' : '4',
  })
  if (getComputedStyle(page).position === 'static') page.style.position = 'relative'
  page.append(overlay)
  return overlay
}

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
  const response = await fetch(url, { signal })
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
  const response = await fetch(url, { signal })
  if (!response.ok)
    throw new Error(
      `Could not fetch parsed Source Document (HTTP ${response.status}).`,
    )
  return decodeParsedDocument(await response.json())
}

function getHighlightLabel(editor: AnnotationEditor) {
  return editor.div?.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim() ?? ''
}

function isHighlightEditor(editor: AnnotationEditor) {
  return editor.editorType === 'highlight' || editor.div?.getAttribute('role') === 'mark'
}

// Mode only shapes the request when annotations are sent (see requestSchema),
// so an empty set keys to '' regardless of mode.
function annotationInputsKey(items: AnnotationSetItem[], mode: AnnotationsMode) {
  if (items.length === 0) {
    return ''
  }
  return [mode, ...items.map((item) => item.id).sort()].join('\n')
}

export type DocumentWorkspaceProps = {
  pdfUrl: string
  filename: string
  /** Null for a dev-opened local file, which has nothing durable to review against. */
  projectContextId: string | null
  sourceRepresentationId: string | null
  markdownUrl: string | null
  parsedDocumentUrl: string | null
  annotationSet: DocumentSnapshot['annotationSet']
  extractionSchema: DocumentSnapshot['extractionSchema']
  persistedExtraction: DocumentSnapshot['latestAttempt']
  latestReviewedExtraction?: DocumentSnapshot['latestReviewed']
  /** Only the loader sees a retained resource fail; reported once, on open. */
  onInitialResourceLoadFailure?: () => void
}

export function DocumentWorkspace({
  pdfUrl,
  filename,
  projectContextId,
  sourceRepresentationId,
  markdownUrl,
  parsedDocumentUrl,
  annotationSet,
  extractionSchema,
  persistedExtraction,
  latestReviewedExtraction = null,
  onInitialResourceLoadFailure,
}: DocumentWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const pdfViewerRef = useRef<PDFViewer | null>(null)
  const annotationManagerRef = useRef<AnnotationEditorUIManager | null>(null)
  const templateAbortRef = useRef<AbortController | null>(null)
  const toastTimerRef = useRef<number | undefined>(undefined)
  const restoredAnnotations = (annotationSet?.annotations ?? []).map(
    ({ annotationId, text, pageNumber }) => ({
      id: annotationId,
      label: text,
      pageNumber,
    }),
  )
  const [annotationItems, setAnnotationItems] = useState<AnnotationSetItem[]>(
    restoredAnnotations,
  )
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [templateState, setTemplateState] = useState<TemplateState>(() =>
    extractionSchema
      ? {
          status: 'ready',
          recordDescription: extractionSchema.recordDescription,
          nodes: extractionSchema.schemaNodes,
          inputsKey: annotationInputsKey(restoredAnnotations, 'hints'),
        }
      : { status: 'idle' },
  )
  const [durableSchema, setDurableSchema] = useState(extractionSchema)
  const [annotationsMode, setAnnotationsMode] = useState<AnnotationsMode>('hints')
  // An accepted result is bound to the Schema Revision it was produced with, so
  // the pin is dropped as soon as the schema in the browser stops being it.
  const [pinnedSchemaRevisionId, setPinnedSchemaRevisionId] = useState<
    string | null
  >(extractionSchema?.schemaRevisionId ?? null)
  const [schemaSaveState, setSchemaSaveState] = useState<SchemaSaveState | null>(
    () =>
      extractionSchema
        ? {
            status: 'saved',
            acknowledged: {
              schemaRevisionId: extractionSchema.schemaRevisionId,
              extractionSchemaId: extractionSchema.extractionSchemaId,
              revisionNumber: extractionSchema.revisionNumber,
              recordDescription: extractionSchema.recordDescription,
              schemaNodes: extractionSchema.schemaNodes,
            },
            draft: {
              recordDescription: extractionSchema.recordDescription,
              schemaNodes: extractionSchema.schemaNodes,
            },
          }
        : null,
  )
  const [schemaHistory, setSchemaHistory] = useState<SchemaRevisionSummary[]>([])
  const schemaSaveCoordinatorRef = useRef<SchemaSaveCoordinator | null>(null)
  const [extractAfterSave, setExtractAfterSave] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [railWidth, setRailWidth] = useState(344)
  const [railTab, setRailTab] = useState<RailTab>('annot')
  const [resultPath, setResultPath] = useState<string[] | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const pdfSource = useMemo(
    () => ({ url: pdfUrl, filename }),
    [filename, pdfUrl],
  )
  const [docIndex, setDocIndex] = useState<DocIndex>({ status: 'parsing' })
  const [selectedInspectionId, setSelectedInspectionId] = useState<string | null>(persistedExtraction?.extractionId ?? null)
  const [pinnedDocIndex, setPinnedDocIndex] = useState<DocIndex>({ status: 'parsing' })
  const [pinnedPage, setPinnedPage] = useState(1)

  useEffect(() => {
    if (!projectContextId || !durableSchema) return
    const acknowledged = {
      schemaRevisionId: durableSchema.schemaRevisionId,
      extractionSchemaId: durableSchema.extractionSchemaId,
      revisionNumber: durableSchema.revisionNumber,
      recordDescription: durableSchema.recordDescription,
      schemaNodes: durableSchema.schemaNodes,
    }
    const coordinator = createSchemaSaveCoordinator(
      acknowledged,
      (expectedRevisionNumber, definition) =>
        appendSchemaRevision(
          projectContextId,
          durableSchema.extractionSchemaId,
          expectedRevisionNumber,
          definition,
        ),
      1500,
      (next) => {
        setSchemaSaveState(next)
        if (next.status === 'saved')
          setPinnedSchemaRevisionId(next.acknowledged.schemaRevisionId)
      },
    )
    schemaSaveCoordinatorRef.current = coordinator
    return () => {
      coordinator.dispose()
      schemaSaveCoordinatorRef.current = null
    }
  }, [durableSchema, projectContextId])

  useEffect(() => {
    if (!projectContextId || !durableSchema) {
      return
    }
    const controller = new AbortController()
    void listSchemaRevisions(
      projectContextId,
      durableSchema.extractionSchemaId,
      20,
      controller.signal,
    ).then(setSchemaHistory).catch((error) => {
      if (!(error instanceof Error && error.name === 'AbortError')) setSchemaHistory([])
    })
    return () => controller.abort()
  }, [
    durableSchema,
    projectContextId,
    schemaSaveState?.acknowledged.schemaRevisionId,
  ])

  useEffect(() => {
    if (!schemaSaveState || schemaSaveState.status === 'saved') return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [schemaSaveState])

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
      annotationEditorMode: AnnotationEditorType.HIGHLIGHT,
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

    const loadingTask = pdfjsLib.getDocument({ url: pdfSource.url })
    pdfViewerRef.current = pdfViewer
    annotationManagerRef.current = null
    setLoadState({ status: 'loading' })

    const syncHighlightEditor = (editor: AnnotationEditor) => {
      if (!isHighlightEditor(editor)) {
        return
      }

      const label = getHighlightLabel(editor)
      if (!label) {
        editor.remove()
        return
      }

      setAnnotationItems((items) => {
        const existingIndex = items.findIndex((item) => item.id === editor.id)
        const nextItem: AnnotationSetItem = {
          id: editor.id,
          label,
          pageNumber: editor.pageIndex + 1,
        }

        if (existingIndex === -1) {
          return [...items, nextItem].sort((left, right) => left.pageNumber - right.pageNumber)
        }

        const nextItems = [...items]
        nextItems[existingIndex] = nextItem
        return nextItems
      })
    }

    const removeHighlightEditor = (editor: AnnotationEditor) => {
      setAnnotationItems((items) => items.filter((item) => item.id !== editor.id))
    }

    // pdf.js has no public event for editor add/remove (annotationStorage's
    // onAnnotationEditor only reports the type string), so wrap the manager's
    // methods to keep the sidebar in sync.
    const onAnnotationEditorUIManager = ({ uiManager }: { uiManager: AnnotationEditorUIManager }) => {
      annotationManagerRef.current = uiManager

      const { addEditor, removeEditor } = uiManager

      uiManager.addEditor = (editor) => {
        addEditor.call(uiManager, editor)
        // The editor's div and aria-label are populated after addEditor returns.
        queueMicrotask(() => syncHighlightEditor(editor))
      }

      uiManager.removeEditor = (editor) => {
        removeEditor.call(uiManager, editor)
        removeHighlightEditor(editor)
      }
    }

    eventBus.on('annotationeditoruimanager', onAnnotationEditorUIManager)

    async function loadPdf() {
      try {
        const pdf = await loadingTask.promise
        if (abortController.signal.aborted) {
          return
        }

        pdfViewer.setDocument(pdf)
        setLoadState({ status: 'ready', pageCount: pdf.numPages })
      } catch (error) {
        if (abortController.signal.aborted) {
          return
        }

        setLoadState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to load the PDF.',
        })
        onInitialResourceLoadFailure?.()
      }
    }

    void loadPdf()

    return () => {
      eventBus.off('annotationeditoruimanager', onAnnotationEditorUIManager)
      pdfViewerRef.current = null
      annotationManagerRef.current = null
      // Runtime setDocument(null) clears viewer state, but the shipped type omits null.
      ;(pdfViewer.setDocument as (pdfDocument: pdfjsLib.PDFDocumentProxy | null) => void).call(
        pdfViewer,
        null,
      )
      abortController.abort()
      void loadingTask.destroy()
    }
  }, [onInitialResourceLoadFailure, pdfSource])

  // Index the source document via the parsing service as soon as it is opened.
  // Kept separate from the viewer effect so a finished parse never re-loads the
  // PDF or clears annotations.
  useEffect(() => {
    const abortController = new AbortController()

    void (async () => {
      setDocIndex({ status: 'parsing' })
      try {
        const devTaskId = import.meta.env.VITE_DEV_TASK_ID as
          | string
          | undefined
        const parsed = markdownUrl && parsedDocumentUrl
          ? await Promise.all([
              readMarkdown(markdownUrl, abortController.signal),
              readParsedDocument(parsedDocumentUrl, abortController.signal),
            ]).then(([markdown, document]) => ({ markdown, document }))
          : devTaskId
            ? await Promise.all([
                readMarkdown(
                  `${import.meta.env.VITE_PARSING_SERVICE_URL ?? 'http://127.0.0.1:8000'}/tasks/${devTaskId}/markdown`,
                  abortController.signal,
                ),
                fetchParsedDocument(devTaskId, abortController.signal),
              ]).then(([markdown, document]) => ({ markdown, document }))
            : await parseDocument(
                await (
                  await fetch(pdfSource.url, {
                    signal: abortController.signal,
                  })
                ).blob(),
                pdfSource.filename,
                abortController.signal,
              )
        if (!abortController.signal.aborted) {
          setDocIndex({ status: 'ready', markdown: parsed.markdown, document: parsed.document })
        }
      } catch (error) {
        if (abortController.signal.aborted) return
        setDocIndex({
          status: 'error',
          message: error instanceof Error ? error.message : 'Document indexing failed.',
        })
        if (markdownUrl) onInitialResourceLoadFailure?.()
      }
    })()

    return () => abortController.abort()
  }, [markdownUrl, onInitialResourceLoadFailure, parsedDocumentUrl, pdfSource])

  function selectEvidenceAnchor(anchor: ParsedEvidenceAnchor) {
    if (inspectionSourceSnapshot) {
      const occurrence = reviewedAnchorOccurrences(
        anchor,
        reviewedOccurrenceIds(inspectedAttempt, anchor.anchor_id),
      )[0]
      if (occurrence) setPinnedPage(occurrence.page_number)
      return
    }
    const viewer = pdfViewerRef.current
    const container = containerRef.current
    container
      ?.querySelectorAll('.parsed-evidence-focus')
      .forEach((focus) => focus.remove())
    if (!viewer || !container || !parsedDocument) return
    const occurrences = reviewedAnchorOccurrences(
      anchor,
      reviewedOccurrenceIds(inspectedAttempt, anchor.anchor_id),
    )
    const firstOccurrence = occurrences[0]
    if (!firstOccurrence) return
    viewer.scrollPageIntoView({ pageNumber: firstOccurrence.page_number })
    let firstFocus: HTMLElement | null = null
    for (const occurrence of occurrences) {
      const focus = appendEvidenceOverlay(container, parsedDocument, occurrence, {
        className: 'parsed-evidence-focus',
        border: '2px solid #d97706',
        background: 'rgb(251 191 36 / 0.22)',
      })
      if (focus) firstFocus ??= focus
    }
    if (firstFocus) {
      firstFocus.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    }
  }

  function selectAnnotationItem(id: string) {
    const manager = annotationManagerRef.current
    const editor = manager?.getEditor(id)
    if (!manager || !editor) {
      const pageNumber = annotationItems.find((item) => item.id === id)?.pageNumber
      if (pageNumber) pdfViewerRef.current?.scrollPageIntoView({ pageNumber })
      return
    }

    manager.setSelected(editor)

    if (editor.div) {
      editor.div.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
      return
    }

    pdfViewerRef.current?.scrollPageIntoView({ pageNumber: editor.pageIndex + 1 })
  }

  function removeAnnotationItem(id: string) {
    const editor = annotationManagerRef.current?.getEditor(id)
    // Removing an editor prunes the set through the patched `removeEditor`.
    if (editor) editor.remove()
    else setAnnotationItems((items) => items.filter((item) => item.id !== id))
  }

  useEffect(
    () => () => {
      templateAbortRef.current?.abort()
      window.clearTimeout(toastTimerRef.current)
    },
    [],
  )

  function showToast(message: string) {
    window.clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600)
  }

  async function generateSchema() {
    if (indexing) {
      showToast('Document is still being indexed…')
      return
    }
    templateAbortRef.current?.abort()
    const abortController = new AbortController()
    templateAbortRef.current = abortController
    const inputsKey = annotationInputsKey(annotationItems, annotationsMode)
    setPinnedSchemaRevisionId(null)
    setTemplateState({ status: 'generating' })

    try {
      const pdfBlob = await (await fetch(pdfSource.url, { signal: abortController.signal })).blob()
      const template = await requestSchema(pdfBlob, pdfSource.filename, abortController.signal, {
        annotations: annotationItems.map(({ label, pageNumber }) => ({ text: label, pageNumber })),
        annotationsMode,
        markdown: documentMarkdown,
      })
      if (!abortController.signal.aborted) {
        const definition = templateToSchemaDefinition(template)
        const { recordDescription, schemaNodes: nodes } = definition
        const coordinator = schemaSaveCoordinatorRef.current
        if (coordinator) coordinator.edit(definition)
        else if (projectContextId) {
          const revision = await initializeSchemaRevision(
            projectContextId,
            definition,
            abortController.signal,
          )
          const initialized = {
            extractionSchemaId: revision.extractionSchemaId,
            schemaRevisionId: revision.schemaRevisionId,
            revisionNumber: revision.revisionNumber,
            recordDescription: revision.recordDescription,
            schemaNodes: revision.schemaNodes,
          }
          setDurableSchema(initialized)
          setSchemaSaveState({
            status: 'saved',
            acknowledged: revision,
            draft: {
              recordDescription: revision.recordDescription,
              schemaNodes: revision.schemaNodes,
            },
          })
          setPinnedSchemaRevisionId(revision.schemaRevisionId)
        }
        setTemplateState({
          status: 'ready',
          recordDescription,
          nodes,
          inputsKey,
        })
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return
      }
      setTemplateState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Schema generation failed.',
      })
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

  function changeNodes(
    nodes: SchemaNode[],
    message: string,
    recordDescription =
      templateState.status === 'ready'
        ? templateState.recordDescription
        : '',
  ) {
    if (templateState.status !== 'ready') return
    setPinnedSchemaRevisionId(null)
    schemaSaveCoordinatorRef.current?.edit({
      recordDescription,
      schemaNodes: nodes,
    })
    setTemplateState({
      ...templateState,
      recordDescription,
      nodes,
      edited: true,
    })
    showToast(message)
  }

  function changeRecordDescription(recordDescription: string) {
    if (templateState.status !== 'ready') return
    setPinnedSchemaRevisionId(null)
    schemaSaveCoordinatorRef.current?.edit({
      recordDescription,
      schemaNodes: templateState.nodes,
    })
    setTemplateState({ ...templateState, recordDescription, edited: true })
    showToast('✎ Root record description updated')
  }

  function startResize(event: React.MouseEvent) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = railWidth
    const onMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX
      setRailWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, startWidth - dx)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const statusStyles: Record<LoadState['status'], { dot: string; text?: string }> = {
    loading: { dot: 'animate-pulse bg-amber-500' },
    ready: { dot: 'bg-green' },
    error: { dot: 'bg-danger', text: 'text-danger' },
  }

  const schemaReady = templateState.status === 'ready'
  const schemaTemplate =
    templateState.status === 'ready'
      ? schemaDefinitionToTemplate({
          recordDescription: templateState.recordDescription,
          schemaNodes: templateState.nodes,
        })
      : null

  const schemaFieldCount =
    templateState.status === 'ready' ? countTemplateFields(schemaTemplate) : 0

  const schemaStale =
    templateState.status === 'ready' &&
    templateState.inputsKey !== annotationInputsKey(annotationItems, annotationsMode)

  const effectiveRailOpen = railOpen
  const effectiveRailWidth = effectiveRailOpen ? railWidth : COLLAPSED_WIDTH

  const extraction = useExtraction({
    schemaReady,
    indexing,
    initialAttempt: persistedExtraction,
    parsedDocument,
    reviewTarget:
      sourceRepresentationId && pinnedSchemaRevisionId
        ? { sourceRepresentationId, schemaRevisionId: pinnedSchemaRevisionId }
        : null,
    onTerminal: (attempt, isRerun) => {
      setSelectedInspectionId(attempt.extractionId)
      setRailTab('results')
      if (attempt.outcome === 'FAILED')
        showToast('Extraction failed — see details in Results')
      else if (attempt.outcome === 'CANCELLED')
        showToast('Extraction cancelled — no result was saved')
      else
        showToast(
          isRerun
            ? '↻ Re-run complete — view the JSON in the Results tab'
            : '✓ Extraction complete — view the JSON in the Results tab',
        )
    },
    onError: () => {
      setRailTab('results')
      showToast('Extraction failed — see details in Results')
    },
  })

  const latestAttempt = extraction.attempt
  const inspectionChoices = latestAttempt && latestReviewedExtraction && latestAttempt.extractionId !== latestReviewedExtraction.extractionId
    ? [
        { extractionId: latestAttempt.extractionId, label: 'Latest attempt' },
        { extractionId: latestReviewedExtraction.extractionId, label: 'Latest reviewed' },
      ]
    : []
  const pinnedAttempt = selectedInspectionId === latestReviewedExtraction?.extractionId
    ? latestReviewedExtraction
    : null
  const inspectedAttempt = pinnedAttempt ?? latestAttempt
  const inspectionReadOnly = Boolean(inspectedAttempt && latestAttempt && inspectedAttempt.extractionId !== latestAttempt.extractionId)
  const inspectedSnapshot = pinnedAttempt ?? (
    selectedInspectionId === persistedExtraction?.extractionId
      ? persistedExtraction
      : null
  )
  const inspectionSourceSnapshot =
    inspectedSnapshot?.sourceRepresentationRevisionId !== sourceRepresentationId
      ? inspectedSnapshot
      : null
  const inspectionDocumentMarkdown = inspectionSourceSnapshot
    ? pinnedDocIndex.status === 'ready' ? pinnedDocIndex.markdown : null
    : documentMarkdown
  const inspectionParsedDocument = inspectionSourceSnapshot
    ? pinnedDocIndex.status === 'ready' ? pinnedDocIndex.document : null
    : parsedDocument
  function selectInspection(extractionId: string) {
    const selected = extractionId === latestReviewedExtraction?.extractionId
      ? latestReviewedExtraction
      : extractionId === persistedExtraction?.extractionId
        ? persistedExtraction
        : null
    if (selected?.sourceRepresentationRevisionId !== sourceRepresentationId) {
      setPinnedDocIndex({ status: 'parsing' })
      setPinnedPage(1)
    }
    setSelectedInspectionId(extractionId)
  }

  useEffect(() => {
    if (!inspectionSourceSnapshot) return
    const controller = new AbortController()
    void Promise.all([
      readMarkdown(inspectionSourceSnapshot.sourceRepresentation.resources.markdownUrl, controller.signal),
      readParsedDocument(inspectionSourceSnapshot.sourceRepresentation.resources.parsedDocumentUrl, controller.signal),
    ]).then(([markdown, document]) => {
      if (!controller.signal.aborted) setPinnedDocIndex({ status: 'ready', markdown, document })
    }).catch((error) => {
      if (!controller.signal.aborted) setPinnedDocIndex({ status: 'error', message: error instanceof Error ? error.message : 'Snapshot loading failed.' })
    })
    return () => controller.abort()
  }, [inspectionSourceSnapshot])

  useEffect(() => {
    const container = containerRef.current
    const viewer = pdfViewerRef.current
    if (
      !container ||
      !inspectionParsedDocument ||
      inspectionSourceSnapshot ||
      inspectedAttempt?.outcome !== 'SUCCEEDED' ||
      !effectiveRailOpen ||
      railTab !== 'results' ||
      !resultPath
    )
      return
    const evidenceLinks = inspectedAttempt.evidenceLinks ?? []
    const reviewedOccurrenceIdsByAnchor = new Map(
      (inspectedAttempt?.reviewDecisions ?? []).map((decision) => [
        decision.evidenceAnchorId,
        decision.reviewedOccurrenceIds,
      ]),
    )
    const anchors = new Map(
      inspectionParsedDocument.evidence_index.anchors.map((anchor) => [anchor.anchor_id, anchor]),
    )
    const fieldNames = pinnedAttempt
      ? pinnedAttempt.extractionSchema.schemaNodes.map((node) => node.name)
      : templateState.status === 'ready'
        ? templateState.nodes.map((node) => node.name)
        : []
    const paint = () => {
      container
        .querySelectorAll('.parsed-evidence-highlight')
        .forEach((highlight) => highlight.remove())
      evidenceLinks.forEach((link, linkIndex) => {
        if (
          link.resultPath.length !== resultPath.length + 1 ||
          !resultPath.every(
            (segment, index) => segment === String(link.resultPath[index]),
          )
        )
          return
        const anchor = anchors.get(link.evidenceAnchorId)
        if (!anchor) return
        const fieldName = link.resultPath.find(
          (segment): segment is string =>
            typeof segment === 'string' && fieldNames.includes(segment),
        )
        const fieldIndex = fieldName ? fieldNames.indexOf(fieldName) : linkIndex
        const color = EVIDENCE_HIGHLIGHT_COLORS[
          fieldIndex % EVIDENCE_HIGHLIGHT_COLORS.length
        ]!
        const reviewed = reviewedOccurrenceIdsByAnchor.get(anchor.anchor_id)
        for (const occurrence of anchorOccurrences(anchor)) {
          if (reviewed && !reviewed.includes(occurrence.occurrence_id)) continue
          appendEvidenceOverlay(container, inspectionParsedDocument, occurrence, {
            className: 'parsed-evidence-highlight',
            background: color,
            evidenceAnchorId: anchor.anchor_id,
            resultPath: link.resultPath,
          })
        }
      })
    }
    paint()
    viewer?.eventBus?.on('pagerendered', paint)
    return () => {
      viewer?.eventBus?.off('pagerendered', paint)
      container
        .querySelectorAll('.parsed-evidence-highlight')
        .forEach((highlight) => highlight.remove())
    }
  }, [
    effectiveRailOpen,
    inspectedAttempt,
    inspectionParsedDocument,
    inspectionSourceSnapshot,
    pinnedAttempt,
    railTab,
    resultPath,
    templateState,
  ])

  useEffect(() => {
    if (!extractAfterSave || schemaSaveState?.status !== 'saved') return
    queueMicrotask(() => {
      setExtractAfterSave(false)
      void extraction.runExtraction()
    })
  }, [extractAfterSave, extraction, schemaSaveState?.status])

  async function runExtraction() {
    const coordinator = schemaSaveCoordinatorRef.current
    if (!coordinator) return extraction.runExtraction()
    setExtractAfterSave(true)
    try {
      await coordinator.flush()
    } catch (error) {
      setExtractAfterSave(false)
      showToast(
        error instanceof Error
          ? error.message
          : 'Save the Current Schema Revision before extraction.',
      )
    }
  }

  async function flushSchemaEdits() {
    await schemaSaveCoordinatorRef.current?.flush()
  }

  const running = extraction.state.status === 'running'
  const runLabel = running
    ? 'Cancel extraction'
    : extraction.hasResults
      ? '↻ Re-run extraction'
      : '▶ Run extraction'

  const hintText =
    extraction.hasResults
      ? 'View the extracted JSON in the Results tab'
      : schemaReady
        ? 'Press Run extraction to apply the schema across the whole document'
        : annotationItems.length === 0
          ? 'Select any passage in the report to add it to the annotation set'
          : 'Open the Schema tab to generate the extraction schema for this document'

  return (
    <div
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-canvas text-ink"
      onCopy={handleClipboard}
      onCut={handleClipboard}
      onPaste={handleClipboard}
      onKeyDown={handleKeyDown}
    >
      <header className="relative z-10 flex h-14 shrink-0 items-stretch border-b border-line bg-surface">
        <div className="flex min-w-0 flex-1 items-center gap-3 px-5 py-2.5">
          <p className="min-w-0 truncate text-[13px] text-ink-muted">
            <span className="font-semibold text-ink">{pdfSource.filename}</span>
          </p>
          {indexing && (
            <span className="shrink-0 text-xs font-medium text-ink-muted">Indexing document…</span>
          )}
          {docIndex.status === 'error' && (
            <span className="shrink-0 text-xs font-medium text-danger" title={docIndex.message}>
              Indexing failed
            </span>
          )}
          <div className="min-w-0 flex-1" />
          {inspectionChoices.length > 1 && (
            <select aria-label="Extraction snapshot" value={inspectedAttempt?.extractionId ?? ''} onChange={(event) => selectInspection(event.target.value)} className="rounded-md border border-line bg-surface px-2 py-1 text-xs">
              {inspectionChoices.map((choice) => <option key={choice.extractionId} value={choice.extractionId}>{choice.label}</option>)}
            </select>
          )}
          <p
            aria-live="polite"
            className={`hidden w-fit shrink-0 items-center gap-2 rounded-full border border-line bg-surface-muted py-1 pl-2.5 pr-3 text-xs font-medium text-ink-muted sm:inline-flex ${statusStyles[loadState.status].text ?? ''}`}
          >
            <span aria-hidden="true" className={`size-1.5 rounded-full ${statusStyles[loadState.status].dot}`} />
            {loadState.status === 'loading' && 'Loading PDF…'}
            {loadState.status === 'ready' && `${loadState.pageCount} pages · text highlights only`}
            {loadState.status === 'error' && loadState.message}
          </p>
          <Button
            variant="primary"
            size="md"
            disabled={
              !running &&
              (!extraction.canRun ||
                schemaSaveState?.status === 'conflict' ||
                schemaSaveState?.status === 'error')
            }
            title={
              running
                ? 'Cancel the active Extraction'
                : schemaReady
                  ? 'Run one values extraction across the whole Source Document'
                  : 'Generate a schema in the Schema tab first'
            }
            onClick={() =>
              running
                ? extraction.requestCancellation()
                : void runExtraction()
            }
          >
            {runLabel}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <section className="relative min-h-0 min-w-0 flex-1" aria-label="PDF document">
          <div className="pdf-viewer scrollbar-subtle absolute inset-0 overflow-auto py-4 sm:py-8" ref={setContainerNode}>
            <div className="pdfViewer" ref={setViewerNode} />
          </div>
          {inspectionSourceSnapshot && (
            <iframe title="Pinned Source Document" src={`${inspectionSourceSnapshot.sourceRepresentation.resources.sourcePdfUrl}#page=${pinnedPage}`} className="absolute inset-0 z-10 size-full border-0 bg-canvas" />
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
          className="min-h-0 shrink-0 border-l border-line bg-surface max-[859px]:!w-[calc(100vw-46px)]"
          aria-label="Annotations, chat and schema"
        >
          <RightRail
            open={effectiveRailOpen}
            onToggle={() => setRailOpen((open) => !open)}
            tab={railTab}
            onTabChange={setRailTab}
            annotationItems={annotationItems}
            onSelectAnnotation={selectAnnotationItem}
            onRemoveAnnotation={removeAnnotationItem}
            schemaState={templateState}
            schemaStale={schemaStale}
            schemaReady={schemaReady}
            schemaFieldCount={schemaFieldCount}
            onGenerate={() => void generateSchema()}
            onNodesChange={changeNodes}
            onRecordDescriptionChange={changeRecordDescription}
            beforeSchemaEdit={flushSchemaEdits}
            schemaHistory={schemaHistory}
            currentSchemaRevisionNumber={schemaSaveState?.acknowledged.revisionNumber}
            loadSchemaRevision={(schemaRevisionId) => {
              if (!projectContextId || !durableSchema)
                return Promise.reject(new Error('No durable schema is open.'))
              return getSchemaRevision(
                projectContextId,
                durableSchema.extractionSchemaId,
                schemaRevisionId,
              )
            }}
            annotationsMode={annotationsMode}
            onAnnotationsModeChange={setAnnotationsMode}
            extraction={extraction}
            inspection={{ attempt: inspectedAttempt, readOnly: inspectionReadOnly, documentMarkdown: inspectionDocumentMarkdown, parsedDocument: inspectionParsedDocument, sourceStatus: inspectionSourceSnapshot ? pinnedDocIndex : null, reviewDecisions: inspectedAttempt?.reviewDecisions ?? [], pinnedSchema: pinnedAttempt?.extractionSchema ?? null }}
            sourceDocumentName={pdfSource.filename}
            onSelectEvidence={selectEvidenceAnchor}
            onResultPathChange={setResultPath}
          />
        </aside>
      </div>
    </div>
  )
}

export default DocumentWorkspace
