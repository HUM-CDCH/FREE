import { useEffect, useRef, useState } from 'react'
import { getDocumentReopenSnapshot } from './transport'

type DownloadFailure = {
  projectContextId: string
  message: string
}

/**
 * Owns the complete browser download lifecycle for one Project Context.
 * Starting another download or leaving the Project Context invalidates every
 * completion still in flight, so callers only render the current failure.
 */
export function useSourceDocumentDownload(projectContextId: string) {
  const [settledFailure, setSettledFailure] =
    useState<DownloadFailure | null>(null)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)

  const downloadSource = async (sourceDocumentId: string, name: string) => {
    controller.current?.abort()
    const requestController = new AbortController()
    controller.current = requestController
    const requestGeneration = ++generation.current
    setSettledFailure(null)

    try {
      const snapshot = await getDocumentReopenSnapshot(
        projectContextId,
        sourceDocumentId,
        requestController.signal,
      )
      const response = await fetch(
        snapshot.sourceRepresentation.resources.sourcePdfUrl,
        { signal: requestController.signal },
      )
      if (!response.ok) throw new Error('Could not download the source PDF.')
      const blob = await response.blob()
      if (
        requestController.signal.aborted ||
        requestGeneration !== generation.current
      )
        return

      const href = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = href
      link.download = name
      link.click()
      URL.revokeObjectURL(href)
    } catch {
      if (
        !requestController.signal.aborted &&
        requestGeneration === generation.current
      )
        setSettledFailure({
          projectContextId,
          message: `Could not download “${name}”.`,
        })
    }
  }

  useEffect(() => {
    generation.current += 1
    controller.current?.abort()
    controller.current = null
    return () => {
      generation.current += 1
      controller.current?.abort()
    }
  }, [projectContextId])

  return {
    downloadSource,
    downloadFailure:
      settledFailure?.projectContextId === projectContextId
        ? settledFailure.message
        : null,
  }
}
