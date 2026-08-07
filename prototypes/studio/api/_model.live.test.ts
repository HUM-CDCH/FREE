import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { extractWithModel } from './_model.js'
import { DELETE as clearLlmInspector, GET as getLlmInspector } from './llm_inspector.js'
import { providerTable, type GeneralExecutionTarget, type NuExtractRawExecutionTarget } from './_provider.js'
import type { LlmTrace } from '../shared/llmInspector.contract.js'

const EXPECTED_GRAVES = [8, 13, 24, 26, 28, 30, 31]
const LIVE = process.env.FREE_LIVE_MODEL_E2E === '1'
const TIMEOUT_MS = 12 * 60 * 1_000

const extractionSchema = {
  records: [{
    grave_number: 'integer',
    archive_sheets: ['integer'],
    photo_references: ['string'],
    excavation_background: 'verbatim-string',
    description: 'verbatim-string',
    orientation: 'string',
    dimensions: { length: 'number', width: 'number', depth: 'number' },
    skeleton: {
      preservation: 'verbatim-string',
      parts: [{ number: 'string', description: 'string', remarks: 'string' }],
      sex: ['mand', 'kvinde', 'ukendt'],
      age_min: 'integer',
      age_max: 'integer',
    },
    grave_goods: [{
      find_number: 'string',
      description: 'string',
      remarks: 'string',
      material: ['keramik', 'jern', 'bronze', 'sølv', 'glas', 'rav', 'flint', 'knogle', 'andet'],
    }],
    interpretation: ['string'],
    dating: 'string',
  }],
}

async function capturedDocument(): Promise<string> {
  const path = process.env.FREE_LIVE_MODEL_CAPTURE
  if (!path) throw new Error('FREE_LIVE_MODEL_CAPTURE must point to the authorized Codex capture.')
  const capture = (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')
  const trace = JSON.parse(capture.split('\n\nExtraction failed', 1)[0]) as {
    request?: { body?: string }
  }
  const body = trace.request?.body
  if (!body) throw new Error('The authorized capture has no provider request body.')
  const startMarker = 'SOURCE DOCUMENT:\n'
  const endMarker = '\nEND SOURCE DOCUMENT'
  const start = body.indexOf(startMarker)
  const end = body.lastIndexOf(endMarker)
  if (start < 0 || end <= start) throw new Error('The authorized capture has no Source Document section.')
  return body.slice(start + startMarker.length, end)
}

function records(value: unknown): Array<Record<string, unknown>> {
  const found = (value as { records?: unknown })?.records
  expect(found).toBeInstanceOf(Array)
  expect((found as unknown[]).every((record) =>
    typeof record === 'object' && record !== null && !Array.isArray(record),
  )).toBe(true)
  return found as Array<Record<string, unknown>>
}

function assertCompleteExtraction(result: Awaited<ReturnType<typeof extractWithModel>>): void {
  const resultRecords = records(result.result)
  expect(resultRecords).toHaveLength(7)
  expect(resultRecords.map(({ grave_number }) => grave_number)).toEqual(EXPECTED_GRAVES)
  expect(result).not.toHaveProperty('evidence')
  expect(() => JSON.parse(result.raw)).not.toThrow()
}

async function latestTrace(): Promise<LlmTrace> {
  const body = await getLlmInspector().json() as { traces: LlmTrace[] }
  expect(body.traces[0]).toBeDefined()
  return body.traces[0]
}

describe.skipIf(!LIVE)('live Extraction provider E2E', () => {
  it('extracts the seven graves with native Codex structured output', { timeout: TIMEOUT_MS }, async () => {
    clearLlmInspector()
    const codex = providerTable['codex-cli']
    const target: GeneralExecutionTarget = {
      profile: 'general',
      model: codex.createModel({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Live Codex CLI',
        provider: 'codex-cli',
        baseUrl: null,
      }, 'gpt-5.6-luna'),
      jsonOutput: codex.jsonOutput,
      temperatureSupported: codex.temperatureSupported,
    }
    const startedAt = Date.now()
    const result = await extractWithModel({
      document: { file: null, markdown: await capturedDocument(), pages: 7 },
      template: extractionSchema,
    }, target)
    const trace = await latestTrace()
    const response = JSON.parse(trace.response ?? '{}') as {
      finishReason?: { unified?: string }
      usage?: { outputTokens?: { total?: number } }
    }
    console.info(JSON.stringify({
      provider: 'codex-cli',
      model: 'gpt-5.6-luna',
      durationMs: Date.now() - startedAt,
      finishReason: response.finishReason?.unified,
      outputTokens: response.usage?.outputTokens?.total,
      outputCharacters: result.raw.length,
      recordIds: records(result.result).map(({ grave_number }) => grave_number),
    }))
    expect(trace).toMatchObject({ status: 'complete', model: 'gpt-5.6-luna' })
    expect(response.finishReason?.unified).toBe('stop')
    assertCompleteExtraction(result)
  })

  it('extracts the same seven graves with local Ollama NuExtract', { timeout: TIMEOUT_MS }, async () => {
    clearLlmInspector()
    const target: NuExtractRawExecutionTarget = {
      profile: 'nuextract-raw',
      modelId: process.env.FREE_LIVE_OLLAMA_MODEL ?? 'hf.co/numind/NuExtract3-GGUF:Q4_K_M',
      baseUrl: process.env.FREE_LIVE_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      authorization: null,
      temperatureSupported: true,
    }
    const startedAt = Date.now()
    const result = await extractWithModel({
      document: { file: null, markdown: await capturedDocument(), pages: 7 },
      template: extractionSchema,
    }, target)
    const trace = await latestTrace()
    const response = JSON.parse(trace.response ?? '{}') as {
      body?: { done_reason?: string; eval_count?: number }
    }
    console.info(JSON.stringify({
      provider: 'ollama',
      model: target.modelId,
      durationMs: Date.now() - startedAt,
      finishReason: response.body?.done_reason,
      outputTokens: response.body?.eval_count,
      outputCharacters: result.raw.length,
      recordIds: records(result.result).map(({ grave_number }) => grave_number),
    }))
    expect(trace).toMatchObject({ status: 'complete', provider: 'ollama', model: target.modelId })
    expect(response.body?.done_reason).toBe('stop')
    assertCompleteExtraction(result)
  })
})
