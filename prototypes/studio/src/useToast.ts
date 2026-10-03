import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastAction } from './ui/Toast'

export type ToastOptions = {
  durationMs?: number
  action?: ToastAction
  /** The toast explains the switch of Source Representation that is about to happen, so that switch keeps it. */
  outlivesSwitch?: boolean
}

export type ToastState = { message: string; action?: ToastAction; outlivesSwitch: boolean }

/** One toast at a time; a new message replaces the current one and restarts the timer. */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const dismissToast = useCallback(() => {
    window.clearTimeout(timer.current)
    setToast(null)
  }, [])
  const showToast = useCallback((message: string, { durationMs = 2600, action, outlivesSwitch = false }: ToastOptions = {}) => {
    window.clearTimeout(timer.current)
    setToast({ message, ...(action ? { action } : {}), outlivesSwitch })
    timer.current = window.setTimeout(() => setToast(null), durationMs)
  }, [])
  return { toast, showToast, dismissToast }
}
