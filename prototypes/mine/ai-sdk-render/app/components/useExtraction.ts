import { useEffect, useRef, useState } from 'react'
import { requestExtraction } from './api'
import type { ExtractionState } from './extraction'
import type { AiProviderSettings } from '../lib/provider-settings'

type UseExtractionOptions = {
  source: { url: string; filename: string } | null
  template: unknown
  schemaReady: boolean
  providerSettings: AiProviderSettings
  onComplete: (isRerun: boolean) => void
  onError: (message: string) => void
}

export type ExtractionController = ReturnType<typeof useExtraction>

export function useExtraction({
  source,
  template,
  schemaReady,
  providerSettings,
  onComplete,
  onError,
}: UseExtractionOptions) {
  const [state, setState] = useState<ExtractionState>({ status: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    abortRef.current?.abort()
    setState({ status: 'idle' })
  }, [source?.url])

  const hasResults = state.status === 'ready'
  const canRun = Boolean(source) && schemaReady && state.status !== 'running'

  async function runExtraction() {
    if (!source || state.status === 'running') {
      return
    }
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    const isRerun = state.status === 'ready'
    setState({ status: 'running' })

    try {
      const blob = await (await fetch(source.url, { signal: abortController.signal })).blob()
      const result = await requestExtraction(
        blob,
        template,
        providerSettings,
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
