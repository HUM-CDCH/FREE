import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { trace, type ProxyTracerProvider } from '@opentelemetry/api'
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { generateSchemaWithModel } from '../api/_schema_suggestion.js'
import { startTracing } from './tracing.js'

const SECRET = 'sk-trace-export-audit-0123456789'
const PRIVATE = 'PRIVATE PROVIDER RESPONSE'
const exported: Buffer[] = []
let server: Server
let baseURL: string

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (request.url === '/v1/traces') {
        exported.push(Buffer.concat(chunks))
        response.end()
        return
      }
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: {
        message: `${PRIVATE}: Invalid API key ${request.headers.authorization}`,
        type: 'authentication_error',
      } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', `${baseURL}/v1/traces`)
  vi.stubEnv('FREE_TRACE_CAPTURE', 'prompts,responses,parsed')
  expect(await startTracing()).toBe(true)
})

afterAll(async () => {
  await ((trace.getTracerProvider() as ProxyTracerProvider).getDelegate() as NodeTracerProvider).shutdown()
  vi.unstubAllEnvs()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

it('exports valid OTLP with opted-in input and error types, without echoed credentials or refusal bodies', async () => {
  await expect(generateSchemaWithModel({ researcherAccountId: 'trace-audit' }, {
    document: { file: null, markdown: 'Grounded source text', pages: null }, instruction: '',
  }, {
    profile: 'general', jsonOutput: 'native', temperatureSupported: true,
    model: createOpenAICompatible({ name: 'trace-export-audit', baseURL: `${baseURL}/v1`, apiKey: SECRET }).chatModel('audit'),
  })).rejects.toThrow('The model operation failed.')

  await ((trace.getTracerProvider() as ProxyTracerProvider).getDelegate() as NodeTracerProvider).forceFlush()
  expect(exported).toHaveLength(1)
  const payload = Buffer.concat(exported)
  expect(payload.includes(Buffer.from('Grounded source text'))).toBe(true)
  expect(payload.includes(Buffer.from('AI_APICallError'))).toBe(true)
  expect(payload.includes(Buffer.from('schema-suggestion'))).toBe(true)
  expect(payload.includes(Buffer.from(SECRET))).toBe(false)
  expect(payload.includes(Buffer.from(PRIVATE))).toBe(false)
})
