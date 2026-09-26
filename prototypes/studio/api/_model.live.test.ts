import { describe, expect, it } from 'vitest'
import { generateSchemaWithModel } from './_model.js'
import {
  providerTable,
  probeConnection,
  type GeneralExecutionTarget,
  type NuExtractExecutionTarget,
} from './_provider.js'
import type { ModelConnection } from '../shared/modelConfig.contract.js'

const LIVE =
  process.env.FREE_LIVE_MODEL_E2E === '1' ||
  process.env.npm_lifecycle_event === 'test:live-model'
const TIMEOUT_MS = 12 * 60 * 1_000
// Every call names its caller; the targets below are explicit, so no configuration is read.
const CALLER = { researcherAccountId: '22222222-2222-4222-8222-2222222222a1' }
const LIVE_VLLM_URL = process.env.FREE_LIVE_VLLM_URL ?? 'http://127.0.0.1:8002/v1'
const LIVE_VLLM_MODEL = process.env.FREE_LIVE_VLLM_MODEL ?? 'Qwen/Qwen3.8-27B-FP8'
const LIVE_NUEXTRACT_URL = process.env.FREE_LIVE_NUEXTRACT_URL
const LIVE_NUEXTRACT_MODEL = process.env.FREE_LIVE_NUEXTRACT_MODEL ?? 'numind/NuExtract3-FP8'

const liveConnection: ModelConnection = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Live vLLM',
  provider: 'vllm',
  baseUrl: LIVE_VLLM_URL,
}

const register = {
  file: null,
  markdown:
    'Excavation register. Grave 8 is oriented east-west and measures 1.72 metres long. Grave 13 is oriented north-south and measures 1.64 metres long.',
  pages: 1,
}
const instruction = 'Create one record per grave with grave number, orientation, and length in metres.'

function liveVllmTarget(): GeneralExecutionTarget {
  return {
    profile: 'general',
    model: providerTable.vllm.createModel(liveConnection, LIVE_VLLM_MODEL, null),
    jsonOutput: 'schema',
    temperatureSupported: providerTable.vllm.temperatureSupported,
  }
}

describe.skipIf(!LIVE)('bounded live vLLM Schema Suggestion profile', () => {
  it('discovers the configured model through the real provider boundary', { timeout: TIMEOUT_MS }, async () => {
    const result = await probeConnection(liveConnection, null)
    expect(result.status).toBe('connected')
    expect(result.catalog).toContainEqual(expect.objectContaining({ id: LIVE_VLLM_MODEL }))
  })

  it('suggests a grounded schema on the instruction model', { timeout: TIMEOUT_MS }, async () => {
    const result = await generateSchemaWithModel(CALLER, { document: register, instruction, temperature: 0.2 }, liveVllmTarget())
    expect(result.pages).toBe(1)
    expect(result.template._description).toEqual(expect.any(String))
    expect(JSON.stringify(result.template)).toMatch(/grave/i)
  })

  it.skipIf(!LIVE_NUEXTRACT_URL)('suggests a grounded schema with NuExtract template generation', { timeout: TIMEOUT_MS }, async () => {
    const target: NuExtractExecutionTarget = {
      profile: 'nuextract',
      modelId: LIVE_NUEXTRACT_MODEL,
      baseUrl: LIVE_NUEXTRACT_URL!,
      authorization: null,
      temperatureSupported: true,
    }
    const result = await generateSchemaWithModel(CALLER, { document: register, instruction }, target)
    expect(result.template._description).toEqual(expect.any(String))
    expect(JSON.stringify(result.template)).toMatch(/grave/i)
  })
})
