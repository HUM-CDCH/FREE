import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import { navigationMachine } from './projectNavigation'

const id = '00000000-0000-4000-8000-000000000044'

describe('project navigation machine', () => {
  it('loads a direct route, pushes clicks, and aborts abandoned reads', async () => {
    const push = vi.fn()
    let aborted = false
    const actor = createActor(navigationMachine, {
      input: {
        initialProjectContextId: id,
        deps: {
          list: async () => [
            {
              projectContextId: id,
              name: 'Project',
              createdAt: '2026-07-31T00:00:00.000Z',
            },
          ],
          chooser: (_id, signal) =>
            new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => {
                aborted = true
                reject(new DOMException('Aborted', 'AbortError'))
              })
              setTimeout(
                () =>
                  resolve({
                    projectContext: {
                      projectContextId: id,
                      name: 'Project',
                      createdAt: '2026-07-31T00:00:00.000Z',
                    },
                    sourceDocuments: [],
                  }),
                0,
              )
            }),
          push,
        },
      },
    })
    actor.start()
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches('choosingDocument')).toBe(true),
    )
    actor.send({ type: 'GO_PROJECT_LIST' })
    expect(aborted).toBe(false)
    actor.send({ type: 'OPEN_PROJECT', projectContextId: id })
    expect(push).toHaveBeenCalledWith(id)
    actor.send({ type: 'URL_CHANGED', projectContextId: null })
    expect(aborted).toBe(true)
    actor.stop()
  })

  it('retries a failed list read', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce({
        code: 'persistence_unavailable',
        message: 'Project Context storage is unavailable.',
      })
      .mockResolvedValueOnce([])
    const actor = createActor(navigationMachine, {
      input: {
        initialProjectContextId: null,
        deps: { list, chooser: vi.fn(), push: vi.fn() },
      },
    })
    actor.start()
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches('listError')).toBe(true),
    )
    actor.send({ type: 'RETRY' })
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches('projectList')).toBe(true),
    )
    expect(list).toHaveBeenCalledTimes(2)
    actor.stop()
  })

  it('ignores a late chooser result after returning to the list', async () => {
    const late = Promise.withResolvers<{
      projectContext: {
        projectContextId: string
        name: string
        createdAt: string
      }
      sourceDocuments: []
    }>()
    let chooserSignal: AbortSignal | undefined
    const actor = createActor(navigationMachine, {
      input: {
        initialProjectContextId: id,
        deps: {
          list: async () => [],
          chooser: async (_id, signal) => {
            chooserSignal = signal
            return late.promise
          },
          push: vi.fn(),
        },
      },
    })
    actor.start()
    await vi.waitFor(() => expect(chooserSignal).toBeDefined())
    actor.send({ type: 'URL_CHANGED', projectContextId: null })
    expect(chooserSignal?.aborted).toBe(true)
    late.resolve({
      projectContext: {
        projectContextId: id,
        name: 'Late project',
        createdAt: '2026-07-31T00:00:00.000Z',
      },
      sourceDocuments: [],
    })
    await vi.waitFor(() =>
      expect(actor.getSnapshot().matches('projectList')).toBe(true),
    )
    expect(actor.getSnapshot().context.chooser).toBeNull()
    actor.stop()
  })
})
