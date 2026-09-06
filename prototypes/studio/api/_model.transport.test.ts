import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { extractWithModel } from './_model.js'
import { resolveCapabilityRoute } from './_provider.js'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['valid result', '{"records":[{"title":"Grounded"}]}'],
  ['malformed JSON', 'not JSON'],
  ['invalid root', '[]'],
])('sends the extraction schema without retrying a %s from OpenAI-compatible', async (scenario, content) => {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (_url: unknown, options: RequestInit) => {
    requests.push(JSON.parse(String(options.body)))
    return new Response(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
  })
  const connectionId = '11111111-1111-4111-8111-111111111111'
  const target = await resolveCapabilityRoute('extraction', {}, {
    config: {
      connections: [{ id: connectionId, name: 'Test', provider: 'openai-compatible', baseUrl: 'https://audit.invalid/v1' }],
      routes: { extraction: { connectionId, modelId: 'test' }, interaction: null },
    },
    credentialStore: { get: async () => undefined, state: async () => 'absent', set: async () => {}, delete: async () => {} },
  })
  const result = extractWithModel({ document: { file: null, markdown: 'Grounded', pages: null }, template: { records: [{ title: 'string' }] } }, target)
  if (scenario === 'valid result') await expect(result).resolves.toMatchObject({ result: JSON.parse(content) })
  else await expect(result).rejects.toMatchObject({ code: 'invalid_model_output' })
  expect(requests).toHaveLength(1)
  expect(requests[0].response_format).toMatchObject({
    type: 'json_schema',
    json_schema: {
      strict: true,
      schema: {
        additionalProperties: false,
        required: ['records'],
        properties: { records: { anyOf: expect.arrayContaining([
          expect.objectContaining({ type: 'array', items: expect.objectContaining({ required: ['title'] }) }),
        ]) } },
      },
    },
  })
})

it('sends a JSON schema through the Anthropic adapter on a schema-enabled route', async () => {
  const requests: Record<string, unknown>[] = []
  const provider = createAnthropic({
    apiKey: 'test-only',
    fetch: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)))
      return new Response(JSON.stringify({
        id: 'test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: '{"records":[{"title":"Grounded"}]}' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } })
    },
  })
  await extractWithModel({
    document: { file: null, markdown: 'Grounded', pages: null },
    template: { records: [{ title: 'string' }] },
  }, { profile: 'general', model: provider('claude-sonnet-4-6'), jsonOutput: 'schema', temperatureSupported: true })
  expect(requests).toHaveLength(1)
  expect(requests[0].output_config).toMatchObject({ format: {
    type: 'json_schema', schema: { additionalProperties: false, required: ['records'] },
  } })
})

it.each([false, true])('keeps prompt-only endpoints compatible (automatic=%s)', async (automatic) => {
  const requests: Record<string, unknown>[] = []
  const provider = createOpenAICompatible({
    name: 'audit-compatible', baseURL: 'https://audit.invalid/v1',
    supportsStructuredOutputs: true,
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body))
      requests.push(body)
      if (body.response_format) return new Response(JSON.stringify({ error: { message: 'response_format is not supported', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ id: 'audit', object: 'chat.completion', created: 1, model: 'audit', choices: [{ index: 0, message: { role: 'assistant', content: '{"records":[{"title":"Grounded"}]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const target = { profile: 'general' as const, model: provider.chatModel('audit'), jsonOutput: automatic ? 'schema' as const : 'prompt' as const, temperatureSupported: true,
    ...(automatic ? { automaticOutputKey: 'test-compatible-auto' } : {}),
  }
  const input = { document: { file: null, markdown: 'Grounded', pages: null }, template: { records: [{ title: 'string' }] } }
  await expect(extractWithModel(input, target)).resolves.toMatchObject({ result: { records: [{ title: 'Grounded' }] } })
  expect(requests.at(-1)!.response_format).toBeUndefined()
  expect(requests).toHaveLength(automatic ? 2 : 1)
  if (automatic) {
    expect(requests[0].response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } })
    await extractWithModel(input, target)
    expect(requests).toHaveLength(3)
    expect(requests[2].response_format).toBeUndefined()
    await extractWithModel(input, { ...target, automaticOutputKey: 'test-another-endpoint' })
    expect(requests).toHaveLength(5)
    expect(requests[3].response_format).toBeDefined()
  }
})

it.each([
  [401, 'Unauthorized'],
  [400, 'Invalid JSON schema: additionalProperties must be false'],
  [400, 'Context window exceeded'],
] as const)('never falls back for %s: %s', async (status, message) => {
  const requests: Record<string, unknown>[] = []
  const provider = createOpenAICompatible({ name: 'failure-test', baseURL: 'https://audit.invalid/v1', supportsStructuredOutputs: true,
    fetch: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)))
      return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
        status, headers: { 'content-type': 'application/json' },
      })
    },
  })
  await expect(extractWithModel({
    document: { file: null, markdown: 'Grounded', pages: null }, template: { title: 'string' },
  }, { profile: 'general', model: provider.chatModel('audit'), jsonOutput: 'schema',
    automaticOutputKey: message, temperatureSupported: true,
  })).rejects.toThrow()
  expect(requests).toHaveLength(1)
  expect(requests[0].response_format).toBeDefined()
})

