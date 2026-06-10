import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfUrl from './assets/Beretning_Ellekilde_8_13.pdf?url'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { PDFViewer, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PDFViewerOptions } from 'pdfjs-dist/types/web/pdf_viewer'
import 'pdfjs-dist/web/pdf_viewer.css'
import './App.css'
import AnnotationSidebar from './AnnotationSidebar'
import type { AnnotationSetItem } from './AnnotationSidebar'
import {
  AnnotationEditorLayer,
  AnnotationEditorType,
  AnnotationEditorUIManager,
  AnnotationMode,
} from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

let textOnlyHighlightPatchInstalled = false

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

function getTextNodesInRange(range: Range, root: Element) {
  const textNodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)

  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent || !range.intersectsNode(node)) {
      continue
    }

    textNodes.push(node as Text)
  }

  return textNodes
}

function trimRangeTrailingWhitespace(range: Range, textLayer: Element) {
  const trailingWhitespace = range.toString().match(/\s+$/)?.[0].length ?? 0
  const trimmedRange = range.cloneRange()
  if (trailingWhitespace === 0) {
    return trimmedRange
  }

  let remainingWhitespace = trailingWhitespace
  const textNodes = getTextNodesInRange(range, textLayer)
  for (let index = textNodes.length - 1; index >= 0; index -= 1) {
    const textNode = textNodes[index]
    const text = textNode.textContent ?? ''
    const startOffset = range.startContainer === textNode ? range.startOffset : 0
    const endOffset = range.endContainer === textNode ? range.endOffset : text.length
    const selectedLength = endOffset - startOffset
    if (remainingWhitespace < selectedLength) {
      trimmedRange.setEnd(textNode, endOffset - remainingWhitespace)
      return trimmedRange
    }

    remainingWhitespace -= selectedLength
  }

  trimmedRange.setEnd(range.startContainer, range.startOffset)
  return trimmedRange
}

function installTextOnlyHighlightPatch() {
  if (textOnlyHighlightPatchInstalled) {
    return
  }

  textOnlyHighlightPatchInstalled = true

  const editorLayerPrototype = AnnotationEditorLayer.prototype
  const enableTextSelection = editorLayerPrototype.enableTextSelection
  editorLayerPrototype.enableTextSelection = function enableTextSelectionWithoutFreeHighlight() {
    enableTextSelection.call(this)

    const page = this.div?.closest('.page')
    const textLayer = page?.querySelector('.textLayer')
    if (!textLayer || textLayer.getAttribute('data-text-only-highlight') === 'true') {
      return
    }

    textLayer.setAttribute('data-text-only-highlight', 'true')
    textLayer.addEventListener(
      'pointerdown',
      (event) => {
        if (!isFreeHighlightTarget(event.target)) {
          return
        }

        event.preventDefault()
        event.stopImmediatePropagation()
      },
      { capture: true },
    )
  }

  const uiManagerPrototype = AnnotationEditorUIManager.prototype
  const getSelectionBoxes = uiManagerPrototype.getSelectionBoxes
  uiManagerPrototype.getSelectionBoxes = function getSelectionBoxesWithoutTrailingWhitespace(
    textLayer: Element | null,
  ) {
    const selection = document.getSelection()
    if (!selection || !textLayer) {
      return getSelectionBoxes.call(this, textLayer)
    }

    const originalRanges: Range[] = []
    const trimmedRanges: Range[] = []
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index)
      if (range.collapsed || !textLayer.contains(range.commonAncestorContainer)) {
        return null
      }

      originalRanges.push(range.cloneRange())
      trimmedRanges.push(trimRangeTrailingWhitespace(range, textLayer))
    }

    selection.removeAllRanges()
    for (const range of trimmedRanges) {
      if (!range.collapsed) {
        selection.addRange(range)
      }
    }

    try {
      return selection.rangeCount === 0 ? null : getSelectionBoxes.call(this, textLayer)
    } finally {
      selection.removeAllRanges()
      for (const range of originalRanges) {
        selection.addRange(range)
      }
      for (const range of trimmedRanges) {
        range.detach()
      }
    }
  }
}

