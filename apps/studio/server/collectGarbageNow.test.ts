import { DBOSClient } from '@dbos-inc/dbos-sdk'
import { describe, expect, it, vi } from 'vitest'
import { collectGarbageNow } from './collectGarbageNow.js'

describe('gc:now', () => {
  it('triggers Studio\'s schedule and returns its summary, then closes its client', async () => {
    const summary = { cancelledStudio: [], failedPhases: [] }
    const getResult = vi.fn(async () => summary)
    const client = {
      triggerSchedule: vi.fn(async () => ({ workflowID: 'sched-collectGarbage-trigger-1', getResult })),
      destroy: vi.fn(async () => undefined),
    }
    const create = vi.fn(async () => client) as unknown as typeof DBOSClient.create

    await expect(collectGarbageNow('postgresql://example', create)).resolves.toEqual({
      workflowId: 'sched-collectGarbage-trigger-1', summary,
    })
    expect(create).toHaveBeenCalledWith({
      systemDatabaseUrl: 'postgresql://example', systemDatabaseSchemaName: 'dbos',
      systemDatabasePoolSize: 1, applicationName: 'studio',
    })
    expect(client.triggerSchedule).toHaveBeenCalledWith('collectGarbage')
    expect(getResult).toHaveBeenCalledOnce()
    expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('closes the client when the sweep fails', async () => {
    const error = new Error('database rejected the sweep')
    const client = {
      triggerSchedule: vi.fn(async () => { throw error }),
      destroy: vi.fn(async () => undefined),
    }
    const create = vi.fn(async () => client) as unknown as typeof DBOSClient.create
    await expect(collectGarbageNow('postgresql://example', create)).rejects.toBe(error)
    expect(client.destroy).toHaveBeenCalledOnce()
  })
})
