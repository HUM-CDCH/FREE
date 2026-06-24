import { useEffect, useRef, useState } from 'react'
import { requestExtraction } from './api'
import type { ExtractionState } from './extraction'

type UseExtractionOptions = {
  template: unknown
  schemaReady: boolean
  pdfSource: { url: string; filename: string } | null
  onComplete: (isRerun: boolean) => void
  onError: (message: string) => void
}

export type ExtractionController = ReturnType<typeof useExtraction>

export function useExtraction({
  template,
  schemaReady,
  pdfSource,
  onComplete,
  onError,
}: UseExtractionOptions) {
  const [state, setState] = useState<ExtractionState>({ status: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const hasResults = state.status === 'ready'
  const canRun = Boolean(pdfSource) && schemaReady && state.status !== 'running'

  async function runExtraction() {
    if (state.status === 'running') {
      return
    }
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    const isRerun = state.status === 'ready'
    setState({ status: 'running' })

    try {
      if (!pdfSource) {
        return
      }
      const blob = await (await fetch(pdfSource.url, { signal: abortController.signal })).blob()
      const result = await requestExtraction(blob, pdfSource.filename, template, abortController.signal)
      if (abortController.signal.aborted) {
        return
      }
      setState({ status: 'ready', result })
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
