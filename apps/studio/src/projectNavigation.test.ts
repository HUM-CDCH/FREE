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
const extractionId = '00000000-0000-4000-8000-000000000047'
const batchExtractionId = '00000000-0000-4000-8000-000000000048'

describe('Project Context routes', () => {
  it.each([
    ['/', { kind: 'root' }],
    ['/studio', { kind: 'root' }],
    ['/anything', { kind: 'root' }],
    ['/projects', { kind: 'root' }],
    [
      `/projects/${projectContextId}/`,
      { kind: 'project', projectContextId, tab: 'sources' },
    ],
    [
      `/projects/${projectContextId}/documents`,
      { kind: 'project', projectContextId, tab: 'sources' },
    ],
    [
      `/projects/${projectContextId}/schemas`,
      { kind: 'project', projectContextId, tab: 'schemas' },
    ],
    [
      `/projects/${projectContextId}/schemas/`,
      { kind: 'project', projectContextId, tab: 'schemas' },
    ],
    [
      `/projects/${projectContextId}/extractions`,
      { kind: 'project', projectContextId, tab: 'extractions' },
    ],
    [
      `/projects/${projectContextId}/extractions/${batchExtractionId}`,
      { kind: 'project', projectContextId, tab: 'extractions', batchExtractionId },
    ],
    [
      `/projects/${projectContextId}/extractions/review`,
      { kind: 'badReference' },
    ],
    [
      `/projects/${projectContextId}/documents/${sourceDocumentId}`,
      { kind: 'document', projectContextId, sourceDocumentId },
    ],
    [
      `/projects/${projectContextId}/documents/${sourceDocumentId}?extractionId=${extractionId}`,
      { kind: 'document', projectContextId, sourceDocumentId, extractionId },
    ],
    ['/projects/NOT-A-UUID', { kind: 'badReference' }],
    [`/projects/${projectContextId}/sources`, { kind: 'badReference' }],
    [`/projects/${projectContextId}/schemas/extra`, { kind: 'badReference' }],
    [
      `/projects/${projectContextId}/extractions/not-a-uuid`,
      { kind: 'badReference' },
    ],
    [`/projects/NOT-A-UUID/schemas`, { kind: 'badReference' }],
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
    { kind: 'project', projectContextId, tab: 'sources' },
    { kind: 'project', projectContextId, tab: 'schemas' },
    { kind: 'project', projectContextId, tab: 'extractions' },
    { kind: 'project', projectContextId, tab: 'extractions', batchExtractionId },
    { kind: 'document', projectContextId, sourceDocumentId },
    { kind: 'document', projectContextId, sourceDocumentId, extractionId },
    { kind: 'document', projectContextId, sourceDocumentId, extractionId, reviewCut: { snapshotVersion: 1, feedbackVersion: 2 } },
  ])('builds the canonical href for $kind routes', (route) => {
    expect(parseRoute(href(route))).toEqual(route)
  })

  // The roundtrip alone would accept any self-consistent grammar; these are the
  // URLs researchers copy and share, so they are asserted literally.
  it('keeps one canonical URL per resource tab', () => {
    expect(href({ kind: 'project', projectContextId, tab: 'sources' })).toBe(
      `/projects/${projectContextId}`,
    )
    expect(href({ kind: 'project', projectContextId, tab: 'schemas' })).toBe(
      `/projects/${projectContextId}/schemas`,
    )
    expect(href({ kind: 'project', projectContextId, tab: 'extractions' })).toBe(
      `/projects/${projectContextId}/extractions`,
    )
    expect(
      href({
        kind: 'project',
        projectContextId,
        tab: 'extractions',
        batchExtractionId,
      }),
    ).toBe(`/projects/${projectContextId}/extractions/${batchExtractionId}`)
  })

  it('names an Extraction\'s result and decision cut only beside that Extraction', () => {
    const cut = { snapshotVersion: 1, feedbackVersion: 2 }
    expect(href({ kind: 'document', projectContextId, sourceDocumentId, extractionId, reviewCut: cut }))
      .toBe(`/projects/${projectContextId}/documents/${sourceDocumentId}?extractionId=${extractionId}&snapshotVersion=1&feedbackVersion=2`)
    // A cut without its Extraction names nothing to open, in either direction.
    expect(href({ kind: 'document', projectContextId, sourceDocumentId, reviewCut: cut }))
      .toBe(`/projects/${projectContextId}/documents/${sourceDocumentId}`)
    expect(parseRoute(`/projects/${projectContextId}/documents/${sourceDocumentId}?snapshotVersion=1&feedbackVersion=2`))
      .toEqual({ kind: 'document', projectContextId, sourceDocumentId })
    // Both versions are needed; an incomplete or malformed cut opens the live cut.
    expect(parseRoute(`/projects/${projectContextId}/documents/${sourceDocumentId}?extractionId=${extractionId}&snapshotVersion=1`))
      .toEqual({ kind: 'document', projectContextId, sourceDocumentId, extractionId })
  })

  it('reads a value link\'s value with or without its Extraction, and never writes it back', () => {
    const document = `/projects/${projectContextId}/documents/${sourceDocumentId}`
    expect(parseRoute(`${document}?value=record-505%3Atitle`))
      .toEqual({ kind: 'document', projectContextId, sourceDocumentId, value: 'record-505:title' })
    expect(parseRoute(`${document}?extractionId=${extractionId}&snapshotVersion=1&feedbackVersion=2&value=site`))
      .toEqual({ kind: 'document', projectContextId, sourceDocumentId, extractionId, reviewCut: { snapshotVersion: 1, feedbackVersion: 2 }, value: 'site' })
    // A navigation in Studio drops it; only a reload or Back keeps the URL that has it.
    expect(href({ kind: 'document', projectContextId, sourceDocumentId, extractionId, value: 'site' }))
      .toBe(`${document}?extractionId=${extractionId}`)
  })

  it('has no batch review grid route', () => {
    expect(parseRoute(`/projects/${projectContextId}/extractions/${batchExtractionId}/review`)).toEqual({ kind: 'badReference' })
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
      name: 'Elmbrooke, TAK 9355',
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
      current: true,
      resources: {
        sourcePdfUrl: `/api/project-contexts/${projectContextId}/source-representations/${documentId}/pdf`,
        markdownUrl: `/api/project-contexts/${projectContextId}/source-representations/${documentId}/markdown`,
        parsedDocumentUrl: `/api/project-contexts/${projectContextId}/source-representations/${documentId}/source`,
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
    { input: { deps: { push,replace:vi.fn() }, initialRoute } },
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
    { kind: 'project', projectContextId, tab: 'sources' },
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
      route: { kind: 'project', projectContextId, tab: 'sources' },
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

  it('refreshes the open Source Document in place and swaps in the new snapshot only once it is read', async () => {
    const { actor, pending } = reopenController(documentRoute)
    pending.get(sourceDocumentId)!.resolve(snapshotOf(sourceDocumentId))
    await Promise.resolve()
    const opened = actor.getSnapshot().context.snapshot

    actor.send({ type: 'REFRESH' })
    expect(actor.getSnapshot().value).toBe('refreshing')
    expect(actor.getSnapshot().context.snapshot).toBe(opened)

    const fresh = snapshotOf(sourceDocumentId)
    const superseded = { ...fresh, sourceRepresentation: { ...fresh.sourceRepresentation, current: false } }
    pending.get(sourceDocumentId)!.resolve(superseded)
    await Promise.resolve()

    expect(actor.getSnapshot().value).toBe('open')
    expect(actor.getSnapshot().context.snapshot).toBe(superseded)
    actor.stop()
  })

  it('re-reads only "Latest reviewed" once a review is finalized, and keeps the rest of the open snapshot', async () => {
    const attempt = (id: string) => ({ extractionId: id }) as unknown as DocumentSnapshot['latestAttempt']
    const { actor, pending } = reopenController(documentRoute)
    pending.get(sourceDocumentId)!.resolve({ ...snapshotOf(sourceDocumentId), latestAttempt: attempt(extractionId) })
    await Promise.resolve()
    const opened = actor.getSnapshot().context.snapshot!

    actor.send({ type: 'REFRESH_REVIEWED' })
    expect(actor.getSnapshot().value).toBe('refreshingReviewed')
    expect(actor.getSnapshot().context.snapshot).toBe(opened)

    const fresh = snapshotOf(sourceDocumentId)
    const reviewed = attempt(extractionId)
    // The same read names a newer Extraction (a batch member, say), which must not replace the shown one.
    pending.get(sourceDocumentId)!.resolve({
      ...fresh,
      sourceRepresentation: { ...fresh.sourceRepresentation, current: false },
      latestAttempt: attempt('00000000-0000-4000-8000-000000000049'),
      latestReviewed: reviewed,
    })
    await Promise.resolve()

    expect(actor.getSnapshot().value).toBe('open')
    expect(actor.getSnapshot().context.snapshot).toEqual({ ...opened, latestReviewed: reviewed })
    expect(actor.getSnapshot().context.snapshot!.latestAttempt).toBe(opened.latestAttempt)
    actor.stop()
  })

  it('lets a full refresh take over a "Latest reviewed" read', async () => {
    const { actor, pending } = reopenController(documentRoute)
    pending.get(sourceDocumentId)!.resolve(snapshotOf(sourceDocumentId))
    await Promise.resolve()

    actor.send({ type: 'REFRESH_REVIEWED' })
    const reviewedRead = pending.get(sourceDocumentId)!
    actor.send({ type: 'REFRESH' })

    expect(actor.getSnapshot().value).toBe('refreshing')
    expect(reviewedRead.signal.aborted).toBe(true)
    actor.stop()
  })

  it.each(['REFRESH', 'REFRESH_REVIEWED'] as const)('keeps the open Source Document when its refresh fails (%s)', async (type) => {
    const { actor, pending } = reopenController(documentRoute)
    pending.get(sourceDocumentId)!.resolve(snapshotOf(sourceDocumentId))
    await Promise.resolve()
    const opened = actor.getSnapshot().context.snapshot

    actor.send({ type })
    pending.get(sourceDocumentId)!.reject({
      code: 'persistence_unavailable',
      message: 'Persistence is unavailable.',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(actor.getSnapshot().value).toBe('open')
    expect(actor.getSnapshot().context.snapshot).toBe(opened)
    expect(actor.getSnapshot().context.failure).toBeNull()
    actor.stop()
  })

  it.each(['REFRESH', 'REFRESH_REVIEWED'] as const)('refreshes nothing unless a Source Document is open (%s)', (type) => {
    const { actor, pending } = reopenController(documentRoute)
    actor.send({ type })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(pending.size).toBe(1)
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
    const replace=vi.fn()
    const actor = createActor(navigationMachine, {
      input: { deps: { push,replace }, initialRoute: { kind: 'root' } },
    })
    actor.start()

    const projectRoute = {
      kind: 'project',
      projectContextId,
      tab: 'sources',
    } as const
    actor.send({ type: 'NAVIGATE', route: projectRoute })
    expect(push).toHaveBeenCalledWith(projectRoute)
    expect(actor.getSnapshot().context.route).toEqual(projectRoute)

    actor.send({ type: 'ROUTE_CHANGED', route: { kind: 'root' } })
    expect(push).toHaveBeenCalledOnce()
    expect(actor.getSnapshot().context).toEqual({
      deps: { push,replace },
      route: { kind: 'root' },
      snapshot: null,
      failure: null,
    })
    actor.stop()
  })
})