installTextOnlyHighlightPatch()

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; pageCount: number }
  | { status: 'error'; message: string }

type PdfAnnotationEditor = {
  id: string
  pageIndex: number
  editorType?: string
  div?: HTMLDivElement | null
  remove: () => void
}

type PdfAnnotationEditorUIManager = {
  addEditor: (editor: PdfAnnotationEditor) => void
  removeEditor: (editor: PdfAnnotationEditor) => void
  getEditor: (id: string) => PdfAnnotationEditor | undefined
}

type AnnotationEditorUIManagerEvent = {
  uiManager: PdfAnnotationEditorUIManager
}

function getHighlightLabel(editor: PdfAnnotationEditor, fallbackIndex: number) {
  const label = editor.div?.getAttribute('aria-label')?.trim()
  return label ? label : `Highlight ${fallbackIndex}`
}

function isHighlightEditor(editor: PdfAnnotationEditor) {
  return editor.editorType === 'highlight' || editor.div?.getAttribute('role') === 'mark'
}

function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const pdfViewerRef = useRef<PDFViewer | null>(null)
  const annotationManagerRef = useRef<PdfAnnotationEditorUIManager | null>(null)
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

    const loadingTask = pdfjsLib.getDocument({ url: pdfUrl })
    let disposed = false
    pdfViewerRef.current = pdfViewer
    annotationManagerRef.current = null
    setAnnotationItems([])
    setLoadState({ status: 'loading' })

    const syncHighlightEditor = (editor: PdfAnnotationEditor) => {
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
        return nextItems.sort((left, right) => left.pageNumber - right.pageNumber)
      })
    }

    const removeHighlightEditor = (editor: PdfAnnotationEditor) => {
      setAnnotationItems((items) => items.filter((item) => item.id !== editor.id))
    }

    const onAnnotationEditorUIManager = ({ uiManager }: AnnotationEditorUIManagerEvent) => {
      annotationManagerRef.current = uiManager

      const { addEditor, removeEditor } = uiManager

      uiManager.addEditor = function addEditorAndSync(
        this: PdfAnnotationEditorUIManager,
        editor: PdfAnnotationEditor,
      ) {
        addEditor.call(this, editor)
        queueMicrotask(() => syncHighlightEditor(editor))
      }

      uiManager.removeEditor = function removeEditorAndSync(
        this: PdfAnnotationEditorUIManager,
        editor: PdfAnnotationEditor,
      ) {
        removeEditor.call(this, editor)
        removeHighlightEditor(editor)
      }
    }

    eventBus.on('annotationeditoruimanager', onAnnotationEditorUIManager)

    async function loadPdf() {
      try {
        const pdf = await loadingTask.promise
        if (disposed) {
          return
        }

        pdfViewer.setDocument(pdf)
        setLoadState({ status: 'ready', pageCount: pdf.numPages })
      } catch (error) {
        if (disposed) {
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
      disposed = true
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
      viewer.replaceChildren()
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

  return (
    <main className="app-shell">
      <header className="pdf-toolbar">
        <h1>Beretning Ellekilde 8-13</h1>
        <p aria-live="polite">
          {loadState.status === 'loading' && 'Loading PDF...'}
          {loadState.status === 'ready' && `${loadState.pageCount} pages - text highlights only`}
          {loadState.status === 'error' && loadState.message}
        </p>
      </header>
      <div className="app-workspace">
        <AnnotationSidebar
          items={annotationItems}
          onSelectItem={selectAnnotationItem}
          onRemoveItem={removeAnnotationItem}
        />
        <section className="pdf-stage" aria-label="PDF document">
          <div className="pdf-viewer" ref={containerRef}>
            <div className="pdfViewer" ref={viewerRef} />
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
