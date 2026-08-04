import { useEffect, useRef, useState } from 'react'
import { requestExtraction } from './api'
import type { ExtractionState } from './extraction'
import { stripDescriptions, compileInstructions } from './template'

type PdfSource = { url: string; filename: string }

type UseExtractionOptions = {
  pdfSource: PdfSource | null
  template: unknown
  schemaReady: boolean
  markdown: string | null
  indexing: boolean
  onComplete: (isRerun: boolean) => void
  onError: (message: string) => void
  initialState?: ExtractionState
}

export type ExtractionController = ReturnType<typeof useExtraction>

export function useExtraction({
  pdfSource,
  template,
  schemaReady,
  markdown,
  indexing,
  onComplete,
  onError,
  initialState = { status: 'idle' },
}: UseExtractionOptions) {
  const [state, setState] = useState<ExtractionState>(initialState)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const hasResults = state.status === 'ready'
  const canRun = Boolean(pdfSource) && schemaReady && state.status !== 'running' && !indexing

  async function runExtraction() {
    if (state.status === 'running' || !pdfSource) {
      return
    }
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    const isRerun = state.status === 'ready'
    setState({ status: 'running' })

    try {
      const blob = await (await fetch(pdfSource.url, { signal: abortController.signal })).blob()
      const cleanTemplate = stripDescriptions(template)
      const rawInstructions = compileInstructions(template)
      const instruction = rawInstructions ? `Field descriptions:\n${rawInstructions}` : undefined
      const { result, evidence } = await requestExtraction(
        blob,
        pdfSource.filename,
        { records: [cleanTemplate] },
        abortController.signal,
        markdown,
        instruction,
      )
      if (abortController.signal.aborted) {
        return
      }
      setState({ status: 'ready', result, evidence })
      onComplete(isRerun)
    } catch (error) {
      if (abortController.signal.aborted) {
        return
      }
      const message = error instanceof Error ? error.message : 'Extraction failed.'
      setState({ status: 'error', message })
      onError(message)
    }
  }

  return {
    state,
    canRun,
    hasResults,
    runExtraction,
  }
}
