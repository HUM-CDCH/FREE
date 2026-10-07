import { inspect } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateSchemaWithModel } from './_schema_suggestion.js'
import { ApiError } from './_http.js'
import { withThinkingOff } from './_provider.js'

const TEMPLATE = '{"_description":"One catalogue entry","title":"string"}'
const CALLER = { researcherAccountId: '51000000-0000-4000-8009-00000000000b' }
const input = { document: { file: null, markdown: 'Grounded', pages: null }, instruction: '' }

function completion(content: string): Response {
  return new Response(JSON.stringify({
    id: 'audit', object: 'chat.completion', created: 1, model: 'audit',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

it('suggests a schema on a vLLM route with thinking switched off', async () => {
  const requests: Record<string, unknown>[] = []
  const provider = createOpenAICompatible({
    name: 'audit-vllm', baseURL: 'https://audit.invalid/v1', supportsStructuredOutputs: true,
    transformRequestBody: withThinkingOff,
    fetch: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)))
      return completion(TEMPLATE)
    },
  })
  await expect(generateSchemaWithModel(CALLER, input, {
    profile: 'general', model: provider.chatModel('Qwen/Qwen3.8-27B-FP8'), jsonOutput: 'schema', temperatureSupported: true,
  })).resolves.toMatchObject({ template: { _description: 'One catalogue entry', title: 'string' } })
  expect(requests).toHaveLength(1)
  expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: false })
  expect(requests[0].response_format).toBeUndefined()
})

it('falls back to prompt-only JSON once per endpoint that rejects JSON mode', async () => {
  const requests: Record<string, unknown>[] = []
  const provider = createOpenAICompatible({
    name: 'audit-compatible', baseURL: 'https://audit.invalid/v1',
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body))
      requests.push(body)
      if (body.response_format) return new Response(JSON.stringify({ error: { message: 'response_format is not supported', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      return completion(TEMPLATE)
    },
  })
  const target = {
    profile: 'general' as const, model: provider.chatModel('audit'), jsonOutput: 'native' as const,
    temperatureSupported: true, automaticOutputKey: 'test-compatible-auto',
  }
  await expect(generateSchemaWithModel(CALLER, input, target)).resolves.toMatchObject({ template: { title: 'string' } })
  expect(requests).toHaveLength(2)
  expect(requests[0].response_format).toMatchObject({ type: 'json_object' })
  expect(requests[1].response_format).toBeUndefined()
  await generateSchemaWithModel(CALLER, input, target)
  expect(requests).toHaveLength(3)
  expect(requests[2].response_format).toBeUndefined()
  await generateSchemaWithModel(CALLER, input, { ...target, automaticOutputKey: 'test-another-endpoint' })
  expect(requests).toHaveLength(5)
  expect(requests[3].response_format).toBeDefined()
})

it.each([
  [401, 'Unauthorized'],
  [400, 'Context window exceeded'],
] as const)('never falls back for %s: %s', async (status, message) => {
  const requests: Record<string, unknown>[] = []
  const provider = createOpenAICompatible({ name: 'failure-test', baseURL: 'https://audit.invalid/v1',
    fetch: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)))
      return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
        status, headers: { 'content-type': 'application/json' },
      })
    },
  })
  await expect(generateSchemaWithModel(CALLER, input, {
    profile: 'general', model: provider.chatModel('audit'), jsonOutput: 'native',
    automaticOutputKey: message, temperatureSupported: true,
  })).rejects.toThrow()
  expect(requests).toHaveLength(1)
  expect(requests[0].response_format).toBeDefined()
})

afterEach(() => {
  vi.restoreAllMocks()
})

it.each([
  ['a key the runtime refuses as a header value', 'sk-test-planted\nrest', async (url: RequestInfo | URL, options?: RequestInit) => {
    // The real runtime error: its message is the whole `Bearer <key>` header value.
    new Request(url, options)
    return completion('unreachable')
  }],
  ['a provider error that echoes the key and the request', 'sk-test-planted', async () =>
    new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-test-planted.', type: 'invalid_request_error' } }), {
      status: 401, headers: { 'content-type': 'application/json', 'x-echo': 'sk-test-planted' },
    })],
])('a failed schema generation logs neither the key nor the provider response nor the document (%s)', async (_label, apiKey, fetch) => {
  const logs = (['error', 'warn', 'log', 'info', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  const provider = createOpenAICompatible({ name: 'generation-logging', baseURL: 'https://audit.invalid/v1', apiKey, fetch })

  const failure = await generateSchemaWithModel(CALLER, {
    document: { file: null, pages: null, markdown: '# planted-document' },
    instruction: 'planted-question',
  }, { profile: 'general', model: provider.chatModel('audit'), jsonOutput: 'prompt', temperatureSupported: true })
    .then(() => { throw new Error('expected the generation to fail') }, (error: unknown) => error)

  // FREE's own copy, never the provider's: the ApiError's message is what a page would show.
  expect(failure).toBeInstanceOf(ApiError)
  const logged = logs.flatMap((log) => log.mock.calls.flat().map((argument) => inspect(argument, { depth: Infinity })))
  for (const line of [...logged, (failure as ApiError).message]) {
    expect(line).not.toContain('sk-test-planted')
    expect(line).not.toContain('planted-document')
    expect(line).not.toContain('planted-question')
  }
})
