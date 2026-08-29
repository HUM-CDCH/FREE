import type { LanguageModel } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectHttpExchange, inspectTarget } from './_llm_inspector.js'
import { DELETE, GET, type LlmTrace } from './llm_inspector.js'
import type { GeneralExecutionTarget, ModelOperation, NuExtractRawExecutionTarget } from './_provider.js'

const rawTarget: NuExtractRawExecutionTarget = {
  profile: 'nuextract-raw',
  modelId: 'nuextract',
  baseUrl: 'http://localhost:11434',
  authorization: 'Bearer secret',
  temperatureSupported: true,
}
const generated = {
  content: [{ type: 'text', text: 'Complete model text' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 } },
  warnings: [],
}

type CallableModel = {
  doGenerate(params: unknown): Promise<unknown>
  doStream(params: unknown): Promise<{ stream: ReadableStream<unknown> }>
}

function model(overrides: Partial<CallableModel> = {}): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test-provider',
    modelId: 'test-model',
    supportedUrls: {},
    doGenerate: async () => generated,
    doStream: async () => ({ stream: new ReadableStream() }),
    ...overrides,
  } as unknown as LanguageModel
}

function inspected(
  providerModel: LanguageModel,
  operation: ModelOperation = 'chat',
): CallableModel {
  const target: GeneralExecutionTarget = {
    profile: 'general',
    model: providerModel,
    jsonOutput: 'prompt',
    temperatureSupported: true,
  }
  return inspectTarget(operation, target).model as unknown as CallableModel
}

async function traces(): Promise<LlmTrace[]> {
  return ((await GET().json()) as { traces: LlmTrace[] }).traces
}

afterEach(() => DELETE())

describe('LLM inspector middleware', () => {
  it('returns generated values unchanged and redacts credentials', async () => {
    const wrapped = inspected(model())
    const result = await wrapped.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Complete source text' }] }],
      url: 'https://alice:password@example.test/v1?api_key=query-secret',
      headers: { authorization: 'Bearer auth-secret', 'x-goog-api-key': 'google-secret', token: 'plain-token-secret' },
    })

    expect(result).toBe(generated)
    const [trace] = await traces()
    expect(trace).toMatchObject({ operation: 'chat', provider: 'test-provider', model: 'test-model', status: 'complete' })
    expect(trace.request).toContain('Complete source text')
    for (const secret of ['alice', 'password', 'query-secret', 'auth-secret', 'google-secret', 'plain-token-secret']) {
      expect(trace.request).not.toContain(secret)
    }
    expect(trace.response).toContain('Complete model text')
  })

  it('captures retry attempts independently and preserves provider errors', async () => {
    const providerError = new Error('request to https://alice:password@example.test/v1?api_key=query-secret failed')
    const doGenerate = vi.fn().mockRejectedValueOnce(providerError).mockResolvedValueOnce(generated)
    const wrapped = inspected(model({ doGenerate }))

    await expect(wrapped.doGenerate({ prompt: [] })).rejects.toBe(providerError)
    await expect(wrapped.doGenerate({ prompt: [] })).resolves.toBe(generated)

    const history = await traces()
    expect(history.map(({ status }) => status)).toEqual(['complete', 'failed'])
    for (const secret of ['alice', 'password', 'query-secret']) {
      expect(history[1].response).not.toContain(secret)
    }
  })

  it('captures every operation newest-first and redacts paths, hashes, and URL credentials', async () => {
    const operations = [
      'schema-suggestion',
      'schema-edit',
      'extraction',
      'chat',
    ] as const
    for (const operation of operations) {
      const wrapped = inspected(model(), operation)
      await wrapped.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: operation }] }],
      })
    }
    const unsafe = new Error(
      `failed at C:\\Users\\researcher\\secret.txt /tmp/free/private.json ${'a'.repeat(64)} postgresql://alice:password@db.internal/free?token=query-secret`,
    )
    const failed = inspected(
      model({ doGenerate: async () => Promise.reject(unsafe) }),
      'extraction',
    )
    await expect(failed.doGenerate({ prompt: [] })).rejects.toBe(unsafe)

    const history = await traces()
    expect(history.map(({ operation }) => operation)).toEqual([
      'extraction',
      ...operations.toReversed(),
    ])
    const failedPayload = history[0].response ?? ''
    for (const forbidden of [
      'Users\\researcher',
      '/tmp/free',
      'a'.repeat(64),
      'alice',
      'password',
      'query-secret',
    ])
      expect(failedPayload).not.toContain(forbidden)
    expect(failedPayload).toContain('[REDACTED_PATH]')
    expect(failedPayload).toContain('[REDACTED_HASH]')
  })

  it('taps streamed chunks without changing them and records stream failures', async () => {
    const chunks = [{ type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'Hello' }]
    const wrapped = inspected(model({
      doStream: async () => ({
        stream: new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close() } }),
      }),
    }))
    const result = await wrapped.doStream({ prompt: [] })
    const received = []
    for await (const chunk of result.stream) received.push(chunk)

    expect(received).toEqual(chunks)
    expect((await traces())[0]).toMatchObject({ status: 'complete' })

    const protocolError = new Error('provider stream failed')
    const errored = inspected(model({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'error', error: protocolError })
            controller.close()
          },
        }),
      }),
    }))
    const erroredResult = await errored.doStream({ prompt: [] })
    const errorParts = []
    for await (const part of erroredResult.stream) errorParts.push(part)
    expect(errorParts).toEqual([{ type: 'error', error: protocolError }])
    expect((await traces())[0]).toMatchObject({ status: 'failed' })

    const providerError = new Error('stream failed')
    const failed = inspected(model({
      doStream: async () => ({ stream: new ReadableStream({ start(controller) { controller.error(providerError) } }) }),
    }))
    const failedResult = await failed.doStream({ prompt: [] })
    await expect(failedResult.stream.getReader().read()).rejects.toBe(providerError)
    expect((await traces())[0]).toMatchObject({ status: 'failed' })
  })

  it('forwards stream cancellation to the provider', async () => {
    const cancel = vi.fn()
    const wrapped = inspected(model({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) { controller.enqueue({ type: 'text-start', id: '1' }) },
          cancel,
        }),
      }),
    }))
    const result = await wrapped.doStream({ prompt: [] })
    const reader = result.stream.getReader()
    await reader.read()
    await reader.cancel('researcher cancelled')

    expect(cancel).toHaveBeenCalledWith('researcher cancelled')
    expect((await traces())[0]).toMatchObject({ status: 'cancelled' })
  })
})

describe('LLM inspector endpoint', () => {
  it('records failed raw exchanges', async () => {
    const response = await inspectHttpExchange(
      'extraction',
      rawTarget,
      { body: 'request' },
      async () => new Response('upstream rejected request', { status: 401 }),
    )

    expect(response.status).toBe(401)
    expect((await traces())[0]).toMatchObject({ status: 'failed' })
  })

  it('returns newest-first history, limits it to 50, and clears it', async () => {
    for (let index = 0; index < 51; index += 1) {
      await inspectHttpExchange(
        'extraction',
        rawTarget,
        { body: `request-${index}` },
        async () => Response.json({ response: `response-${index}` }),
      )
    }

    const response = GET()
    const body = await response.json() as { traces: LlmTrace[] }
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.traces).toHaveLength(50)
    expect(body.traces[0].request).toContain('request-50')
    expect(body.traces[0].response).toContain('response-50')
    expect(body.traces.at(-1)?.request).toContain('request-1')
    expect(DELETE().status).toBe(204)
    expect(await traces()).toEqual([])
  })
})
