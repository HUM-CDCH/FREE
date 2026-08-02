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
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ traces: [trace] }))
    vi.stubGlobal('fetch', request)
    act(() => { unmount = mountLlmInspector() })

    fireEvent.click(await screen.findByRole('button', { name: 'Inspect LLM messages' }))
    expect(await screen.findByRole('dialog', { name: 'LLM message inspector' })).toBeInTheDocument()
    expect(await screen.findByText('Complete source text')).toBeInTheDocument()
    expect(screen.getByText('Complete model text')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/llm_inspector', { method: 'DELETE' }))
  })
})
