import { describe, expect, it, vi } from 'vitest'
import type {
  ProjectStore,
  StoredExtractionAttempt,
  TerminalExtractionInput,
} from '../../../packages/db/src/project-store.js'
import parsedDocument from '../src/assets/parsed_document.v2.json'
import { createExtractionsApi } from './extractions.js'

const extractionId = '11111111-1111-4111-8111-111111111111'
const sourceDocumentId = '22222222-2222-4222-8222-222222222222'
const representationId = '33333333-3333-4333-8333-333333333333'
const schemaRevisionId = '44444444-4444-4444-8444-444444444444'
const alternateSchemaId = '55555555-5555-4555-8555-555555555555'

function request(
  id = extractionId,
  schemaId = schemaRevisionId,
) {
  return new Request('http://studio/api/extractions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      sourceRepresentationRevisionId: representationId,
      schemaRevisionId: schemaId,
      strategy: 'ARTICLE',
    }),
  })
}

function fakeStore(schemaNodes: unknown) {
  const schemaTree = {
    recordDescription: 'One representative source record.',
    schemaNodes,
  }
  const attempts = new Map<string, StoredExtractionAttempt>()
  const persist = vi.fn(async (input: TerminalExtractionInput) => {
    const existing = attempts.get(input.extractionId)
    if (existing) return { status: 'replayed' as const, attempt: existing }
    const attempt: StoredExtractionAttempt = {
      ...input,
      sourceRepresentationRevisionNumber: 1,
      extractionSchemaId: '66666666-6666-4666-8666-666666666666',
      schemaRevisionNumber: 1,
      schemaTree,
      createdAt: new Date('2026-08-10T00:00:00Z'),
      reviewedAt: null,
      reviewDecisions: [],
    }
    attempts.set(input.extractionId, attempt)
    return { status: 'created' as const, attempt }
  })
  const store: Pick<
    ProjectStore,
    | 'finalizeExtractionReview'
    | 'getExtractionInputs'
    | 'getExtractionAttempt'
    | 'getSourceRepresentation'
    | 'persistExtractionAttempt'
  > = {
    async getExtractionInputs(_representationId, schemaId) {
      if (schemaId !== schemaRevisionId) return null
      return {
        sourceDocumentId,
        projectContextId: '77777777-7777-4777-8777-777777777777',
        sourceRepresentationRevisionId: representationId,
        schemaRevisionId,
        schemaTree,
        descriptor: { artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) },
      }
    },
    async getExtractionAttempt(id) {
      return attempts.get(id) ?? null
    },
    async getSourceRepresentation() {
      return { artifactReference: 'a'.repeat(64), artifactSha256: 'a'.repeat(64) }
    },
    persistExtractionAttempt: persist,
    async finalizeExtractionReview() {
      return { status: 'invalid' }
    },
  }
  return { store, attempts, persist }
}

const target = {
  profile: 'nuextract-raw' as const,
  modelId: 'fixture',
  baseUrl: 'http://127.0.0.1:11434',
  authorization: null,
  temperatureSupported: true,
  attribution: { provider: 'ollama' as const, modelId: 'fixture' },
}

function generated(
  result: Record<string, unknown>,
  finishReason = 'stop',
) {
  return {
    result,
    raw: JSON.stringify(result),
    reasoning: null,
    pages: 1,
    modelAttribution: { provider: 'ollama' as const, modelId: 'fixture' },
    metadata: {
      finishReason,
      inputTokens: 10,
      outputTokens: 4,
      durationMs: 1,
    },
  }
}

