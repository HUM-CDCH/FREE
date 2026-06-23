'use client'

import { useEffect, useRef, useState } from 'react'
import type { PDFViewerOptions } from 'pdfjs-dist/types/web/pdf_viewer'
import type { PDFViewer, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { AnnotationSetItem } from './AnnotationSidebar'
import ProjectNav from './ProjectNav'
import { ACTIVE_DOC } from './ProjectNav'
import ProviderSettingsControl from './ProviderSettingsControl'
import RightRail from './RightRail'
import type { RailTab } from './RightRail'
import type { TemplateState } from './SchemaPanel'
import { countTemplateFields } from './template'
import { requestTemplate } from './api'
import type { AnnotationsMode } from './api'
import { useExtraction } from './useExtraction'
import type { AnnotationEditorUIManager } from 'pdfjs-dist'
import type { AnnotationEditor } from 'pdfjs-dist/types/src/display/editor/editor'
import { DEFAULT_PROVIDER, normalizeProviderSettings } from '../lib/provider-settings'

const COLLAPSED_WIDTH = 46
const NAV_MIN = 150
const NAV_MAX = 400
const RAIL_MIN = 264
const RAIL_MAX = 560
const ANNOTATION_HIGHLIGHT_COLORS = 'annotation=#FFF066'
const PROVIDER_STORAGE_KEY = 'free-ai-sdk-provider-settings'

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

function elementFromNode(node: EventTarget | Node | null) {
  if (node instanceof Element) {
    return node
  }
  if (node instanceof Node) {
    return node.parentElement
  }
  return null
}

function isEditableClipboardTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

function selectionIntersectsElement(element: Element) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) {
    return false
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (element.contains(elementFromNode(selection.getRangeAt(index).commonAncestorContainer))) {
      return true
    }
  }

  return false
}

function selectionIntersectsPdfTextLayer(pdfContainer: Element) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.toString().trim() === '') {
    return false
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)
    const rangeNodes = [range.commonAncestorContainer, range.startContainer, range.endContainer]

    if (
      rangeNodes.some((node) => {
        const element = elementFromNode(node)
        return Boolean(element?.closest('.textLayer') && pdfContainer.contains(element))
      })
    ) {
      return true
    }
  }

  return false
}

