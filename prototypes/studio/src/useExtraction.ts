import { useEffect, useRef, useState } from 'react'
import { requestExtraction } from './api'
import type { ExtractionStrategy } from './api'
import type { ExtractionState } from './extraction'
import { isRecord } from './template'

type PdfSource = { url: string; filename: string }

// Article strategy always wraps the researcher's schema as `{ records: [template] }`
// on the way in (see _catalog_sections.ts's findPrimaryArrayKey / _model.ts's
// extractWithModel) purely as request plumbing to carry `_strategy` alongside a
// `SchemaNode[]`-derived template that has no root-metadata slot — the array is
// guaranteed to hold exactly one item for Article, never a real repeated group.
// Catalog's `records` is a genuine multi-item array (one per detected section) and
// must stay wrapped. Falls back to the original values unchanged when the response
// isn't shaped as expected, rather than throwing.
export function unwrapArticleResult(
  strategy: ExtractionStrategy,
  result: unknown,
  evidence: unknown,
): { result: unknown; evidence: unknown } {
  if (strategy === 'catalog' || !isRecord(result) || !Array.isArray(result.records) || result.records.length === 0) {
    return { result, evidence }
  }
  const unwrappedEvidence =
    isRecord(evidence) && Array.isArray(evidence.records) && evidence.records.length > 0
      ? evidence.records[0]
      : null
  return { result: result.records[0], evidence: unwrappedEvidence }
}

type UseExtractionOptions = {
  pdfSource: PdfSource | null
  template: unknown
  schemaReady: boolean
  markdown: string | null
  hasTables: boolean
  indexing: boolean
  extractionStrategy: ExtractionStrategy
  onComplete: (isRerun: boolean) => void
  onError: (message: string) => void
}

export type ExtractionController = ReturnType<typeof useExtraction>

export function useExtraction({
  pdfSource,
  template,
  schemaReady,
  markdown,
  hasTables,
  indexing,
  extractionStrategy,
  onComplete,
  onError,
}: UseExtractionOptions) {
  const [state, setState] = useState<ExtractionState>({ status: 'idle' })
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
      const { result, evidence } = await requestExtraction(
        blob,
        pdfSource.filename,
        // `_strategy` sits alongside `records`, not inside it — it's routing
        // metadata for extractWithModel's Catalog/Article gate, not part of
        // the researcher's own schema fields (see _catalog_sections.ts).
        { records: [template], _strategy: extractionStrategy },
        abortController.signal,
        markdown,
        undefined,
        hasTables,
      )
      if (abortController.signal.aborted) {
        return
      }
      const unwrapped = unwrapArticleResult(extractionStrategy, result, evidence)
      setState({ status: 'ready', result: unwrapped.result, evidence: unwrapped.evidence })
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
