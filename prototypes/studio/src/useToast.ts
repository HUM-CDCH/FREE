import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastAction } from './ui/Toast'

export type ToastOptions = {
  durationMs?: number
  action?: ToastAction
  /** The toast explains the switch of Source Representation that is about to happen, so that switch keeps it. */
  outlivesSwitch?: boolean
}

/** `id` is new for every shown toast: hosts key the rendered Toast by it, so a replacement mounts fresh (its hover and
 *  focus hold start clear). */
export type ToastState = { id: number; message: string; action?: ToastAction; outlivesSwitch: boolean }

/** One toast at a time; a new message replaces the current one and restarts the timer. While the toast is held (hovered,
 *  or focus within it: `holdToast`, wired to the Toast's `onHoldChange`) its timer stops; released, the rest runs on. */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<number | undefined>(undefined)
  /** When the shown toast goes, and, while it is held, the time it has left. */
  const deadline = useRef(0)
  const heldRemaining = useRef<number | null>(null)
  const nextId = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const dismissToast = useCallback(() => {
    window.clearTimeout(timer.current)
    heldRemaining.current = null
    setToast(null)
  }, [])
  const showToast = useCallback((message: string, { durationMs = 2600, action, outlivesSwitch = false }: ToastOptions = {}) => {
    window.clearTimeout(timer.current)
    heldRemaining.current = null
    nextId.current += 1
    setToast({ id: nextId.current, message, ...(action ? { action } : {}), outlivesSwitch })
    deadline.current = Date.now() + durationMs
    timer.current = window.setTimeout(() => setToast(null), durationMs)
  }, [])
  const holdToast = useCallback((held: boolean) => {
    if (held) {
      if (heldRemaining.current !== null) return
      window.clearTimeout(timer.current)
      heldRemaining.current = Math.max(0, deadline.current - Date.now())
      return
    }
    if (heldRemaining.current === null) return
    const remaining = heldRemaining.current
    heldRemaining.current = null
    deadline.current = Date.now() + remaining
    timer.current = window.setTimeout(() => setToast(null), remaining)
  }, [])
  /** The switch the toast was kept for has happened; the next one clears it. Message and timer stay. */
  const consumeSwitch = useCallback(() => {
    setToast((current) => (current?.outlivesSwitch ? { ...current, outlivesSwitch: false } : current))
  }, [])
  return { toast, showToast, dismissToast, holdToast, consumeSwitch }
}
