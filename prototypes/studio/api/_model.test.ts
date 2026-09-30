import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSchemaEditJson } from './_schema_edit.js'
import { generateSchemaWithModel } from './_schema_suggestion.js'
import type { ExecutionTarget, NuExtractExecutionTarget } from './_provider.js'
import { readAccountModelConfig } from './_model_config.js'
import { ModelKeyRequiredError, createModelKeyCache } from './_model_keys.js'

const { generateTextMock, stepStatus } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  stepStatus: { current: undefined as undefined | { cancelSignal: AbortSignal } },
}))
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { get stepStatus() { return stepStatus.current } } }))
vi.mock('./_model_config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_model_config.js')>()),
  readAccountModelConfig: vi.fn(),
}))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: generateTextMock }
})

const CALLER = { researcherAccountId: '51000000-0000-4000-8009-00000000000a' }
const document = { file: null, markdown: 'Grave 1', pages: null }
const nuextractTarget: NuExtractExecutionTarget = {
  profile: 'nuextract',
  modelId: 'numind/NuExtract3-FP8',
  baseUrl: 'http://nuextract_model:8000/v1',
  key: async () => 'sk-test-nuextract',
  temperatureSupported: true,
}
const generalTarget: ExecutionTarget = {
  profile: 'general',
  model: {
    specificationVersion: 'v4',
    provider: 'test-provider',
    modelId: 'test-model',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  },
  jsonOutput: 'prompt',
  temperatureSupported: false,
}

function stubNuExtractResponse(content: string, finishReason = 'stop') {
  const request = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  )
  vi.stubGlobal('fetch', request)
  return request
}

afterEach(() => {
  vi.unstubAllGlobals()
  generateTextMock.mockReset()
  vi.mocked(readAccountModelConfig).mockReset()
  stepStatus.current = undefined
})

