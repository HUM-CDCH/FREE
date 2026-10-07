import { useCallback, useEffect, useRef, useState } from 'react'
import { activeMethod, type ExtractionMethodIntent } from 'extraction/extraction-method'
import type { ExtractionStrategy } from '../shared/extraction.contract'
import type { ModelConfig } from '../shared/modelConfig.contract'
import { apiErrorText, getModelConfig, onModelConfigSaved } from './providerConfig/providerConfig.data'

/** What a start view needs to know of the account and the deployment: the saved document, and whether new Catalog
 *  Extractions use the unified method. */
export type SavedMethodSource = Readonly<{ config: ModelConfig; unifiedCatalog?: boolean }>

/** The saved method a start view shows and submits: the same function admission compares it with. */
export function savedMethodFor(saved: SavedMethodSource, strategy: ExtractionStrategy, catalogRecipe: string | null): ExtractionMethodIntent {
  const { config, unifiedCatalog } = saved
  return activeMethod(config.extractionModels, config.extractionSettings, strategy, catalogRecipe, unifiedCatalog === true)
}

export type SavedMethodState =
  | { status: 'loading' }
  | ({ status: 'ready' } & SavedMethodSource)
  | { status: 'error'; message: string }

/** The signed-in account's saved configuration for a start view, read on mount and on `refresh()`. Keys are never
 *  part of it. */
export function useSavedMethod(): { state: SavedMethodState; refresh: () => Promise<SavedMethodSource | null> } {
  const [state, setState] = useState<SavedMethodState>({ status: 'loading' })
  const current = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    current.current?.abort()
    const controller = new AbortController()
    current.current = controller
    setState({ status: 'loading' })
    try {
      const { config, deployment } = await getModelConfig(controller.signal)
      if (controller.signal.aborted) return null
      const ready = { config, ...(deployment.unifiedCatalog ? { unifiedCatalog: true } : {}) }
      setState({ status: 'ready', ...ready })
      return ready
    } catch (cause) {
      if (!controller.signal.aborted) setState({ status: 'error', message: apiErrorText(cause) })
      return null
    }
  }, [])
  // An Apply in this page is the saved document: it replaces any read still in flight.
  useEffect(() => onModelConfigSaved((config) => {
    current.current?.abort()
    setState((previous) => ({ status: 'ready', config, ...(previous.status === 'ready' && previous.unifiedCatalog ? { unifiedCatalog: true } : {}) }))
  }), [])
  useEffect(() => {
    let mounted = true
    // Deferred so the effect body itself schedules no state update; an unmount before then reads nothing.
    void Promise.resolve().then(() => (mounted ? refresh() : null))
    return () => {
      mounted = false
      current.current?.abort()
    }
  }, [refresh])
  return { state, refresh }
}
