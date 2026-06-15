import { useEffect, useRef, useState } from 'react'
import pdfUrl from './assets/Beretning_Ellekilde_8_13.pdf?url'
import { ACTIVE_DOC } from './ProjectNav'
import { requestExtraction } from './api'
import type { ExtractionState } from './extraction'

type UseExtractionOptions = {
  template: unknown
  schemaReady: boolean
  onComplete: (isRerun: boolean) => void
  onError: (message: string) => void
}

export type ExtractionController = ReturnType<typeof useExtraction>

export function useExtraction({
  template,
  schemaReady,
  onComplete,
  onError,
}: UseExtractionOptions) {
  const [state, setState] = useState<ExtractionState>({ status: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const hasResults = state.status === 'ready'
  const canRun = schemaReady && state.status !== 'running'

  async function runExtraction() {
    if (state.status === 'running') {
      return
    }
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    const isRerun = state.status === 'ready'
    setState({ status: 'running', raw: '' })

    try {
      const blob = await (await fetch(pdfUrl, { signal: abortController.signal })).blob()
      const result = await requestExtraction(
        blob,
        ACTIVE_DOC,
        template,
        (output) => {
          if (abortController.signal.aborted) {
            return
          }
          setState((s) => (s.status === 'running' ? { status: 'running', raw: s.raw + output } : s))
        },
        abortController.signal,
      )
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
