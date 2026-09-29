import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { trace, type ProxyTracerProvider } from '@opentelemetry/api'
import type { NodeTracerProvider, ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { executeSchemaSuggestion } from '../api/_model_execution.js'
import { generateSchemaWithModel } from '../api/_schema_suggestion.js'
import { startTracing } from './tracing.js'

const SECRET = 'sk-trace-audit-0123456789'
const TEMPLATE = '{"_description":"One catalogue entry","title":"string"}'
const CALLER = { researcherAccountId: '51000000-0000-4000-8009-00000000000b' }
const input = { document: { file: null, markdown: 'Grounded source text', pages: null }, instruction: '' }

// Every span reaches this exporter, which then fails like an unreachable collector: calls must still succeed.
const spans: ReadableSpan[] = []
const failingCollector: SpanExporter = {
  export(batch, done) {
    spans.push(...batch)
    done({ code: 1, error: new Error('collector unreachable') }) // ExportResultCode.FAILED
  },
  shutdown: async () => {},
}

let server: Server
let baseURL: string
beforeAll(async () => {
  expect(await startTracing({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:9/v1/traces' }, failingCollector)).toBe(true)
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (JSON.parse(body).response_format) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: { message: 'response_format is not supported', type: 'invalid_request_error' } }))
        return
      }
      response.end(JSON.stringify({
        id: 'audit', object: 'chat.completion', created: 1, model: 'audit',
        choices: [{ index: 0, message: { role: 'assistant', content: TEMPLATE }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))
beforeEach(() => {
  spans.length = 0
  vi.unstubAllEnvs()
})

async function traced(run: () => Promise<unknown>): Promise<ReadableSpan[]> {
  await run()
  // The collector fails every export, which only the flush learns of: the call above has already succeeded.
  await ((trace.getTracerProvider() as ProxyTracerProvider).getDelegate() as NodeTracerProvider).forceFlush()
    .catch(() => {})
  return spans
}

const everything = (all: readonly ReadableSpan[]) => JSON.stringify(all.map(({ name, attributes, events, status }) =>
  ({ name, attributes, events, status })))
const generalTarget = () => ({
  profile: 'general' as const, jsonOutput: 'native' as const, temperatureSupported: true,
  automaticOutputKey: `trace-${Math.random()}`,
  model: createOpenAICompatible({ name: 'trace-audit', baseURL, apiKey: SECRET }).chatModel('audit'),
})

it('traces a logical call, its fallback, each provider request, the model and its tokens; nothing else by default', async () => {
  const all = await traced(() => generateSchemaWithModel(CALLER, input, generalTarget()))

  const logical = all.find((span) => span.name === 'schema-suggestion')!
  expect(logical.status.code).not.toBe(2)
  const inCall = all.filter((span) => span.spanContext().traceId === logical.spanContext().traceId)
  const chats = inCall.filter((span) => span.name === 'chat audit')
  expect(chats.map((span) => span.status.code)).toEqual([2, 0]) // the refused structured call, then prompt-only
  expect(chats[1].attributes).toMatchObject({ 'gen_ai.request.model': 'audit', 'gen_ai.usage.input_tokens': 11,
    'gen_ai.usage.output_tokens': 7 })
  const requests = inCall.filter((span) => span.attributes['http.request.method'] === 'POST')
  expect(requests.map((span) => span.attributes['http.response.status_code'])).toEqual([400, 200])
  // Credentials never; prompts, raw responses and parsed outputs only when asked.
  expect(everything(all)).not.toContain(SECRET)
  expect(everything(all)).not.toContain('Grounded source text')
  expect(everything(all)).not.toContain('One catalogue entry')
})

it('records prompts, raw responses and parsed outputs when FREE_TRACE_CAPTURE lists them', async () => {
  vi.stubEnv('FREE_TRACE_CAPTURE', 'prompts,responses,parsed')
  const all = await traced(() => generateSchemaWithModel(CALLER, input, generalTarget()))

  const chat = all.filter((span) => span.name === 'chat audit').at(-1)!
  expect(String(chat.attributes['gen_ai.input.messages'])).toContain('Grounded source text')
  expect(String(chat.attributes['gen_ai.output.messages'])).toContain('One catalogue entry')
  expect(JSON.parse(String(all.find((span) => span.name === 'schema-suggestion')!.attributes['output.value'])))
    .toEqual({ _description: 'One catalogue entry', title: 'string' })
  expect(everything(all)).not.toContain(SECRET)
})

it('traces a NuExtract chat completion like the AI SDK does, without its key', async () => {
  const all = await traced(() => executeSchemaSuggestion({
    profile: 'nuextract', modelId: 'numind/NuExtract3', baseUrl: baseURL, key: async () => SECRET,
    temperatureSupported: true,
  }, { instructions: '', guidance: 'Guidance', documentParts: [{ type: 'text', text: 'Grounded source text' }] }))

  const chat = all.find((span) => span.name === 'chat numind/NuExtract3')!
  expect(chat.attributes).toMatchObject({ 'openinference.span.kind': 'LLM', 'llm.model_name': 'numind/NuExtract3',
    'llm.token_count.prompt': 11, 'llm.token_count.completion': 7 })
  expect(all.find((span) => span.parentSpanContext?.spanId === chat.spanContext().spanId)!
    .attributes['http.response.status_code']).toBe(200)
  expect(everything(all)).not.toContain(SECRET)
  expect(everything(all)).not.toContain('Grounded source text')
})
