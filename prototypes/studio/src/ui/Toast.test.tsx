// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Toast from './Toast'
import { useToast } from '../useToast'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('announces the message and runs its one action, then dismisses', () => {
  const onAction = vi.fn(), onDismiss = vi.fn()
  render(<Toast message="Field removed" action={{ label: 'Undo', onAction }} onDismiss={onDismiss} />)
  expect(screen.getByRole('status')).toHaveTextContent('Field removed')
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(onAction).toHaveBeenCalledOnce()
  expect(onDismiss).toHaveBeenCalledOnce()
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
  const { result } = renderHook(() => useToast())
  act(() => result.current.showToast('This document has been reprocessed', { outlivesSwitch: true, durationMs: 6000 }))
  act(() => result.current.consumeSwitch())
  expect(result.current.toast?.message).toBe('This document has been reprocessed')
  expect(result.current.toast?.outlivesSwitch).toBe(false)
  act(() => result.current.dismissToast())
  expect(result.current.toast).toBeNull()
})