describe('generateSchemaWithModel', () => {
  it('repairs generated model JSON on the NuExtract path', async () => {
    stubNuExtractResponse('{"_description":"One grave record.","grave":[{"name":"verbatim-string"}}]')
    const result = await generateSchemaWithModel(
      CALLER,
      { document, instruction: '' },
      nuextractTarget,
    )
    expect(result.template).toEqual({ _description: 'One grave record.', grave: [{ name: 'verbatim-string' }] })
  })

  it('rejects a generated schema without a root record description', async () => {
    stubNuExtractResponse('{"grave":[{"name":"verbatim-string"}]}')

    await expect(
      generateSchemaWithModel(
        CALLER,
        { document, instruction: '' },
        nuextractTarget,
      ),
    ).rejects.toMatchObject({ code: 'invalid_model_output' })
  })

  it('asks vLLM for template generation, leading the message with schema guidance', async () => {
    const request = stubNuExtractResponse('{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}')
    await generateSchemaWithModel(
      CALLER,
      { document, instruction: '' },
      nuextractTarget,
    )
    const [url, init] = request.mock.calls[0]!
    expect(url).toBe('http://nuextract_model:8000/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-test-nuextract' })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      model: 'numind/NuExtract3-FP8',
      chat_template_kwargs: { mode: 'template-generation', enable_thinking: false },
      temperature: 0.2,
    })
    expect(body.messages).toHaveLength(1)
    const text = JSON.stringify(body.messages[0].content)
    expect(text.indexOf('compact JSON extraction schema')).toBeLessThan(text.indexOf('Grave 1'))
    expect(text).not.toContain('【')
  })

  it('sends no authorization header for a keyless target', async () => {
    const request = stubNuExtractResponse('{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}')
    await generateSchemaWithModel(
      CALLER,
      { document, instruction: '' },
      { ...nuextractTarget, key: async () => null },
    )
    expect(request.mock.calls[0]![1].headers).toEqual({ 'content-type': 'application/json' })
  })

  it('the NuExtract protocol reads the key inside the attempt and sends it as a bearer token', async () => {
    const request = stubNuExtractResponse('{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}')
    const controller = new AbortController()
    const key = vi.fn(async () => {
      // The key is read when the attempt runs, before its request.
      expect(request).not.toHaveBeenCalled()
      return 'sk-test-in-attempt'
    })

    await generateSchemaWithModel(CALLER, { document, instruction: '', signal: controller.signal }, { ...nuextractTarget, key })

    expect(key).toHaveBeenCalledExactlyOnceWith(controller.signal)
    expect(request.mock.calls[0]![1].headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-test-in-attempt' })
  })

  it("NuExtract's key wait and fetch receive the step's cancel signal", async () => {
    const request = stubNuExtractResponse('{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}')
    const cancel = new AbortController()
    stepStatus.current = { cancelSignal: cancel.signal }
    const keySignals: (AbortSignal | undefined)[] = []
    const key = vi.fn(async (signal: AbortSignal | undefined) => { keySignals.push(signal); return 'sk-test-in-step' })

    await generateSchemaWithModel(CALLER, { document, instruction: '' }, { ...nuextractTarget, key })

    const fetched = request.mock.calls[0]![1].signal as AbortSignal
    expect(fetched.aborted).toBe(false)
    expect(keySignals[0]?.aborted).toBe(false)
    cancel.abort(new Error('workflow cancelled'))
    expect(fetched.aborted).toBe(true)
    expect(keySignals[0]?.aborted).toBe(true)
  })

  it("a NuExtract key wait ended by the step's cancel signal never reaches vLLM", async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const cancel = new AbortController()
    stepStatus.current = { cancelSignal: cancel.signal }
    const reason = new Error('workflow cancelled')

    const call = generateSchemaWithModel(CALLER, { document, instruction: '' }, {
      ...nuextractTarget,
      // As the real key wait does: fail at once when already aborted, else on the abort.
      key: (signal) => new Promise<string>((_, reject) => {
        if (signal?.aborted) reject(signal.reason)
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    }).catch((error: unknown) => error)
    cancel.abort(reason)

    expect(await call).toMatchObject({ status: 502, code: 'model_operation_failed', cause: reason })
    expect(request).not.toHaveBeenCalled()
  })

  it('a keyed NuExtract call with no key never reaches vLLM', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)

    const failure = await generateSchemaWithModel(CALLER, { document, instruction: '' }, {
      ...nuextractTarget,
      key: async () => { throw new ModelKeyRequiredError() },
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ModelKeyRequiredError)
    expect(failure).toMatchObject({ status: 409, code: 'model_key_required' })
    expect(request).not.toHaveBeenCalled()
  })

  it('a NuExtract call aborted during the key wait never reaches vLLM', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const controller = new AbortController()
    const arrival = Promise.withResolvers<string>()

    const call = generateSchemaWithModel(CALLER, { document, instruction: '', signal: controller.signal }, {
      ...nuextractTarget,
      key: () => arrival.promise,
    }).catch((error: unknown) => error)
    controller.abort(new Error('client disconnected'))
    // The key still arrives after the abort; the attempt must not use it.
    arrival.resolve('sk-test-late')

    await expect(call).resolves.toBeInstanceOf(Error)
    expect(request).not.toHaveBeenCalled()
  })

  it('maps a failed NuExtract call to a model operation failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('overloaded', { status: 503 })))
    await expect(generateSchemaWithModel(CALLER, { document, instruction: '' }, nuextractTarget))
      .rejects.toMatchObject({ status: 502, code: 'model_operation_failed' })
  })

  it('maps a rejected NuExtract request to a model operation failure that keeps its cause', async () => {
    const failure = new TypeError('fetch failed')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(failure))
    await expect(generateSchemaWithModel(CALLER, { document, instruction: '' }, nuextractTarget))
      .rejects.toMatchObject({
        status: 502,
        code: 'model_operation_failed',
        message: 'NuExtract generation failed.',
        cause: failure,
      })
  })

  it('passes cancellation to the NuExtract request', async () => {
    const request = stubNuExtractResponse(
      '{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}',
    )
    const controller = new AbortController()

    await generateSchemaWithModel(
      CALLER,
      { document, instruction: '', signal: controller.signal },
      nuextractTarget,
    )

    expect(request.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    })
  })

  it('uses the selected general target for schema suggestion', async () => {
    generateTextMock.mockResolvedValue({ text: '{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}' })
    const result = await generateSchemaWithModel(
      CALLER,
      { document, instruction: '' },
      generalTarget,
    )
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(result.template).toEqual({ _description: 'One grave record.', grave: [{ name: 'verbatim-string' }] })
  })

  it('bounds schema context while retaining excerpts from every physical page', async () => {
    generateTextMock.mockResolvedValue({ text: '{"_description":"One entry.","label":"string"}' })
    // Pages as the parsing pipeline writes them: a blank line between, no marker, each with its span in UTF-8 bytes.
    const pages = Array.from({ length: 45 }, (_, i) => `Start ${i + 1}\n${'Source '.repeat(1700)}\nEnd ${i + 1}`)
    const markdown = pages.join('\n\n') + '\n'
    let start = 0
    const pageSpans = pages.map((page, i) => {
      const span = { pageNumber: i + 1, start, end: start + new TextEncoder().encode(page).length }
      start = span.end + 2
      return span
    })
    const result = await generateSchemaWithModel(CALLER, { document: { ...document, markdown, pageSpans }, instruction: '' }, generalTarget)
    const sent = JSON.stringify(generateTextMock.mock.calls[0][0].messages)
    expect(sent.length).toBeLessThan(55_000)
    for (let i = 1; i <= 45; i += 1) {
      expect(sent).toContain(`Start ${i}`)
      expect(sent).toContain(`End ${i}`)
    }
    expect(sent).toContain('excerpts')
    // The suggestion does not claim the whole source: every excerpted page's unsent middle is declared.
    if (result.sourceCoverage.complete) throw new Error('expected an excerpted source to be declared incomplete')
    expect(result.sourceCoverage.sourceCharacters).toBe(markdown.length)
    expect(result.sourceCoverage.omitted.map((omission) => omission.page)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1))
  })

  it('sends a supplied window unchanged in one call', async () => {
    generateTextMock.mockResolvedValue({ text: '{"_description":"One entry.","label":"string"}' })
    const window = 'A'.repeat(25_000) + 'UNIQUE_MIDDLE_FIELD' + 'Z'.repeat(25_000)
    const result = await generateSchemaWithModel(
      CALLER, { document: { ...document, markdown: window }, instruction: '', window: true }, generalTarget)
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(JSON.stringify(generateTextMock.mock.calls[0][0].messages)).toContain(window)
    expect(result.sourceCoverage).toEqual({ complete: true })
  })

  it('declares a source it sent whole complete', async () => {
    generateTextMock.mockResolvedValue({ text: '{"_description":"One entry.","label":"string"}' })
    const result = await generateSchemaWithModel(CALLER, { document: { ...document, markdown: '# A short register' }, instruction: '' }, generalTarget)
    expect(result.sourceCoverage).toEqual({ complete: true })
  })

  it('passes cancellation to the generic model call', async () => {
    generateTextMock.mockResolvedValue({ text: '{"_description":"One grave record.","grave":[{"name":"verbatim-string"}]}' })
    const controller = new AbortController()

    await generateSchemaWithModel(
      CALLER,
      { document, instruction: '', signal: controller.signal },
      generalTarget,
    )

    expect(generateTextMock.mock.calls[0]?.[0]).toMatchObject({
      abortSignal: controller.signal,
    })
  })
})

