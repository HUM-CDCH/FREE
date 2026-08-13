import { createActor, fromPromise } from 'xstate'
import { describe, expect, it, vi } from 'vitest'
import {
  href,
  navigationMachine,
  parseRoute,
  type NavigableRoute,
  type Route,
} from './projectNavigation'
import type { DocumentSnapshot } from './projectContexts/transport'

const projectContextId = '00000000-0000-4000-8000-000000000044'
const sourceDocumentId = '00000000-0000-4000-8000-000000000045'
const otherSourceDocumentId = '00000000-0000-4000-8000-000000000046'

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

const documentRoute = { kind: 'document', projectContextId, sourceDocumentId } as const
const otherDocumentRoute = {
  kind: 'document',
  projectContextId,
  sourceDocumentId: otherSourceDocumentId,
} as const

const snapshotOf = (documentId: string) =>
  ({
    projectContext: {
      projectContextId,
      name: 'Ellekilde, TAK 1355',
      createdAt: '2026-07-31T12:00:00.000Z',
    },
    sourceDocument: {
      sourceDocumentId: documentId,
      name: `${documentId}.pdf`,
      createdAt: '2026-07-31T12:01:00.000Z',
    },
    sourceRepresentation: {
      sourceRepresentationId: '00000000-0000-4000-8000-0000000000a1',
      revisionNumber: 1,
      resources: {
        sourcePdfUrl: `/api/source-representations/${documentId}/pdf`,
        markdownUrl: `/api/source-representations/${documentId}/markdown`,
        parsedDocumentUrl: `/api/source-representations/${documentId}/source`,
      },
    },
    annotationSet: null,
    extractionSchema: null,
    latestAttempt: null,
    latestReviewed: null,
  }) satisfies DocumentSnapshot

/** A reopen actor whose reads are resolved by the test, one per Source Document. */
function reopenController(initialRoute: Route = { kind: 'root' }) {
  const pending = new Map<
    string,
    { resolve(snapshot: DocumentSnapshot): void; reject(error: unknown): void; signal: AbortSignal }
  >()
  const push = vi.fn()
  const actor = createActor(
    navigationMachine.provide({
      actors: {
        reopenDocument: fromPromise<
          DocumentSnapshot,
          { projectContextId: string; sourceDocumentId: string }
        >(
          ({ input, signal }) =>
            new Promise((resolve, reject) => {
              pending.set(input.sourceDocumentId, { resolve, reject, signal })
            }),
        ),
      },
    }),
    { input: { deps: { push }, initialRoute } },
  )
  actor.start()
  // Every read is gated on the rail branch proving containment; these tests are
  // about what happens once it has.
  if (initialRoute.kind === 'document') actor.send({ type: 'DOCUMENT_CONTAINED' })
  return { actor, pending, push }
}

function navigateToContained(
  actor: ReturnType<typeof reopenController>['actor'],
  route: NavigableRoute,
) {
  actor.send({ type: 'NAVIGATE', route })
  actor.send({ type: 'DOCUMENT_CONTAINED' })
}

