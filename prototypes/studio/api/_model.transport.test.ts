import { expect, it } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateSchemaWithModel } from './_model.js'
import { withThinkingOff } from './_provider.js'

const TEMPLATE = '{"_description":"One catalogue entry","title":"string"}'
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
  await expect(generateSchemaWithModel(input, {
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
  await expect(generateSchemaWithModel(input, target)).resolves.toMatchObject({ template: { title: 'string' } })
  expect(requests).toHaveLength(2)
  expect(requests[0].response_format).toMatchObject({ type: 'json_object' })
  expect(requests[1].response_format).toBeUndefined()
  await generateSchemaWithModel(input, target)
  expect(requests).toHaveLength(3)
  expect(requests[2].response_format).toBeUndefined()
  await generateSchemaWithModel(input, { ...target, automaticOutputKey: 'test-another-endpoint' })
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
  await expect(generateSchemaWithModel(input, {
    profile: 'general', model: provider.chatModel('audit'), jsonOutput: 'native',
    automaticOutputKey: message, temperatureSupported: true,
  })).rejects.toThrow()
  expect(requests).toHaveLength(1)
  expect(requests[0].response_format).toBeDefined()
})
