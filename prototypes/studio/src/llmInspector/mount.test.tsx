// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountLlmInspector } from './mount'

let unmount: (() => void) | undefined

afterEach(() => {
  act(() => unmount?.())
  unmount = undefined
  vi.unstubAllGlobals()
})

describe('LLM inspector launcher', () => {
  it('opens independently, renders traces, and clears them', async () => {
    const trace = {
      id: 'trace-1',
      operation: 'chat',
      provider: 'test-provider',
      model: 'test-model',
      profile: 'general',
      startedAt: '2026-08-01T12:00:00.000Z',
      completedAt: '2026-08-01T12:00:00.010Z',
      status: 'complete',
      request: 'Complete source text',
      response: 'Complete model text',
    }
    let traces = [trace]
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        traces = []
        return new Response(null, { status: 204 })
      }
      return Response.json({ traces })
    })
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    vi.stubGlobal('fetch', request)
    act(() => { unmount = mountLlmInspector() })

    fireEvent.click(await screen.findByRole('button', { name: 'Inspect LLM messages' }))
    expect(await screen.findByRole('dialog', { name: 'LLM message inspector' })).toBeInTheDocument()
    expect(screen.getByText(/Provider exchanges only/)).toBeVisible()
    expect(await screen.findByText('Complete source text')).toBeInTheDocument()
    expect(screen.getByText('Complete model text')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0])
    expect(writeText).toHaveBeenCalledWith('Complete source text')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/api/llm_inspector',
        expect.objectContaining({
          method: 'DELETE',
          credentials: 'same-origin',
        }),
      ),
    )
    expect(
      request.mock.calls.every(
        ([, init]) => init?.credentials === 'same-origin',
      ),
    ).toBe(true)
    expect(await screen.findByText(/No provider calls yet/)).toBeVisible()
    expect(screen.getByText('Select a call to inspect its complete payload.')).toBeVisible()

    const dialog = screen.getByRole('dialog', { name: 'LLM message inspector' })
    fireEvent.click(dialog)
    expect(dialog).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect LLM messages' }))
    const reopened = await screen.findByRole('dialog', {
      name: 'LLM message inspector',
    })
    fireEvent(reopened, new Event('cancel', { cancelable: true }))
    expect(reopened).not.toBeInTheDocument()
  })
})