describe('interactive model operations', () => {
  it.each(['prompt', 'schema'] as const)('does not request schema-free JSON on a %s route', async (jsonOutput) => {
    generateTextMock.mockResolvedValue({ text: '{"fields":{},"additions":[]}', finishReason: 'stop' })

    const result = await generateSchemaEditJson(CALLER, 'schema prompt', undefined, undefined, { ...generalTarget, jsonOutput })

    expect(generateTextMock.mock.calls[0][0]).toMatchObject({
      reasoning: 'none',
      messages: [{ role: 'user', content: 'schema prompt' }],
    })
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty('output')
    expect(result.text).toBe('{"fields":{},"additions":[]}')
  })

  it('requests bounded JSON with reasoning disabled on a native route', async () => {
    generateTextMock.mockResolvedValue({ text: '{"fields":{},"additions":[]}', finishReason: 'stop' })

    await generateSchemaEditJson(CALLER, 'schema prompt', undefined, undefined, { ...generalTarget, jsonOutput: 'native' })

    expect(generateTextMock.mock.calls[0][0]).toMatchObject({
      output: expect.anything(),
      reasoning: 'none',
      messages: [{ role: 'user', content: 'schema prompt' }],
    })
  })

  it('passes the request signal to a schema edit, so a key wait ends when the browser leaves', async () => {
    generateTextMock.mockResolvedValue({ text: '{"fields":{},"additions":[]}', finishReason: 'stop' })
    const controller = new AbortController()

    await generateSchemaEditJson(CALLER, 'schema prompt', undefined, controller.signal, generalTarget)

    expect(generateTextMock.mock.calls[0][0]).toMatchObject({ abortSignal: controller.signal })
  })

  it('rejects a length-truncated schema edit before parsing', async () => {
    generateTextMock.mockResolvedValue({ text: '{"fields":', finishReason: 'length' })

    await expect(generateSchemaEditJson(CALLER, 'schema prompt', undefined, undefined, generalTarget)).rejects.toMatchObject({
      code: 'invalid_model_output',
    })
  })
})

