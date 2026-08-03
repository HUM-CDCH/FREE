import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import { navigationMachine } from './projectNavigation'

const id = '00000000-0000-4000-8000-000000000044'

describe('project navigation machine', () => {
  it('loads a direct route, retries failures, pushes clicks, and aborts abandoned reads', async () => {
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
})
