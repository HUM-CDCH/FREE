import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { PDFViewer, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PDFViewerOptions } from 'pdfjs-dist/types/web/pdf_viewer'
import type { AnnotationSetItem } from './AnnotationSidebar'
import RightRail from './RightRail'
import type { RailTab } from './RightRail'
import type { TemplateState } from './SchemaPanel'
import type { SchemaNode } from './schemaNode'
import { templateToNodes, nodesToTemplate } from './schemaNode'
import { countTemplateFields } from './template'
import type { SchemaHistoryEntry } from './schemaHistory'
import { appendSchemaHistoryEntry, clearSchemaHistory, loadSchemaHistory } from './schemaHistory'
import { requestSchema, parseDocumentToMarkdown, fetchParsedDocumentExtras } from './api'
import type { AnnotationsMode, ExtractionStrategy } from './api'
import type { ParsedTable, EvidenceAnchor } from './parsedDocument'
import { useExtraction } from './useExtraction'
import EvidenceHighlightLayer from './EvidenceHighlightLayer'
import { Button } from './ui'
import { AnnotationEditorType, AnnotationMode } from 'pdfjs-dist'
import type { AnnotationEditorUIManager } from 'pdfjs-dist'
import type { AnnotationEditor } from 'pdfjs-dist/types/src/display/editor/editor'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const COLLAPSED_WIDTH = 46
const RAIL_MIN = 264
const RAIL_MAX = 560
const ANNOTATION_HIGHLIGHT_COLORS = 'annotation=#FFF066'

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
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null
  )
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; pageCount: number }
  | { status: 'error'; message: string }

type DocIndex =
  | { status: 'parsing'; sourceKey: string | null }
  | { status: 'ready'; sourceKey: string; markdown: string; tables: ParsedTable[]; anchors: EvidenceAnchor[] }
  | { status: 'error'; sourceKey: string | null; message: string }

function pdfSourceKey(source: { url: string; filename: string } | null) {
  return source ? `${source.url}\n${source.filename}` : null
}

