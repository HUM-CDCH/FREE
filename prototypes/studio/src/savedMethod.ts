import { useCallback, useEffect, useRef, useState } from 'react'
import { activeMethod, type ExtractionMethodIntent } from 'extraction/extraction-method'
import type { ExtractionStrategy } from '../shared/extraction.contract'
import type { ModelConfig } from '../shared/modelConfig.contract'
import { apiErrorText, getModelConfig, onModelConfigSaved } from './providerConfig/providerConfig.data'

/** The saved method a start view shows and submits: the same function admission compares it with. */
export function savedMethodFor(config: ModelConfig, strategy: ExtractionStrategy, catalogRecipe: string | null): ExtractionMethodIntent {
  return activeMethod(config.extractionModels, config.extractionSettings, strategy, catalogRecipe)
}

export type SavedMethodState =
  | { status: 'loading' }
  | { status: 'ready'; config: ModelConfig }
  | { status: 'error'; message: string }

/** The signed-in account's saved configuration for a start view, read on mount and on `refresh()`. Keys are never
 *  part of it. */
export function useSavedMethod(): { state: SavedMethodState; refresh: () => Promise<ModelConfig | null> } {
  const [state, setState] = useState<SavedMethodState>({ status: 'loading' })
  const current = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    current.current?.abort()
    const controller = new AbortController()
    current.current = controller
    setState({ status: 'loading' })
    try {
      const { config } = await getModelConfig(controller.signal)
      if (controller.signal.aborted) return null
      setState({ status: 'ready', config })
      return config
    } catch (cause) {
      if (!controller.signal.aborted) setState({ status: 'error', message: apiErrorText(cause) })
      return null
    }
  }, [])
  // An Apply in this page is the saved document: it replaces any read still in flight.
  useEffect(() => onModelConfigSaved((config) => {
    current.current?.abort()
    setState({ status: 'ready', config })
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