describe('server-owned Article extraction route', () => {
  it('runs the whole-source values call for an empty schema', async () => {
    const { store } = fakeStore([])
    const extract = vi.fn().mockResolvedValue(generated({ records: [{}] }))

    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    expect(response.status).toBe(201)
    expect(extract).toHaveBeenCalledOnce()
    expect(extract.mock.calls[0][0].template).toEqual({ records: [{}] })
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      resultPayload: { records: [{}] },
      diagnostics: { modelCalls: 1 },
    })
  })

  it('preserves root and nested schema field order in the model request', async () => {
    const { store } = fakeStore([
      { id: 'z', name: 'zeta', type: 'string' },
      {
        id: 'g',
        name: 'group',
        type: 'object',
        children: [
          { id: 'b', name: 'beta', type: 'number' },
          { id: 'a', name: 'alpha', type: 'string' },
        ],
      },
      { id: 'a2', name: 'alpha', type: 'boolean' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(
        generated({
          records: [
            {
              zeta: 'last alphabetically',
              group: { beta: 2, alpha: 'nested second' },
              alpha: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        generated({
          links: { C1: 'NONE', C2: 'NONE', C3: 'NONE', C4: 'NONE' },
        }),
      )

    await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    const template = extract.mock.calls[0][0].template as {
      records: [Record<string, unknown>]
    }
    expect(Object.keys(template.records[0])).toEqual([
      'zeta',
      'group',
      'alpha',
    ])
    expect(
      Object.keys(template.records[0].group as Record<string, unknown>),
    ).toEqual(['beta', 'alpha'])
  })

  it('shares concurrent identical work and rejects mismatched in-flight reuse', async () => {
    const { store, persist } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const readStored = store.getExtractionAttempt.bind(store)
    let releaseLookup!: () => void
    const lookupBlocked = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    const lookupStarted = vi.fn()
    store.getExtractionAttempt = vi.fn(async (id) => {
      lookupStarted()
      await lookupBlocked
      return readStored(id)
    })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const extract = vi
      .fn()
      .mockImplementationOnce(async () => {
        await blocked
        return generated({ records: [{ title: 'Ellekilde' }] })
      })
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const resolveTarget = vi.fn(async () => target)
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget,
      extract,
    })

    const first = handler(request())
    await vi.waitFor(() => expect(lookupStarted).toHaveBeenCalledOnce())
    const identical = handler(request())
    const mismatchPromise = handler(request(extractionId, alternateSchemaId))
    await vi.waitFor(() =>
      expect(store.getExtractionAttempt).toHaveBeenCalledOnce(),
    )
    const mismatch = await mismatchPromise
    releaseLookup()
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1))
    release()
    const [firstResponse, identicalResponse] = await Promise.all([first, identical])

    expect(mismatch.status).toBe(409)
    expect(firstResponse.status).toBe(201)
    expect(identicalResponse.status).toBe(200)
    expect(extract).toHaveBeenCalledTimes(2)
    expect(resolveTarget).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledOnce()
    await expect(firstResponse.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      reviewable: true,
    })
  })

  it('persists multiple records returned by one Article values call', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(
        generated({
          records: [{ title: 'Ellekilde' }, { title: 'Tornby' }],
        }),
      )
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    expect(extract).toHaveBeenCalledTimes(3)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: false,
      resultPayload: {
        records: [{ title: 'Ellekilde' }, { title: 'Tornby' }],
      },
    })
  })

  it('persists usable length-truncated output as incomplete', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }, 'length'))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: true,
      diagnostics: {
        finishReason: 'length',
        values: expect.objectContaining({
          outcome: 'succeeded',
          finishReason: 'length',
        }),
      },
    })
  })

  it('marks a parseable length-truncated grounding batch incomplete', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E1' } }, 'length'))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: true,
      resultPayload: { records: [{ title: 'Ellekilde' }] },
      diagnostics: {
        finishReason: 'stop',
        grounding: {
          batches: [expect.objectContaining({ finishReason: 'length' })],
        },
      },
    })
  })

  it('rejects a model-authored foreign anchor by making the attempt unreviewable', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }))
      .mockResolvedValueOnce(generated({ links: { C1: 'E999' } }))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: false,
      evidenceLinks: [],
      diagnostics: {
        grounding: {
          ungroundedPaths: [['records', 0, 'title']],
          issueCodes: ['unknown_anchor_label'],
        },
      },
    })
  })

  it('retains usable extracted values when a grounding batch fails', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }))
      .mockRejectedValueOnce(new Error('grounder unavailable'))
    const response = await createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })(request())

    await expect(response.json()).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
      complete: false,
      reviewable: false,
      resultPayload: { records: [{ title: 'Ellekilde' }] },
      evidenceLinks: [],
      diagnostics: {
        modelCalls: 2,
        grounding: {
          ungroundedPaths: [['records', 0, 'title']],
          issueCodes: ['grounding_failed'],
          batches: [expect.objectContaining({ outcome: 'failed' })],
        },
      },
    })
  })

  it('persists cancellation before the POST returns', async () => {
    const { store, persist } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi.fn((_input: unknown) =>
      new Promise((_, reject) => {
        const signal = (_input as { signal: AbortSignal }).signal
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    )
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract: extract as never,
    })
    const post = handler(request())
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce())
    const cancelled = await handler(
      new Request(`http://studio/api/extractions/${extractionId}`, { method: 'DELETE' }),
    )
    const response = await post

    expect(cancelled.status).toBe(202)
    expect(persist).toHaveBeenCalledOnce()
    await expect(response.json()).resolves.toMatchObject({ outcome: 'CANCELLED' })
    const replay = await handler(request())
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ outcome: 'CANCELLED' })
    expect(extract).toHaveBeenCalledOnce()
  })

  it('cancels a fresh operation while its idempotency lookup is pending', async () => {
    const { store } = fakeStore([])
    const readStored = store.getExtractionAttempt.bind(store)
    let releaseLookup!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    const lookupStarted = vi.fn()
    store.getExtractionAttempt = vi.fn(async (id) => {
      lookupStarted()
      await blocked
      return readStored(id)
    })
    const readSource = vi.fn(async () => parsedDocument)
    const handler = createExtractionsApi({
      store,
      readSource,
      resolveTarget: async () => target,
      extract: vi.fn(),
    })

    const post = handler(request())
    await vi.waitFor(() => expect(lookupStarted).toHaveBeenCalledOnce())
    const cancellation = handler(
      new Request(`http://studio/api/extractions/${extractionId}`, {
        method: 'DELETE',
      }),
    )
    releaseLookup()

    expect((await cancellation).status).toBe(202)
    await expect((await post).json()).resolves.toMatchObject({
      outcome: 'CANCELLED',
    })
    expect(readSource).not.toHaveBeenCalled()
  })

  it('persists cancellation when the final grounding call resolves after abort', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    let releaseGrounding!: () => void
    const groundingBlocked = new Promise<void>((resolve) => {
      releaseGrounding = resolve
    })
    const groundingStarted = vi.fn()
    const extract = vi
      .fn()
      .mockResolvedValueOnce(generated({ records: [{ title: 'Ellekilde' }] }))
      .mockImplementationOnce(async () => {
        groundingStarted()
        await groundingBlocked
        return generated({ links: { C1: 'E1' } })
      })
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })

    const post = handler(request())
    await vi.waitFor(() => expect(groundingStarted).toHaveBeenCalledOnce())
    const cancellation = await handler(
      new Request(`http://studio/api/extractions/${extractionId}`, {
        method: 'DELETE',
      }),
    )
    releaseGrounding()

    expect(cancellation.status).toBe(202)
    await expect((await post).json()).resolves.toMatchObject({
      outcome: 'CANCELLED',
      resultPayload: null,
      evidenceLinks: null,
    })
  })

  it('does not expose a stored replay as cancellable work', async () => {
    const { store } = fakeStore([])
    const extract = vi.fn().mockResolvedValue(generated({ records: [{}] }))
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })
    expect((await handler(request())).status).toBe(201)

    const readStored = store.getExtractionAttempt.bind(store)
    let releaseLookup!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    const lookupStarted = vi.fn()
    store.getExtractionAttempt = vi.fn(async (id) => {
      lookupStarted()
      await blocked
      return readStored(id)
    })
    const replay = handler(request())
    await vi.waitFor(() => expect(lookupStarted).toHaveBeenCalledOnce())
    const cancellation = handler(
      new Request(`http://studio/api/extractions/${extractionId}`, {
        method: 'DELETE',
      }),
    )
    releaseLookup()
    expect((await cancellation).status).toBe(404)
    expect((await replay).status).toBe(200)
  })

  it('does not respond or accept cancellation after terminal persistence starts', async () => {
    const { store, persist } = fakeStore([])
    let releasePersist!: () => void
    const blocked = new Promise<void>((resolve) => {
      releasePersist = resolve
    })
    const persistStarted = vi.fn()
    store.persistExtractionAttempt = vi.fn(async (input) => {
      persistStarted()
      await blocked
      return persist(input)
    })
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract: vi.fn().mockResolvedValue(generated({ records: [{}] })),
    })
    let responded = false
    const response = handler(request()).then((value) => {
      responded = true
      return value
    })
    await vi.waitFor(() => expect(persistStarted).toHaveBeenCalledOnce())
    expect(responded).toBe(false)
    expect(
      (
        await handler(
          new Request(`http://studio/api/extractions/${extractionId}`, {
            method: 'DELETE',
          }),
        )
      ).status,
    ).toBe(404)
    releasePersist()
    expect((await response).status).toBe(201)
  })

  it('replays a failed attempt without another model call', async () => {
    const { store } = fakeStore([
      { id: 'title', name: 'title', type: 'string' },
    ])
    const extract = vi.fn().mockRejectedValue(new Error('provider failed'))
    const handler = createExtractionsApi({
      store,
      readSource: async () => parsedDocument,
      resolveTarget: async () => target,
      extract,
    })
    const failed = await handler(request())
    expect(failed.status).toBe(201)
    await expect(failed.json()).resolves.toMatchObject({ outcome: 'FAILED' })
    const replay = await handler(request())
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ outcome: 'FAILED' })
    expect(extract).toHaveBeenCalledOnce()
  })
})
