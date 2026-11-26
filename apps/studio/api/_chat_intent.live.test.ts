import { describe, expect, it } from 'vitest'
import { classifyChatMessage, type ChatIntent, type ChatMessageToClassify } from './_chat_intent.js'
import { providerTable, type GeneralExecutionTarget } from './_provider.js'
import type { ModelConnection } from '../shared/modelConfig.contract.js'

/**
 * The chat's intent evaluation (ADR 0034, 0043): labelled messages, some beside what the chat offered, classified by a live
 * model. It prints every misread message and fails below FREE_CHAT_INTENT_MIN_ACCURACY (default 0.8). Add a case for
 * every misread found in use before changing the prompt.
 */
const LIVE =
  process.env.FREE_LIVE_MODEL_E2E === '1' ||
  process.env.npm_lifecycle_event === 'test:live-model'
const TIMEOUT_MS = 20 * 60 * 1_000
const LIVE_VLLM_URL = process.env.FREE_LIVE_VLLM_URL ?? 'http://127.0.0.1:8002/v1'
const LIVE_VLLM_MODEL = process.env.FREE_LIVE_VLLM_MODEL ?? 'Qwen/Qwen3.8-27B-FP8'
const MIN_ACCURACY = Number(process.env.FREE_CHAT_INTENT_MIN_ACCURACY ?? '0.8')

const connection: ModelConnection = { id: '22222222-2222-4222-8222-222222222223', name: 'Live vLLM', provider: 'vllm', baseUrl: LIVE_VLLM_URL, hasKey: false }
const target = (): GeneralExecutionTarget => ({
  profile: 'general',
  model: providerTable.vllm.createModel(connection, LIVE_VLLM_MODEL, null),
  jsonOutput: 'schema',
  temperatureSupported: providerTable.vllm.temperatureSupported,
})

const GENERATE = 'Generate template: Suggest a template from register.pdf?'
const RUN = 'Run extraction: Run the extraction on register.pdf?'
const TEMPLATE_READY = 'Template ready: Look at the template before going on?'
const PILOT = 'Try template on a few documents: Check the results on a few before extracting all 12 documents?'
const APPROVE = 'Approve template: Every trial document is reviewed. Approve the template for the whole project?'
const RESULTS_READY = 'Results ready: Look at the results of register.pdf before going on?'

type Case = ChatMessageToClassify & { expected: ChatIntent; focus?: RegExp }
const say = (message: string, expected: ChatIntent, more: Partial<Case> = {}): Case => ({ message, history: [], expected, ...more })

const CASES: readonly Case[] = [
  say('How many graves are listed?', 'question'),
  say('这份文档里有几个墓？', 'question'),
  say('What does the orientation field hold?', 'question', { offer: RUN }),
  say('and the other one?', 'question', { history: [{ role: 'user', text: 'How long is grave 8?' }, { role: 'assistant', text: '1.72 metres.' }] }),
  say('give me a template of this doc', 'generate'),
  say('give me a template of this doc', 'generate', { offer: RUN }),
  say('给我一个模板', 'generate'),
  say('suggest a template focusing on dates', 'generate', { focus: /dates/i }),
  say('Regenerate the template with fewer fields', 'generate', { focus: /fewer/i }),
  say('start over with a new template', 'generate'),
  say('Focus on graves and their measurements', 'edit'),
  say('Add a field for grave goods', 'edit'),
  say('把 length_m 改成整数', 'edit'),
  say('yes, but first add a burial date field', 'edit', { offer: RUN }),
  say('Add a site name field, then run it', 'edit'),
  say('remove the notes field', 'edit'),
  say('rename author to writer', 'edit', { where: { view: 'template', results: true } }),
  // Anything said about what was extracted is "correct" (ADR 0043), however general: its next step decides.
  say('Years should always be written with four digits', 'correct', { offer: RESULTS_READY }),
  say('日期都读成了日月年，应该只要年份', 'correct', { where: { view: 'results', results: true } }),
  say('the dates should only be years', 'correct', { where: { view: 'template', results: true } }),
  say('the date is wrong', 'correct', { where: { view: 'template', results: true } }),
  say('record 12 is missing', 'correct', { where: { view: 'results', results: true } }),
  say('作者漏了', 'correct', { where: { view: 'results', results: true } }),
  say('there are two records for grave 8, one is a duplicate', 'correct', { where: { view: 'results', results: true } }),
  say('The year of record 3 should be 1854, not 1845', 'correct'),
  say('grave 8 is 1.80 m long', 'correct', { offer: RESULTS_READY }),
  say('第二条记录的名字错了，应该是 Anne Hansen', 'correct'),
  say('删掉第五条的性别', 'correct'),
  say('that title is wrong, fix it', 'correct', { offer: RESULTS_READY }),
  say('Run the extraction', 'extract'),
  say('generate the results', 'extract'),
  say('帮我把所有文档都提取一下', 'extract'),
  say('跑一下', 'extract'),
  say('extract every document', 'extract', { offer: PILOT }),
  say('yes', 'confirm', { offer: RUN }),
  say('好的，跑吧', 'confirm', { offer: RUN }),
  say('go ahead', 'confirm', { offer: GENERATE }),
  say('looks good, continue', 'confirm', { offer: TEMPLATE_READY }),
  say('ok', 'confirm', { offer: PILOT }),
  say('批准', 'confirm', { offer: APPROVE }),
  say('no', 'none', { offer: GENERATE }),
  say('not now', 'none', { offer: RUN }),
  say('no thanks', 'none'),
  say('算了', 'none', { offer: APPROVE }),
]

describe.skipIf(!LIVE)('the chat\'s intent on a live model', () => {
  it('reads each message as labelled', { timeout: TIMEOUT_MS }, async () => {
    const results = []
    for (const { expected, focus, ...message } of CASES) {
      const got = await classifyChatMessage(target(), message, { temperature: 0.2 }).catch((error: unknown) =>
        ({ intent: `error: ${error instanceof Error ? error.message : String(error)}`, focus: null }))
      const right = got.intent === expected && (!focus || focus.test(got.focus ?? ''))
      results.push({ offer: message.offer ?? '', message: message.message, expected, got: got.intent, focus: got.focus, right })
    }
    const misses = results.filter(({ right }) => !right)
    console.log(`${results.length - misses.length} of ${results.length} read as labelled`)
    if (misses.length) console.table(misses)
    expect(1 - misses.length / results.length).toBeGreaterThanOrEqual(MIN_ACCURACY)
  })
})
