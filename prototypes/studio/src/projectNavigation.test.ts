import { createActor } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import {
  href,
  navigationMachine,
  parseRoute,
  type NavigableRoute,
} from './projectNavigation'

const projectContextId = '00000000-0000-4000-8000-000000000044'
const sourceDocumentId = '00000000-0000-4000-8000-000000000045'

describe('Project Context routes', () => {
  it.each([
    ['/', { kind: 'root' }],
    ['/studio', { kind: 'root' }],
    ['/anything', { kind: 'root' }],
    ['/projects', { kind: 'root' }],
    [`/projects/${projectContextId}/`, { kind: 'project', projectContextId }],
    [`/projects/${projectContextId}/documents`, { kind: 'project', projectContextId }],
    [
      `/projects/${projectContextId}/documents/${sourceDocumentId}`,
      { kind: 'document', projectContextId, sourceDocumentId },
    ],
    ['/projects/NOT-A-UUID', { kind: 'badReference' }],
    [`/projects/${projectContextId}/documents/nope`, { kind: 'badReference' }],
    [
      `/projects/${projectContextId}/documents/${sourceDocumentId}/anything`,
      { kind: 'badReference' },
    ],
  ])('parses %s', (pathname, route) => {
    expect(parseRoute(pathname)).toEqual(route)
  })

  it.each<NavigableRoute>([
    { kind: 'root' },
    { kind: 'project', projectContextId },
    { kind: 'document', projectContextId, sourceDocumentId },
  ])('builds the canonical href for $kind routes', (route) => {
    expect(parseRoute(href(route))).toEqual(route)
  })
})

describe('project navigation machine', () => {
  it('pushes navigation and accepts back/forward route changes without pushing', () => {
    const push = vi.fn()
    const actor = createActor(navigationMachine, {
      input: { deps: { push }, initialRoute: { kind: 'root' } },
    })
    actor.start()

    const projectRoute = { kind: 'project', projectContextId } as const
    actor.send({ type: 'NAVIGATE', route: projectRoute })
    expect(push).toHaveBeenCalledWith(projectRoute)
    expect(actor.getSnapshot().context.route).toEqual(projectRoute)

    actor.send({ type: 'ROUTE_CHANGED', route: { kind: 'root' } })
    expect(push).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().context).toEqual({
      deps: { push },
      route: { kind: 'root' },
    })
    actor.stop()
  })
})
