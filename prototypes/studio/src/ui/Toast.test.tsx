// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Toast from './Toast'
import { useToast } from '../useToast'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('announces the message, then dismisses and runs its one action', () => {
  const onAction = vi.fn(), onDismiss = vi.fn()
  render(<Toast message="Field removed" action={{ label: 'Undo', onAction }} onDismiss={onDismiss} />)
  expect(screen.getByRole('status')).toHaveTextContent('Field removed')
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(onAction).toHaveBeenCalledOnce()
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(onDismiss.mock.invocationCallOrder[0]).toBeLessThan(onAction.mock.invocationCallOrder[0])
})

it('the host shows one toast at a time and clears it after its duration', () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useToast())
  act(() => result.current.showToast('Saved', { durationMs: 1000 }))
  act(() => result.current.showToast('Field removed', { durationMs: 8000, action: { label: 'Undo', onAction: () => {} } }))
  expect(result.current.toast?.message).toBe('Field removed')
  act(() => vi.advanceTimersByTime(1001))
  expect(result.current.toast?.message).toBe('Field removed')
  act(() => vi.advanceTimersByTime(7000))
  expect(result.current.toast).toBeNull()
})

it('a switch-surviving toast keeps its message through one switch, then dismisses like any other', () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useToast())
  act(() => result.current.showToast('This document has been reprocessed', { outlivesSwitch: true, durationMs: 6000 }))
  act(() => result.current.consumeSwitch())
  expect(result.current.toast?.message).toBe('This document has been reprocessed')
  expect(result.current.toast?.outlivesSwitch).toBe(false)
  act(() => result.current.dismissToast())
  expect(result.current.toast).toBeNull()
})

/** A host as App and the schema panel wire it: the toast holds its timer while it is hovered or has focus within. */
function Host() {
  const { toast, showToast, dismissToast, holdToast } = useToast()
  return (
    <>
      <button type="button" onClick={() => showToast('✓ Extraction complete', { durationMs: 8000, action: { label: 'Review now', onAction: () => {} } })}>show</button>
      {toast && <Toast message={toast.message} action={toast.action} onDismiss={dismissToast} onHoldChange={holdToast} />}
    </>
  )
}

it('holds its timer while hovered, and goes once the pointer leaves and the rest of its time runs out', () => {
  vi.useFakeTimers()
  render(<Host />)
  fireEvent.click(screen.getByRole('button', { name: 'show' }))
  act(() => vi.advanceTimersByTime(7000))
  fireEvent.mouseEnter(screen.getByRole('status'))
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.getByRole('button', { name: 'Review now' })).toBeInTheDocument()
  fireEvent.mouseLeave(screen.getByRole('status'))
  act(() => vi.advanceTimersByTime(900))
  expect(screen.getByRole('status')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(200))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('holds its timer while a keyboard user is on its action, and goes after the focus leaves', () => {
  vi.useFakeTimers()
  render(<Host />)
  fireEvent.click(screen.getByRole('button', { name: 'show' }))
  act(() => vi.advanceTimersByTime(7000))
  act(() => screen.getByRole('button', { name: 'Review now' }).focus())
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.getByRole('button', { name: 'Review now' })).toBeInTheDocument()
  // Hovered and focused: leaving with the pointer alone keeps it held.
  fireEvent.mouseEnter(screen.getByRole('status'))
  fireEvent.mouseLeave(screen.getByRole('status'))
  act(() => vi.advanceTimersByTime(5000))
  expect(screen.getByRole('status')).toBeInTheDocument()
  act(() => screen.getByRole('button', { name: 'show' }).focus())
  act(() => vi.advanceTimersByTime(1100))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
