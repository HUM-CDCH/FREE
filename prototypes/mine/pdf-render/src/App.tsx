import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfUrl from './assets/Beretning_Ellekilde_8_13.pdf?url'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { PDFViewer, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PDFViewerOptions } from 'pdfjs-dist/types/web/pdf_viewer'
import AnnotationSidebar from './AnnotationSidebar'
import type { AnnotationSetItem } from './AnnotationSidebar'
import SchemaPanel from './SchemaPanel'
import type { TemplateState } from './SchemaPanel'
import { countTemplateFields } from './template'
import { requestTemplate } from './api'
import type { AnnotationsMode } from './api'
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

function getHighlightLabel(editor: AnnotationEditor) {
  return editor.div?.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim() ?? ''
}

function isHighlightEditor(editor: AnnotationEditor) {
  return editor.editorType === 'highlight' || editor.div?.getAttribute('role') === 'mark'
}

// Mode only shapes the request when annotations are sent (see requestTemplate),
// so an empty set keys to '' regardless of mode.
function annotationInputsKey(items: AnnotationSetItem[], mode: AnnotationsMode) {
  if (items.length === 0) {
    return ''
  }
  return [mode, ...items.map((item) => item.id).sort()].join('\n')
}

function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const pdfViewerRef = useRef<PDFViewer | null>(null)
  const annotationManagerRef = useRef<AnnotationEditorUIManager | null>(null)
  const templateAbortRef = useRef<AbortController | null>(null)
  const [annotationItems, setAnnotationItems] = useState<AnnotationSetItem[]>([])
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [templateState, setTemplateState] = useState<TemplateState>({ status: 'idle' })
  const [annotationsMode, setAnnotationsMode] = useState<AnnotationsMode>('hints')
  const [schemaOpen, setSchemaOpen] = useState(false)

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

  useEffect(() => () => templateAbortRef.current?.abort(), [])

  async function generateTemplate() {
    templateAbortRef.current?.abort()
    const abortController = new AbortController()
    templateAbortRef.current = abortController
    const inputsKey = annotationInputsKey(annotationItems, annotationsMode)
    setTemplateState({ status: 'generating', raw: '' })

    try {
      const pdfBlob = await (await fetch(pdfUrl, { signal: abortController.signal })).blob()
      const template = await requestTemplate(
        pdfBlob,
        'Beretning_Ellekilde_8_13.pdf',
        (output) => {
          // Buffered deltas from an aborted request can still arrive after the
          // next generation has reset the stream; drop them.
          if (abortController.signal.aborted) {
            return
          }
          setTemplateState((state) =>
            state.status === 'generating' ? { status: 'generating', raw: state.raw + output } : state,
          )
        },
        abortController.signal,
        {
          annotations: annotationItems.map(({ label, pageNumber }) => ({ text: label, pageNumber })),
          annotationsMode,
        },
      )
      if (!abortController.signal.aborted) {
        setTemplateState({ status: 'ready', template, inputsKey })
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return
      }
      setTemplateState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Template generation failed.',
      })
    }
  }

  const statusStyles: Record<LoadState['status'], { dot: string; text?: string }> = {
    loading: { dot: 'animate-pulse bg-amber-500' },
    ready: { dot: 'bg-emerald-500 dark:bg-emerald-400' },
    error: { dot: 'bg-danger', text: 'text-danger' },
  }

  const schemaFieldCount =
    templateState.status === 'ready' ? countTemplateFields(templateState.template) : 0

  const schemaStale =
    templateState.status === 'ready' &&
    templateState.inputsKey !== annotationInputsKey(annotationItems, annotationsMode)

  const hintText =
    annotationItems.length === 0
      ? 'Select any passage in the report to add it to the annotation set'
      : templateState.status === 'ready'
        ? 'Click an annotation to jump back to its passage in the source'
        : 'Open Schema to generate the extraction schema for this document'

  return (
    <main className="flex h-dvh flex-col bg-canvas text-ink">
      <header className="relative z-10 flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2.5 sm:px-5">
        <img src="/free-logo.png" alt="" className="size-7 shrink-0 object-contain" />
        <h1 className="text-[15px] font-bold tracking-[0.04em]">FREE</h1>
        <p className="hidden min-w-0 truncate text-[13px] text-ink-muted md:block">
          Ellekilde, TAK 1355 <span className="mx-1 text-ink-faint">›</span>
          <span className="font-semibold text-ink">Beretning_Ellekilde_8_13.pdf</span>
        </p>
        <div className="min-w-0 flex-1" />
        <p
          aria-live="polite"
          className={`hidden w-fit shrink-0 items-center gap-2 rounded-full border border-line bg-surface-muted py-1 pl-2.5 pr-3 text-xs font-medium text-ink-muted sm:inline-flex ${statusStyles[loadState.status].text ?? ''}`}
        >
          <span aria-hidden="true" className={`size-1.5 rounded-full ${statusStyles[loadState.status].dot}`} />
          {loadState.status === 'loading' && 'Loading PDF…'}
          {loadState.status === 'ready' && `${loadState.pageCount} pages · text highlights only`}
          {loadState.status === 'error' && loadState.message}
        </p>
        <button
          className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 ${
            schemaOpen
              ? 'border-accent/50 bg-accent-soft text-accent'
              : 'border-line bg-surface text-ink-muted hover:border-accent/50 hover:text-accent'
          }`}
          type="button"
          aria-expanded={schemaOpen}
          onClick={() => setSchemaOpen((open) => !open)}
        >
          Schema
          <span
            className={`inline-grid h-4.5 min-w-5.5 place-items-center rounded-full px-1.5 text-[11px] font-semibold leading-none tabular-nums ${
              schemaFieldCount > 0 ? 'bg-accent-soft text-accent' : 'bg-surface-muted text-ink-faint'
            }`}
          >
            {schemaFieldCount}
          </span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {schemaOpen && (
          <SchemaPanel
            state={templateState}
            stale={schemaStale}
            onGenerate={() => void generateTemplate()}
            annotationCount={annotationItems.length}
            annotationsMode={annotationsMode}
            onAnnotationsModeChange={setAnnotationsMode}
          />
        )}
        <section className="relative min-h-0 min-w-0 flex-1" aria-label="PDF document">
          <div className="pdf-viewer scrollbar-subtle absolute inset-0 overflow-auto py-4 sm:py-8" ref={containerRef}>
            <div className="pdfViewer" ref={viewerRef} />
          </div>
          <div className="pointer-events-none absolute inset-x-4 bottom-4 z-10 hidden justify-center sm:flex">
            <p className="flex min-w-0 items-center gap-2 rounded-full bg-ink px-4 py-2 text-xs font-medium text-canvas shadow-float">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
              <span className="truncate">{hintText}</span>
            </p>
          </div>
        </section>
        <AnnotationSidebar
          items={annotationItems}
          onSelectItem={selectAnnotationItem}
          onRemoveItem={removeAnnotationItem}
        />
      </div>
    </main>
  )
}

export default App
