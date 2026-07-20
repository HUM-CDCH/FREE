// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useExtraction } from './useExtraction'
import type { ExtractionSchemaEnvelope } from './api'

const { requestExtractionMock } = vi.hoisted(() => ({ requestExtractionMock: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), requestExtraction: requestExtractionMock }))

describe('useExtraction request lifetime', () => {
  it('does not abort an in-flight request when running state rerenders the hook', async () => {
    let finish!: (value: { result: Record<string, unknown>; warnings: string[] }) => void
    requestExtractionMock.mockImplementation((_taskId, _schema, _strategy, signal: AbortSignal) => new Promise(resolve => {
      expect(signal.aborted).toBe(false)
      finish = resolve
    }))
    const schema: ExtractionSchemaEnvelope = { record: { title: 'string' }, _schema_metadata: {} }
    const { result } = renderHook(() => useExtraction({ taskId: 'task-1', schema, schemaReady: true, indexing: false, strategy: 'article', onStrategyChange: vi.fn(), onComplete: vi.fn(), onError: vi.fn() }))
    act(() => { void result.current.runExtraction() })
    await waitFor(() => expect(result.current.state.status).toBe('running'))
    const signal = requestExtractionMock.mock.calls[0]?.[3] as AbortSignal
    expect(signal.aborted).toBe(false)
    await act(async () => finish({ result: { title: 'done' }, warnings: [] }))
    expect(result.current.state.status).toBe('ready')
  })
})
