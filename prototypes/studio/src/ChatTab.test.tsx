// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { sendMessages, transportInit } = vi.hoisted(() => ({
  sendMessages: vi.fn(),
  transportInit: {
    current: null as null | {
      api: string
      fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    },
  },
}))

vi.mock('ai', () => ({
  DefaultChatTransport: class {
    constructor(init: NonNullable<typeof transportInit.current>) {
      transportInit.current = init
    }

    sendMessages = sendMessages
  },
  readUIMessageStream: () => ({
    async *[Symbol.asyncIterator]() {
      // The transport request, not stream rendering, is this test's contract.
    },
  }),
}))

import ChatTab from './ChatTab.tsx'

afterEach(() => {
  cleanup()
  sendMessages.mockReset()
  vi.unstubAllGlobals()
})

describe('ChatTab transport', () => {
  it('sends chat through the shared authenticated fetch', async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', request)
    sendMessages.mockImplementation(async () => {
      const init = transportInit.current
      if (!init) throw new Error('Chat transport was not initialized.')
      await init.fetch(init.api, { method: 'POST' })
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
    })
    render(
      <ChatTab
        projectContextId="11111111-1111-4111-8111-111111111111"
        sourceRepresentationRevisionId="22222222-2222-4222-8222-222222222222"
      />,
    )

    fireEvent.change(
      screen.getByPlaceholderText('Ask about this source document...'),
      { target: { value: 'What places appear?' } },
    )
    fireEvent.click(screen.getByTitle('Send'))

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
      }),
    )
  })
})
