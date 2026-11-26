import { describe, expect, it } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import { proposeCorrectionsOnRoute, type CorrectableValue, type CorrectionRequest } from './_result_correction.js'
import { providerTable, type GeneralExecutionTarget } from './_provider.js'
import type { ModelConnection } from '../shared/modelConfig.contract.js'
import type { ResultCorrectionProposal } from '../shared/resultCorrection.contract.js'

/**
 * The evaluation of what a message about the results comes to (ADR 0043): labelled messages on one small result, each
 * routed from the facts a live model reports to changes of values, a new run, a template change, or a question back.
 * It prints every misrouted message and fails below FREE_RESULT_ROUTE_MIN_ACCURACY (default 0.8). Add a case for every
 * misroute found in use before changing the prompt.
 */
const LIVE =
  process.env.FREE_LIVE_MODEL_E2E === '1' ||
  process.env.npm_lifecycle_event === 'test:live-model'
const TIMEOUT_MS = 20 * 60 * 1_000
const LIVE_VLLM_URL = process.env.FREE_LIVE_VLLM_URL ?? 'http://127.0.0.1:8002/v1'
const LIVE_VLLM_MODEL = process.env.FREE_LIVE_VLLM_MODEL ?? 'Qwen/Qwen3.8-27B-FP8'
const MIN_ACCURACY = Number(process.env.FREE_RESULT_ROUTE_MIN_ACCURACY ?? '0.8')

const connection: ModelConnection = { id: '22222222-2222-4222-8222-222222222224', name: 'Live vLLM', provider: 'vllm', baseUrl: LIVE_VLLM_URL, hasKey: false }
const target = (): GeneralExecutionTarget => ({
  profile: 'general',
  model: providerTable.vllm.createModel(connection, LIVE_VLLM_MODEL, null),
  jsonOutput: 'schema',
  temperatureSupported: providerTable.vllm.temperatureSupported,
})

// A burial register of four entries; the results read three of them, one name wrongly and one sex not at all.
const MARKDOWN = `# Burial register of Ribe, 1850s

| No. | Name | Sex | Year of burial | Age |
|---|---|---|---|---|
| 1 | Maren Sørensdatter | female | 1851 | 64 |
| 2 | Niels Pedersen | male | 1852 | 3 |
| 3 | Anne Hansen | female | 1854 | 41 |
| 4 | Jens Christensen | male | 1855 | 72 |

The ages are given in years as the register writes them.`
const NAME: SchemaNode = { id: 'f-name', name: 'name', type: 'string', description: 'The buried person\'s full name' }
const SEX: SchemaNode = { id: 'f-sex', name: 'sex', type: 'string', allowedValues: ['female', 'male'] }
const YEAR: SchemaNode = { id: 'f-year', name: 'year', type: 'integer', description: 'Year of burial' }
const value = (record: number, node: SchemaNode, modelValue: unknown, absent = false) => ({
  id: `val-${node.name}-${record}`, recordId: `r-${record}`, fieldId: node.id, path: ['records', record, node.name], node, modelValue,
  selectionId: '51000000-0000-4000-8005-000000000001', schemaRevisionId: '51000000-0000-4000-8004-000000000001',
  evidence: [], grounding: 'grounded', processing: absent ? 'absent' : 'saved', lineage: [], links: [],
  correction: null, historicalCorrection: null, correctionCompatibility: 'compatible',
}) as unknown as CorrectableValue
const RESULT = {
  extractionId: '51000000-0000-4000-8006-000000000001', snapshotVersion: 1, markdown: MARKDOWN,
  values: [
    value(0, NAME, 'Maren Sørensdatter'), value(0, SEX, null, true), value(0, YEAR, 1851),
    value(1, NAME, 'Niels Petersen'), value(1, SEX, 'male'), value(1, YEAR, 1852),
    value(2, NAME, 'Anne Hansen'), value(2, SEX, 'female'), value(2, YEAR, 1845),
  ],
}

type Route = 'value' | 'rerun' | 'template' | 'ask'
const routes = (proposal: ResultCorrectionProposal): Route[] => {
  const found: Route[] = []
  if (proposal.corrections.length) found.push('value')
  if (proposal.rerun) found.push('rerun')
  if (proposal.templateChange) found.push('template')
  return found.length ? found : ['ask']
}
type Case = CorrectionRequest & { expected: Route[] }
const say = (message: string, expected: Route[], more: Partial<Case> = {}): Case => ({ message, history: [], expected, ...more })

const CASES: readonly Case[] = [
  // The value is given: changed.
  say('The year of record 3 should be 1854, not 1845', ['value']),
  say('第三条的年份应该是1854', ['value']),
  say('record 2 is Niels Pedersen', ['value']),
  say('删掉第二条的性别', ['value']),
  // Said to be wrong or missing, with the right value in the source: read from it.
  say('the name of record 2 is spelled wrong', ['value']),
  say('record 1 has no sex, fill it in', ['value']),
  say('第三条的年份不对', ['value']),
  // The template holds it, but the results have no value for it: run again.
  say('record 4 is missing', ['rerun']),
  say('漏了第四条', ['rerun']),
  say('Jens Christensen is not in the results', ['rerun']),
  // The template is wrong for it: changed.
  say('add the age of each person', ['template']),
  say('加一个年龄字段', ['template']),
  say('the year of record 3 is "ca. 1854"', ['template']),
  say('the years should be the year of death, not of burial, for every record', ['template'], { view: 'template' }),
  say('sex should also allow "unknown"', ['template']),
  // Several at once, each on its own; no run beside a template change.
  say('record 3 is 1854, and add the age', ['value', 'template']),
  say('record 2 is Niels Pedersen, and record 4 is missing', ['value', 'rerun']),
  // Unclear: asked back.
  say('fix it', ['ask']),
  say('this is wrong', ['ask']),
]

describe.skipIf(!LIVE)('what a message about the results comes to, on a live model', () => {
  it('routes each message as labelled', { timeout: TIMEOUT_MS }, async () => {
    const results = []
    for (const { expected, ...request } of CASES) {
      const got = await proposeCorrectionsOnRoute(target(), RESULT, request, { temperature: 0.2 })
        .then(routes, (error: unknown) => [`error: ${error instanceof Error ? error.message : String(error)}`])
      const right = got.length === expected.length && expected.every((route) => got.includes(route))
      results.push({ view: request.view ?? '', message: request.message, expected: expected.join('+'), got: got.join('+'), right })
    }
    const misses = results.filter(({ right }) => !right)
    console.log(`${results.length - misses.length} of ${results.length} routed as labelled`)
    if (misses.length) console.table(misses)
    expect(1 - misses.length / results.length).toBeGreaterThanOrEqual(MIN_ACCURACY)
  })
})