async function readMarkdown(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Could not fetch Source Document Markdown (HTTP ${response.status}).`)
  }
  return response.text()
}

function getHighlightLabel(editor: AnnotationEditor) {
  return editor.div?.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim() ?? ''
}

function isHighlightEditor(editor: AnnotationEditor) {
  return editor.editorType === 'highlight' || editor.div?.getAttribute('role') === 'mark'
}

function annotationInputsKey(items: AnnotationSetItem[], mode: AnnotationsMode) {
  if (items.length === 0) {
    return ''
  }
  return [mode, ...items.map((item) => item.id).sort()].join('\n')
}

export type DocumentWorkspaceProps = {
  pdfUrl: string
  filename: string
  markdownUrl: string | null
}

export function DocumentWorkspace({
  pdfUrl,
  filename,
  markdownUrl,
}: DocumentWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const pdfViewerRef = useRef<PDFViewer | null>(null)
  const annotationManagerRef = useRef<AnnotationEditorUIManager | null>(null)
  const templateAbortRef = useRef<AbortController | null>(null)
  const toastTimerRef = useRef<number | undefined>(undefined)
  const [annotationItems, setAnnotationItems] = useState<AnnotationSetItem[]>([])
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [templateState, setTemplateState] = useState<TemplateState>({ status: 'idle' })
  const [schemaHistory, setSchemaHistory] = useState<SchemaHistoryEntry[]>(() => loadSchemaHistory())
  const [annotationsMode, setAnnotationsMode] = useState<AnnotationsMode>('hints')
  const [extractionStrategy, setExtractionStrategy] = useState<ExtractionStrategy>('article')
  const [railOpen, setRailOpen] = useState(true)
  const [railWidth, setRailWidth] = useState(344)
  const [railTab, setRailTab] = useState<RailTab>('annot')
  const [toast, setToast] = useState<string | null>(null)
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const [activePdfViewer, setActivePdfViewer] = useState<PDFViewer | null>(null)
  const [focusPath, setFocusPath] = useState<string[] | null>(null)
  const pdfSource = useMemo(
    () => ({ url: pdfUrl, filename }),
    [filename, pdfUrl],
  )
  const [docIndex, setDocIndex] = useState<DocIndex>(() => ({
    status: 'parsing',
    sourceKey: pdfSourceKey({ url: pdfUrl, filename }),
  }))

  const currentSourceKey = pdfSourceKey(pdfSource)
  const docIndexMatchesCurrent = docIndex.sourceKey === currentSourceKey
  const indexing = !docIndexMatchesCurrent || docIndex.status === 'parsing'
  const documentMarkdown = docIndexMatchesCurrent && docIndex.status === 'ready' ? docIndex.markdown : null
  const documentTables = docIndexMatchesCurrent && docIndex.status === 'ready' ? docIndex.tables : []
  const documentAnchors = docIndexMatchesCurrent && docIndex.status === 'ready' ? docIndex.anchors : []

  const setContainerNode = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node
    setContainerEl(node)
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

    const pdfViewer = new PDFViewer({
      ...viewerOptions,
      abortSignal: abortController.signal,
    } as PDFViewerOptions & { abortSignal: AbortSignal })

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
    setActivePdfViewer(pdfViewer)
    annotationManagerRef.current = null
    setAnnotationItems([])
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

    const onAnnotationEditorUIManager = ({ uiManager }: { uiManager: AnnotationEditorUIManager }) => {
      annotationManagerRef.current = uiManager

      const { addEditor, removeEditor } = uiManager

      uiManager.addEditor = (editor) => {
        addEditor.call(uiManager, editor)
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
      }
    }

    void loadPdf()

    return () => {
      eventBus.off('annotationeditoruimanager', onAnnotationEditorUIManager)
      pdfViewerRef.current = null
      setActivePdfViewer(null)
      annotationManagerRef.current = null
      ;(pdfViewer.setDocument as (pdfDocument: pdfjsLib.PDFDocumentProxy | null) => void).call(
        pdfViewer,
        null,
      )
      abortController.abort()
      void loadingTask.destroy()
    }
  }, [pdfSource])

  useEffect(() => {
    templateAbortRef.current?.abort()
    templateAbortRef.current = null
    setAnnotationItems([])
    setTemplateState({ status: 'idle' })
    setSchemaHistory(clearSchemaHistory())
    setExtractionStrategy('article')
  }, [currentSourceKey])

  useEffect(() => {
    const abortController = new AbortController()
    const sourceKey = pdfSourceKey(pdfSource)

    void (async () => {
      setDocIndex({ status: 'parsing', sourceKey })
      try {
        const devTaskId = import.meta.env.VITE_DEV_TASK_ID as string | undefined
        let markdown: string
        let taskId: string | null = null

        if (markdownUrl) {
          markdown = await readMarkdown(markdownUrl, abortController.signal)
        } else if (devTaskId) {
          taskId = devTaskId
          markdown = await readMarkdown(
            `${import.meta.env.VITE_PARSING_SERVICE_URL ?? 'http://127.0.0.1:8000'}/tasks/${devTaskId}/markdown`,
            abortController.signal,
          )
        } else {
          const parsed = await parseDocumentToMarkdown(
            await (await fetch(pdfSource.url, { signal: abortController.signal })).blob(),
            pdfSource.filename,
            abortController.signal,
          )
          taskId = parsed.taskId
          markdown = parsed.markdown
        }

        const extras = taskId
          ? await fetchParsedDocumentExtras(taskId, abortController.signal).catch(() => ({ tables: [], anchors: [] }))
          : { tables: [], anchors: [] }

        if (!abortController.signal.aborted) {
          setDocIndex({ status: 'ready', sourceKey: sourceKey!, markdown, ...extras })
        }
      } catch (error) {
        if (abortController.signal.aborted) return
        setDocIndex({
          status: 'error',
          sourceKey,
          message: error instanceof Error ? error.message : 'Document indexing failed.',
        })
      }
    })()

    return () => abortController.abort()
  }, [markdownUrl, pdfSource])

  function selectAnnotationItem(id: string) {
    const manager = annotationManagerRef.current
    const editor = manager?.getEditor(id)
    if (!manager || !editor) {
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
    annotationManagerRef.current?.getEditor(id)?.remove()
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

  async function generateSchema(strategy: ExtractionStrategy = extractionStrategy) {
    if (indexing) {
      showToast('Document is still being indexed...')
      return
    }
    templateAbortRef.current?.abort()
    const abortController = new AbortController()
    templateAbortRef.current = abortController
    const inputsKey = annotationInputsKey(annotationItems, annotationsMode)
    setTemplateState({ status: 'generating' })

    try {
      const pdfBlob = await (await fetch(pdfSource.url, { signal: abortController.signal })).blob()
      const template = await requestSchema(pdfBlob, pdfSource.filename, abortController.signal, {
        annotations: annotationItems.map(({ label, pageNumber }) => ({ text: label, pageNumber })),
        annotationsMode,
        markdown: documentMarkdown,
        strategy,
      })
      if (!abortController.signal.aborted) {
        const nodes = templateToNodes(template)
        setTemplateState({ status: 'ready', nodes, inputsKey })
        setSchemaHistory(appendSchemaHistoryEntry(clearSchemaHistory(), nodes, 'Schema generated'))
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

  function handleExtractionStrategyChange(strategy: ExtractionStrategy) {
    setExtractionStrategy(strategy)
    if (templateState.status !== 'idle') {
      showToast(`Regenerating schema for ${strategy === 'catalog' ? 'Catalog' : 'Article'}...`)
      void generateSchema(strategy)
    }
  }

  function handleValueClick(path: string[]) {
    setFocusPath(path)
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

  function changeNodes(nodes: SchemaNode[], message: string) {
    setTemplateState((state) =>
      state.status === 'ready' ? { ...state, nodes, edited: true } : state,
    )
    showToast(message)
    setSchemaHistory((history) => appendSchemaHistoryEntry(history, nodes, message))
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
  const schemaTemplate = templateState.status === 'ready' ? nodesToTemplate(templateState.nodes) : null
  const schemaFieldCount = templateState.status === 'ready' ? countTemplateFields(schemaTemplate) : 0

  const schemaStale =
    templateState.status === 'ready' &&
    templateState.inputsKey !== annotationInputsKey(annotationItems, annotationsMode)

  const effectiveRailOpen = railOpen
  const effectiveRailWidth = effectiveRailOpen ? railWidth : COLLAPSED_WIDTH

  const extraction = useExtraction({
    pdfSource,
    template: schemaTemplate,
    schemaReady,
    markdown: documentMarkdown,
    hasTables: documentTables.length > 0,
    indexing,
    extractionStrategy,
    onComplete: (isRerun) => {
      setRailTab('results')
      setFocusPath(null)
      showToast(
        isRerun
          ? 'Re-run complete - view the JSON in the Results tab'
          : 'Extraction complete - view the JSON in the Results tab',
      )
    },
    onError: () => {
      setRailTab('results')
      showToast('Extraction failed - see details in Results')
    },
  })

  let runLabel = 'Run extraction'
  if (extraction.state.status === 'running') {
    runLabel = 'Running...'
  } else if (extraction.hasResults) {
    runLabel = 'Re-run extraction'
  }

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
            <span className="shrink-0 text-xs font-medium text-ink-muted">Indexing document...</span>
          )}
          {docIndex.status === 'error' && (
            <span className="shrink-0 text-xs font-medium text-danger" title={docIndex.message}>
              Indexing failed
            </span>
          )}
          <div className="min-w-0 flex-1" />
          <p
            aria-live="polite"
            className={`hidden w-fit shrink-0 items-center gap-2 rounded-full border border-line bg-surface-muted py-1 pl-2.5 pr-3 text-xs font-medium text-ink-muted sm:inline-flex ${statusStyles[loadState.status].text ?? ''}`}
          >
            <span aria-hidden="true" className={`size-1.5 rounded-full ${statusStyles[loadState.status].dot}`} />
            {loadState.status === 'loading' && 'Loading PDF...'}
            {loadState.status === 'ready' && `${loadState.pageCount} pages - text highlights only`}
            {loadState.status === 'error' && loadState.message}
          </p>
          <Button
            variant="primary"
            size="md"
            disabled={!extraction.canRun}
            title={schemaReady ? 'Run extraction across the whole document' : 'Generate a schema in the Schema tab first'}
            onClick={() => void extraction.runExtraction()}
          >
            {runLabel}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <section className="relative min-h-0 min-w-0 flex-1" aria-label="PDF document">
          <div className="pdf-viewer scrollbar-subtle absolute inset-0 overflow-auto py-4 sm:py-8" ref={setContainerNode}>
            <div className="pdfViewer" ref={setViewerNode} />
            <EvidenceHighlightLayer
              pdfViewer={activePdfViewer}
              result={extraction.state.status === 'ready' ? extraction.state.result : null}
              evidence={extraction.state.status === 'ready' ? extraction.state.evidence : null}
              schemaTemplate={schemaTemplate}
              containerEl={containerEl}
              focusPath={focusPath}
              tables={documentTables}
              markdown={documentMarkdown}
              anchors={documentAnchors}
            />
          </div>
          {extraction.state.status === 'running' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-canvas/85 backdrop-blur-[2px]">
              <div className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface px-11 py-7.5 shadow-float">
                <span
                  aria-hidden="true"
                  className="animate-spin-slow size-8.5 rounded-full border-[3px] border-line border-t-accent"
                />
                <p className="font-mono text-[13px] font-semibold text-ink">
                  Extracting structured results...
                </p>
                <p className="text-xs text-ink-muted">Applying the schema across the document</p>
              </div>
            </div>
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
            onChatSchemaChange={changeNodes}
            schemaHistory={schemaHistory}
            extractionStrategy={extractionStrategy}
            onExtractionStrategyChange={handleExtractionStrategyChange}
            annotationsMode={annotationsMode}
            onAnnotationsModeChange={setAnnotationsMode}
            extraction={extraction}
            documentMarkdown={documentMarkdown}
            onValueClick={handleValueClick}
            focusPath={focusPath}
            onClearFocus={() => setFocusPath(null)}
          />
        </aside>
      </div>
    </div>
  )
}

export default DocumentWorkspace
