import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfUrl from './assets/Beretning_Ellekilde_8_13.pdf?url'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { PDFViewer, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PDFViewerOptions } from 'pdfjs-dist/types/web/pdf_viewer'
import 'pdfjs-dist/web/pdf_viewer.css'
import AnnotationSidebar from './AnnotationSidebar'
import type { AnnotationSetItem } from './AnnotationSidebar'
import { AnnotationEditorType, AnnotationMode } from 'pdfjs-dist'
import type { AnnotationEditorUIManager } from 'pdfjs-dist'
import type { AnnotationEditor } from 'pdfjs-dist/types/src/display/editor/editor'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

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

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; pageCount: number }
  | { status: 'error'; message: string }

function getHighlightLabel(editor: AnnotationEditor, fallbackIndex: number) {
  const label = editor.div?.getAttribute('aria-label')?.trim()
  return label ? label : `Highlight ${fallbackIndex}`
}

function isHighlightEditor(editor: AnnotationEditor) {
  return editor.editorType === 'highlight' || editor.div?.getAttribute('role') === 'mark'
}

function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const pdfViewerRef = useRef<PDFViewer | null>(null)
  const annotationManagerRef = useRef<AnnotationEditorUIManager | null>(null)
  const [annotationItems, setAnnotationItems] = useState<AnnotationSetItem[]>([])
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })

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

    const loadingTask = pdfjsLib.getDocument({ url: pdfUrl })
    pdfViewerRef.current = pdfViewer
    annotationManagerRef.current = null
    setAnnotationItems([])
    setLoadState({ status: 'loading' })

    const syncHighlightEditor = (editor: AnnotationEditor) => {
      if (!isHighlightEditor(editor)) {
        return
      }

      setAnnotationItems((items) => {
        const existingIndex = items.findIndex((item) => item.id === editor.id)
        const nextItem: AnnotationSetItem = {
          id: editor.id,
          label: getHighlightLabel(editor, existingIndex === -1 ? items.length + 1 : existingIndex + 1),
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
  }, [])

  function selectAnnotationItem(id: string) {
    const editor = annotationManagerRef.current?.getEditor(id)
    if (!editor) {
      return
    }

    if (editor.div) {
      editor.div.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
      return
    }

    pdfViewerRef.current?.scrollPageIntoView({ pageNumber: editor.pageIndex + 1 })
  }

  function removeAnnotationItem(id: string) {
    annotationManagerRef.current?.getEditor(id)?.remove()
  }

  const statusStyles: Record<LoadState['status'], { dot: string; text?: string }> = {
    loading: { dot: 'animate-pulse bg-amber-500' },
    ready: { dot: 'bg-emerald-500 dark:bg-emerald-400' },
    error: { dot: 'bg-danger', text: 'text-danger' },
  }

  return (
    <main className="flex h-dvh flex-col bg-canvas text-ink">
      <header className="relative z-10 flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6">
        <h1 className="truncate text-[15px] font-semibold tracking-tight">
          Beretning Ellekilde 8-13
        </h1>
        <p
          aria-live="polite"
          className={`inline-flex w-fit shrink-0 items-center gap-2 rounded-full border border-line bg-surface-muted py-1 pl-2.5 pr-3 text-xs font-medium text-ink-muted ${statusStyles[loadState.status].text ?? ''}`}
        >
          <span aria-hidden="true" className={`size-1.5 rounded-full ${statusStyles[loadState.status].dot}`} />
          {loadState.status === 'loading' && 'Loading PDF…'}
          {loadState.status === 'ready' && `${loadState.pageCount} pages · text highlights only`}
          {loadState.status === 'error' && loadState.message}
        </p>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[260px_minmax(0,1fr)] sm:grid-rows-none">
        <AnnotationSidebar
          items={annotationItems}
          onSelectItem={selectAnnotationItem}
          onRemoveItem={removeAnnotationItem}
        />
        <section className="relative min-h-0 min-w-0" aria-label="PDF document">
          <div className="pdf-viewer scrollbar-subtle absolute inset-0 overflow-auto py-4 sm:py-8" ref={containerRef}>
            <div className="pdfViewer" ref={viewerRef} />
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
