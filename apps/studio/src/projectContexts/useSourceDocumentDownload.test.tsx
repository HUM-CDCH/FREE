// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDocumentReopenSnapshot } from './transport'
import { useSourceDocumentDownload } from './useSourceDocumentDownload'

vi.mock('./transport', () => ({
  getDocumentReopenSnapshot: vi.fn(),
}))

const projectContextId = '10000000-0000-4000-8000-000000000001'
const sourceDocumentId = '20000000-0000-4000-8000-000000000001'
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  'createObjectURL',
)
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
  URL,
  'revokeObjectURL',
)

function restoreUrlMethod(
  name: 'createObjectURL' | 'revokeObjectURL',
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(URL, name, descriptor)
  else Reflect.deleteProperty(URL, name)
}

beforeEach(() => {
  vi.mocked(getDocumentReopenSnapshot).mockReset()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:source-document'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  restoreUrlMethod('createObjectURL', originalCreateObjectUrl)
  restoreUrlMethod('revokeObjectURL', originalRevokeObjectUrl)
})

describe('useSourceDocumentDownload', () => {
  it('downloads the pinned Source Document through the browser', async () => {
    vi.mocked(getDocumentReopenSnapshot).mockResolvedValue({
      sourceRepresentation: {
        resources: { sourcePdfUrl: '/source.pdf' },
      },
    } as Awaited<ReturnType<typeof getDocumentReopenSnapshot>>)
    const fetcher = vi.fn(async () => new Response(new Blob(['pdf'])))
    vi.stubGlobal('fetch', fetcher)
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    const { result } = renderHook(() =>
      useSourceDocumentDownload(projectContextId),
    )

    await act(() =>
      result.current.downloadSource(sourceDocumentId, 'Beretning.pdf'),
    )

    expect(getDocumentReopenSnapshot).toHaveBeenCalledWith(
      projectContextId,
      sourceDocumentId,
      expect.any(AbortSignal),
    )
    expect(fetcher).toHaveBeenCalledWith('/source.pdf', {
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    })
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:source-document')
    expect(result.current.downloadFailure).toBeNull()
  })

  it('reports the current download failure', async () => {
    vi.mocked(getDocumentReopenSnapshot).mockRejectedValue(
      new Error('Source storage is unavailable.'),
    )
    const { result } = renderHook(() =>
      useSourceDocumentDownload(projectContextId),
    )

    await act(() =>
      result.current.downloadSource(sourceDocumentId, 'Beretning.pdf'),
    )

    expect(result.current.downloadFailure).toBe(
      'Could not download “Beretning.pdf”.',
    )
  })

  it('aborts and discards a failure after changing Project Contexts', async () => {
    const pending = Promise.withResolvers<
      Awaited<ReturnType<typeof getDocumentReopenSnapshot>>
    >()
    vi.mocked(getDocumentReopenSnapshot).mockReturnValue(pending.promise)
    const { result, rerender } = renderHook(
      ({ currentProjectContextId }) =>
        useSourceDocumentDownload(currentProjectContextId),
      { initialProps: { currentProjectContextId: projectContextId } },
    )

    let download!: Promise<void>
    act(() => {
      download = result.current.downloadSource(
        sourceDocumentId,
        'Beretning.pdf',
      )
    })
    const signal = vi.mocked(getDocumentReopenSnapshot).mock.calls[0]?.[2]

    rerender({
      currentProjectContextId: '10000000-0000-4000-8000-000000000002',
    })
    expect(signal?.aborted).toBe(true)

    await act(async () => {
      pending.reject(new Error('Late failure.'))
      await download
    })
    expect(result.current.downloadFailure).toBeNull()
  })
})