describe("a model call reads its caller's configuration", () => {
  const connectionId = '51000000-0000-4000-8009-0000000000c1'
  const config = {
    connections: [{ id: connectionId, name: 'Gateway', provider: 'openai-compatible' as const, baseUrl: 'https://gateway.example/v1', hasKey: false }],
    routes: { schemaSuggestion: null, interaction: { connectionId, modelId: 'caller-model' } },
    extractionModels: {},
    ingestionModels: {},
    extractionSettings: {},
  }
  // Key cache, deployment and provider stay fakes: resolution must not reach the process cache or the environment.
  const isolated = {
    deployment: { connections: [], defaultRoute: null },
    keys: createModelKeyCache(),
    modelFactories: { 'openai-compatible': () => generalTarget.profile === 'general' ? generalTarget.model : ({} as never) },
  }

  it('uses an injected reader and never the stored configuration', async () => {
    generateTextMock.mockResolvedValue({ text: '{"fields":{},"additions":[]}', finishReason: 'stop' })
    const readConfig = vi.fn(async () => config)

    await generateSchemaEditJson(CALLER, 'schema prompt', undefined, undefined, undefined, { ...isolated, readConfig })

    expect(readConfig).toHaveBeenCalledOnce()
    expect(readConfig).toHaveBeenCalledWith()
    expect(readAccountModelConfig).not.toHaveBeenCalled()
  })

  it("reads the caller's account by default", async () => {
    generateTextMock.mockResolvedValue({ text: '{"fields":{},"additions":[]}', finishReason: 'stop' })
    vi.mocked(readAccountModelConfig).mockResolvedValueOnce(config)

    await generateSchemaEditJson(CALLER, 'schema prompt', undefined, undefined, undefined, isolated)

    expect(readAccountModelConfig).toHaveBeenCalledOnce()
    expect(readAccountModelConfig).toHaveBeenCalledWith(CALLER.researcherAccountId)
    expect(generateTextMock).toHaveBeenCalledOnce()
  })
})