function shouldKeepClipboardEventFromPdfJs(event: ClipboardEvent, pdfContainer: Element) {
  const targetElement = elementFromNode(event.target)
  const targetInsidePdf = Boolean(targetElement && pdfContainer.contains(targetElement))

  if (event.type === 'copy' && selectionIntersectsPdfTextLayer(pdfContainer)) {
    return true
  }

  if (targetInsidePdf) {
    return false
  }

  if (event.type === 'copy') {
    return isEditableClipboardTarget(event.target) || !selectionIntersectsElement(pdfContainer)
  }

  return isEditableClipboardTarget(event.target)
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
  const toastTimerRef = useRef<number | undefined>(undefined)
  const [annotationItems, setAnnotationItems] = useState<AnnotationSetItem[]>([])
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [templateState, setTemplateState] = useState<TemplateState>({ status: 'idle' })
  const [annotationsMode, setAnnotationsMode] = useState<AnnotationsMode>('hints')
  const [navOpen, setNavOpen] = useState(true)
  const [navWidth, setNavWidth] = useState(212)
  const [railOpen, setRailOpen] = useState(true)
  const [railWidth, setRailWidth] = useState(344)
  const [railTab, setRailTab] = useState<RailTab>('annot')
  const [toast, setToast] = useState<string | null>(null)
  const [providerSettings, setProviderSettings] = useState(DEFAULT_PROVIDER)
  const [pdfSource, setPdfSource] = useState<{ url: string; filename: string } | null>({
    url: `/${ACTIVE_DOC}`,
    filename: ACTIVE_DOC,
  })
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setPdfSource({ url: URL.createObjectURL(file), filename: file.name })
    setAnnotationItems([])
    setTemplateState({ status: 'idle' })
    event.target.value = ''
  }

  useEffect(() => {
    const sourceUrl = pdfSource?.url
    return () => {
      if (sourceUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(sourceUrl)
      }
    }
  }, [pdfSource?.url])

  useEffect(() => {
    templateAbortRef.current?.abort()
    templateAbortRef.current = null
    setTemplateState({ status: 'idle' })
  }, [pdfSource?.url])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const keepAppClipboardEventsFromPdfJs = (event: ClipboardEvent) => {
      if (shouldKeepClipboardEventFromPdfJs(event, container)) {
        event.stopImmediatePropagation()
      }
    }

    document.addEventListener('copy', keepAppClipboardEventsFromPdfJs, { capture: true })
    document.addEventListener('cut', keepAppClipboardEventsFromPdfJs, { capture: true })
    document.addEventListener('paste', keepAppClipboardEventsFromPdfJs, { capture: true })

    return () => {
      document.removeEventListener('copy', keepAppClipboardEventsFromPdfJs, { capture: true })
      document.removeEventListener('cut', keepAppClipboardEventsFromPdfJs, { capture: true })
      document.removeEventListener('paste', keepAppClipboardEventsFromPdfJs, { capture: true })
    }
  }, [])

  useEffect(() => {
    if (!pdfSource) return
    const activeSource = pdfSource
    const container = containerRef.current
    const viewer = viewerRef.current
    if (!container || !viewer) {
      return
    }
    const containerElement = container
    const viewerElement = viewer

    const abortController = new AbortController()
    let eventBus: EventBus | null = null
    let pdfViewer: PDFViewer | null = null
    let loadingTask: { promise: Promise<unknown>; destroy: () => Promise<void> } | null = null

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

    async function loadPdf() {
      try {
        const pdfjsLib = await import('pdfjs-dist')
        const viewerModule = await import('pdfjs-dist/web/pdf_viewer.mjs')
        if (abortController.signal.aborted) {
          return
        }

        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.mjs',
          import.meta.url,
        ).toString()

        const { PDFViewer: RuntimePDFViewer, EventBus: RuntimeEventBus } = viewerModule
        eventBus = new RuntimeEventBus()

        const viewerOptions: PDFViewerOptions = {
          container: containerElement,
          viewer: viewerElement,
          eventBus,
          annotationMode: pdfjsLib.AnnotationMode.ENABLE,
          annotationEditorMode: pdfjsLib.AnnotationEditorType.HIGHLIGHT,
          annotationEditorHighlightColors: ANNOTATION_HIGHLIGHT_COLORS,
        }

        // pdfjs-dist 6 supports abortSignal at runtime, but its PDFViewerOptions type omits it.
        const abortableViewerOptions = {
          ...viewerOptions,
          abortSignal: abortController.signal,
        }

        pdfViewer = new RuntimePDFViewer(abortableViewerOptions)
        pdfViewerRef.current = pdfViewer
        eventBus.on('annotationeditoruimanager', onAnnotationEditorUIManager)

        loadingTask = pdfjsLib.getDocument({ url: activeSource.url })
        const pdf = (await loadingTask.promise) as { numPages: number }
        if (abortController.signal.aborted) {
          return
        }

        ;(pdfViewer.setDocument as (pdfDocument: unknown) => void)(pdf)
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
      if (eventBus) {
        eventBus.off('annotationeditoruimanager', onAnnotationEditorUIManager)
      }
      pdfViewerRef.current = null
      annotationManagerRef.current = null
      // Runtime setDocument(null) clears viewer state, but the shipped type omits null.
      ;(pdfViewer?.setDocument as ((pdfDocument: unknown | null) => void) | undefined)?.call(pdfViewer, null)
      abortController.abort()
      void loadingTask?.destroy()
    }
  }, [pdfSource])

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

  useEffect(() => {
    const stored = window.localStorage.getItem(PROVIDER_STORAGE_KEY)
    if (!stored) {
      return
    }
    try {
      setProviderSettings(normalizeProviderSettings(JSON.parse(stored)))
    } catch {
      window.localStorage.removeItem(PROVIDER_STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(providerSettings))
  }, [providerSettings])

  function showToast(message: string) {
    window.clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600)
  }

  async function generateTemplate() {
    if (!pdfSource) return
    templateAbortRef.current?.abort()
    const abortController = new AbortController()
    templateAbortRef.current = abortController
    const inputsKey = annotationInputsKey(annotationItems, annotationsMode)
    setTemplateState({ status: 'generating' })

    try {
      const pdfBlob = await (await fetch(pdfSource.url, { signal: abortController.signal })).blob()
      const template = await requestTemplate(pdfBlob, abortController.signal, {
        annotations: annotationItems.map(({ label, pageNumber }) => ({ text: label, pageNumber })),
        annotationsMode,
        providerSettings,
      })
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

  function changeTemplate(template: unknown, message: string) {
    setTemplateState((state) =>
      state.status === 'ready' ? { ...state, template, edited: true } : state,
    )
    showToast(message)
  }

  function startResize(event: React.MouseEvent, side: 'nav' | 'rail') {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = side === 'nav' ? navWidth : railWidth
    const onMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX
      if (side === 'nav') {
        setNavWidth(Math.min(NAV_MAX, Math.max(NAV_MIN, startWidth + dx)))
      } else {
        setRailWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, startWidth - dx)))
      }
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
  const schemaTemplate = templateState.status === 'ready' ? templateState.template : null

  const schemaFieldCount =
    templateState.status === 'ready' ? countTemplateFields(templateState.template) : 0

  const schemaStale =
    templateState.status === 'ready' &&
    templateState.inputsKey !== annotationInputsKey(annotationItems, annotationsMode)

  const extraction = useExtraction({
    source: pdfSource,
    template: schemaTemplate,
    schemaReady,
    providerSettings,
    onComplete: (isRerun) => {
      setRailTab('results')
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

  let runLabel = '▶ Run extraction'
  if (extraction.state.status === 'running') {
    runLabel = 'Running…'
  } else if (extraction.hasResults) {
    runLabel = '↻ Re-run extraction'
  }

  let runButtonClasses = 'cursor-default border-line bg-line text-ink-muted'
  if (extraction.canRun) {
    runButtonClasses = 'cursor-pointer border-accent bg-accent text-white hover:brightness-108'
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
    <main className="flex h-dvh flex-col bg-canvas text-ink">
      <header className="relative z-10 flex shrink-0 items-stretch border-b border-line bg-surface">
        <div
          style={{ width: navOpen ? navWidth : COLLAPSED_WIDTH }}
          className={`flex shrink-0 items-center gap-2.5 border-r border-line ${
            navOpen ? 'justify-start px-4' : 'justify-center px-2'
          }`}
        >
          <img src="/free-logo.png" alt="" className="size-7.5 shrink-0 object-contain" />
          {navOpen && <h1 className="text-[17px] font-extrabold tracking-[0.06em]">FREE</h1>}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3 px-5 py-2.5">
          {pdfSource ? (
            <p className="min-w-0 truncate text-[13px] text-ink-muted">
              <span className="font-semibold text-ink">{pdfSource.filename}</span>
            </p>
          ) : (
            <p className="text-[13px] text-ink-faint">No source document open</p>
          )}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 rounded border border-line bg-surface px-2 py-1 text-xs text-ink-muted transition-colors hover:border-accent/50 hover:text-accent"
          >
            {pdfSource ? 'Switch PDF' : 'Open PDF'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="sr-only"
            onChange={handleFileChange}
          />
          <div className="min-w-0 flex-1" />
          <ProviderSettingsControl value={providerSettings} onChange={setProviderSettings} />
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
            className={`shrink-0 rounded-lg border px-3.75 py-1.75 text-[13px] font-bold outline-none transition-[filter] focus-visible:ring-2 focus-visible:ring-accent/40 ${runButtonClasses}`}
            type="button"
            disabled={!extraction.canRun}
            title={schemaReady ? 'Run extraction across the whole document' : 'Generate a schema in the Schema tab first'}
            onClick={() => void extraction.runExtraction()}
          >
            {runLabel}
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          style={{ width: navOpen ? navWidth : COLLAPSED_WIDTH }}
          className="min-h-0 shrink-0 border-r border-line bg-surface"
          aria-label="Project navigation"
        >
          <ProjectNav open={navOpen} onToggle={() => setNavOpen((open) => !open)} onToast={showToast} />
        </aside>
        {navOpen && (
          <div
            className="z-5 -ml-0.75 w-1.25 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent-soft"
            title="Drag to resize"
            onMouseDown={(event) => startResize(event, 'nav')}
          />
        )}
        <section className="relative min-h-0 min-w-0 flex-1" aria-label="PDF document">
          <div className="pdf-viewer scrollbar-subtle absolute inset-0 overflow-auto py-4 sm:py-8" ref={containerRef}>
            <div className="pdfViewer" ref={viewerRef} />
          </div>
          {extraction.state.status === 'running' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-canvas/85 backdrop-blur-[2px]">
              <div className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-surface px-11 py-7.5 shadow-float">
                <span
                  aria-hidden="true"
                  className="animate-spin-slow size-8.5 rounded-full border-[3px] border-line border-t-accent"
                />
                <p className="font-mono text-[13px] font-semibold text-ink">
                  Extracting structured results…
                </p>
                <p className="text-xs text-ink-muted">Applying the schema across the document</p>
              </div>
            </div>
          )}
          {!pdfSource && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-canvas">
              <p className="text-sm text-ink-muted">Open a source document to get started</p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="cursor-pointer rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-accent/50 hover:text-accent"
              >
                Open PDF
              </button>
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
        {railOpen && (
          <div
            className="z-5 -mr-0.75 w-1.25 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent-soft"
            title="Drag to resize"
            onMouseDown={(event) => startResize(event, 'rail')}
          />
        )}
        <aside
          style={{ width: railOpen ? railWidth : COLLAPSED_WIDTH }}
          className="min-h-0 shrink-0 border-l border-line bg-surface"
          aria-label="Annotations, chat and schema"
        >
          <RightRail
            open={railOpen}
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
            onGenerate={() => void generateTemplate()}
            onTemplateChange={changeTemplate}
            annotationsMode={annotationsMode}
            onAnnotationsModeChange={setAnnotationsMode}
            extraction={extraction}
            providerSettings={providerSettings}
            pdfSource={pdfSource}
          />
        </aside>
      </div>
    </main>
  )
}

export default App