describe('routed Source Document opening', () => {
  it.each<Route>([
    { kind: 'root' },
    { kind: 'project', projectContextId },
    { kind: 'badReference' },
  ])('stays idle without a read for $kind routes', ({ ...route }) => {
    const { actor, pending } = reopenController(route as Route)

    expect(actor.getSnapshot().value).toBe('idle')
    expect(pending.size).toBe(0)
    actor.stop()
  })

  it('reads nothing until the rail branch proves the Project Context contains it', () => {
    const { actor, pending } = reopenController()

    actor.send({ type: 'NAVIGATE', route: documentRoute })

    expect(actor.getSnapshot().value).toBe('routing')
    expect(pending.size).toBe(0)

    actor.send({ type: 'DOCUMENT_CONTAINED' })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(pending.size).toBe(1)
    actor.stop()
  })

  it('never reads back a Source Document the routed Project Context lacks', async () => {
    const { actor, pending } = reopenController(documentRoute)
    pending.get(sourceDocumentId)!.resolve(snapshotOf(sourceDocumentId))
    await Promise.resolve()

    actor.send({ type: 'NAVIGATE', route: otherDocumentRoute })
    actor.send({ type: 'DOCUMENT_NOT_CONTAINED' })

    expect(actor.getSnapshot().value).toBe('idle')
    expect(actor.getSnapshot().context.snapshot).toBeNull()
    expect(pending.has(otherSourceDocumentId)).toBe(false)
    actor.stop()
  })

  it('opens the routed Source Document from its durable snapshot', async () => {
    const { actor, pending } = reopenController(documentRoute)

    expect(actor.getSnapshot().value).toBe('opening')
    pending.get(sourceDocumentId)!.resolve(snapshotOf(sourceDocumentId))
    await Promise.resolve()

    const snapshot = actor.getSnapshot()
    expect(snapshot.value).toBe('open')
    expect(snapshot.context.snapshot?.sourceDocument.sourceDocumentId).toBe(
      sourceDocumentId,
    )
    expect(snapshot.context.failure).toBeNull()
    actor.stop()
  })

  it('cancels a superseded read and never lets its late result replace the active route', async () => {
    const { actor, pending } = reopenController(documentRoute)

    navigateToContained(actor, otherDocumentRoute)

    expect(actor.getSnapshot().value).toBe('opening')
    expect(pending.get(sourceDocumentId)!.signal.aborted).toBe(true)

    pending.get(sourceDocumentId)!.resolve(snapshotOf(sourceDocumentId))
    pending.get(otherSourceDocumentId)!.resolve(snapshotOf(otherSourceDocumentId))
    await Promise.resolve()
    await Promise.resolve()

    expect(actor.getSnapshot().value).toBe('open')
    expect(
      actor.getSnapshot().context.snapshot?.sourceDocument.sourceDocumentId,
    ).toBe(otherSourceDocumentId)
    actor.stop()
  })

  it('keeps the open Source Document while the next one opens', async () => {
    const { actor, pending } = reopenController(documentRoute)
    pending.get(sourceDocumentId)!.resolve(snapshotOf(sourceDocumentId))
    await Promise.resolve()

    actor.send({ type: 'NAVIGATE', route: otherDocumentRoute })

    expect(actor.getSnapshot().value).toBe('routing')
    expect(
      actor.getSnapshot().context.snapshot?.sourceDocument.sourceDocumentId,
    ).toBe(sourceDocumentId)
    expect(pending.has(otherSourceDocumentId)).toBe(false)

    actor.send({ type: 'DOCUMENT_CONTAINED' })

    expect(actor.getSnapshot().value).toBe('opening')
    expect(
      actor.getSnapshot().context.snapshot?.sourceDocument.sourceDocumentId,
    ).toBe(sourceDocumentId)
    actor.stop()
  })

  it('leaves the routed Source Document behind when the route walks back to its Project Context', async () => {
    const { actor, pending } = reopenController(documentRoute)
    pending.get(sourceDocumentId)!.resolve(snapshotOf(sourceDocumentId))
    await Promise.resolve()

    actor.send({
      type: 'ROUTE_CHANGED',
      route: { kind: 'project', projectContextId },
    })

    expect(actor.getSnapshot().value).toBe('idle')
    expect(actor.getSnapshot().context.snapshot).toBeNull()
    actor.stop()
  })

  it('maps a bounded reopen failure and retries the same route', async () => {
    const { actor, pending } = reopenController(documentRoute)

    pending.get(sourceDocumentId)!.reject({
      code: 'source_artifact_unavailable',
      message: 'The retained Source Document artifact is unavailable.',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context.failure).toEqual({
      code: 'source_artifact_unavailable',
      message: 'The retained Source Document artifact is unavailable.',
    })
    expect(actor.getSnapshot().context.snapshot).toBeNull()

    actor.send({ type: 'RETRY' })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(actor.getSnapshot().context.failure).toBeNull()
    actor.stop()
  })

  it('retries after the open workspace loses a retained artifact', async () => {
    const { actor, pending } = reopenController(documentRoute)
    pending.get(sourceDocumentId)!.resolve(snapshotOf(sourceDocumentId))
    await Promise.resolve()

    actor.send({ type: 'RESOURCE_FAILED' })

    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context.snapshot).toBeNull()
    expect(actor.getSnapshot().context.failure).toEqual({
      code: 'source_artifact_unavailable',
      message: 'The retained Source Document artifact is unavailable.',
    })

    actor.send({ type: 'RETRY' })
    expect(actor.getSnapshot().value).toBe('opening')
    actor.stop()
  })

  it('reports an unrecognized read failure as unavailable persistence', async () => {
    const { actor, pending } = reopenController(documentRoute)

    pending.get(sourceDocumentId)!.reject(new Error('postgresql://secret'))
    await Promise.resolve()
    await Promise.resolve()

    expect(actor.getSnapshot().context.failure).toEqual({
      code: 'persistence_unavailable',
      message: 'Project Context storage is unavailable.',
    })
    actor.stop()
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
      snapshot: null,
      failure: null,
    })
    actor.stop()
  })
})
