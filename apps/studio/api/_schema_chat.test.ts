import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerSchemaChat, combineWindowAnswers, respondToSchemaEdit } from './_schema_chat.js'
import { answerOf } from './_schema_suggestion.js'
import { createModelKeyCache } from './_model_keys.js'
import type { ModelConfig } from '../shared/modelConfig.contract.js'

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }))
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { get stepStatus() { return undefined } } }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: generateTextMock }
})

const CALLER = { researcherAccountId: '51000000-0000-4000-8009-00000000000a' }
const GATEWAY = '51000000-0000-4000-8009-0000000000c1'
const VLLM = '51000000-0000-4000-8009-0000000000c2'
const model = { specificationVersion: 'v4', provider: 'test-provider', modelId: 'test-model', supportedUrls: {}, doGenerate: vi.fn(), doStream: vi.fn() }

function dependencies(routes: ModelConfig['routes']) {
  const config = {
    connections: [
      { id: GATEWAY, name: 'Gateway', provider: 'openai-compatible' as const, baseUrl: 'https://gateway.example/v1', hasKey: false },
      { id: VLLM, name: 'vLLM', provider: 'vllm' as const, baseUrl: 'http://nuextract_model:8000/v1', hasKey: false },
    ],
    routes,
    extractionModels: {},
    ingestionModels: {},
    extractionSettings: {},
  } as unknown as ModelConfig
  return {
    readConfig: async () => config,
    deployment: { connections: [], defaultRoute: null },
    keys: createModelKeyCache(),
    modelFactories: { 'openai-compatible': () => model as never, vllm: () => model as never },
  }
}
const general = dependencies({ schemaSuggestion: null, interaction: { connectionId: GATEWAY, modelId: 'assistant' } })
const nuextract = dependencies({
  schemaSuggestion: { connectionId: VLLM, modelId: 'numind/NuExtract3-FP8' },
  interaction: { connectionId: GATEWAY, modelId: 'assistant' },
})
const nuextractAlone = dependencies({ schemaSuggestion: { connectionId: VLLM, modelId: 'numind/NuExtract3-FP8' }, interaction: null })

const input = { document: { file: null, pages: null, markdown: '# Register\n\n42 burials.' }, instruction: 'Revise the schema…' }
const question = { message: 'How many burials are there?', context: 'The researcher\'s current extraction schema:\n{}', history: [] }
const sent = (call: number) => JSON.stringify(generateTextMock.mock.calls[call]![0])

function stubNuExtract(content: string) {
  const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', request)
  return request
}

afterEach(() => {
  vi.unstubAllGlobals()
  generateTextMock.mockReset()
})

describe('answerOf', () => {
  it('reads exactly {"answer": "<text>"}, and nothing else', async () => {
    await expect(answerOf('{"answer":" 42 burials. "}')).resolves.toBe('42 burials.')
    await expect(answerOf('```json\n{"answer":"42"}\n```')).resolves.toBe('42')
    await expect(answerOf('{"answer":null}')).resolves.toBeNull()
    await expect(answerOf('{"answer":""}')).resolves.toBeNull()
    await expect(answerOf('{"answer":"x","_description":"One entry."}')).resolves.toBeNull()
    await expect(answerOf('{"_description":"One entry.","answer":"string"}')).resolves.toBeNull()
    await expect(answerOf('not json')).resolves.toBeNull()
  })
})

/** The model's replies, in order: the message's intent first, then what it asks for. */
const replies = (...texts: string[]) => { for (const text of texts) generateTextMock.mockResolvedValueOnce({ text, finishReason: 'stop' }) }
const intent = (name: string, focus: string | null = null) => JSON.stringify({ intent: name, focus })

describe('respondToSchemaEdit', () => {
  it('on a general route reads the message first, then revises the schema with its scalar note edits', async () => {
    const fieldDescriptions = [{ path: ['name'], description: 'Copy the complete name.' }]
    replies(intent('edit'), JSON.stringify({ template: { _description: 'One burial.', name: 'string' }, fieldDescriptions }))
    await expect(respondToSchemaEdit(CALLER, { ...input, edit: true }, { ...question, message: 'Copy the complete name' }, general))
      .resolves.toMatchObject({ template: { _description: 'One burial.', name: 'string' }, fieldDescriptions })
    expect(generateTextMock).toHaveBeenCalledTimes(2)
    expect(sent(0)).toContain('Return only {\\"intent\\":\\"<intent>\\"')
    expect(sent(0)).toContain('Copy the complete name')
    // The change request itself asks for a schema and nothing else.
    expect(sent(1)).toContain('array of exact field names')
    expect(sent(1)).not.toContain('{\\"answer\\"')
  })

  it('on a general route answers a question in its own request, from the source', async () => {
    replies(intent('question'), '{"answer":"42 burials."}')
    await expect(respondToSchemaEdit(CALLER, input, question, general)).resolves.toEqual({ answer: '42 burials.' })
    expect(sent(1)).toContain('How many burials are there?')
    expect(sent(1)).toContain('{\\"answer\\":\\"<your answer>\\"}')
    expect(sent(1)).toContain('42 burials.')
  })

  it('beside NuExtract the Assistant model reads and answers, and NuExtract revises the schema otherwise', async () => {
    const untouched = stubNuExtract('{}')
    replies(intent('question'), '{"answer":"42 burials."}')
    await expect(respondToSchemaEdit(CALLER, input, question, nuextract)).resolves.toEqual({ answer: '42 burials.' })
    expect(untouched).not.toHaveBeenCalled()
    expect(sent(1)).toContain('The researcher\'s current extraction schema')

    const request = stubNuExtract('{"_description":"One burial.","name":"string"}')
    replies(intent('edit'))
    await expect(respondToSchemaEdit(CALLER, input, { ...question, message: 'Add a name field' }, nuextract))
      .resolves.toMatchObject({ template: { _description: 'One burial.', name: 'string' } })
    expect(request).toHaveBeenCalledOnce()
    expect(JSON.parse(request.mock.calls[0]![1].body).chat_template_kwargs.mode).toBe('template-generation')
  })

  it.each([
    ['extract', null, { action: 'extract', focus: null }],
    ['generate', 'dates', { action: 'generate', focus: 'dates' }],
    ['confirm', null, { action: 'confirm', focus: null }],
    ['none', null, { action: 'none' }],
  ] as const)('hands a message asking for %s back to Studio, with no other request', async (name, focus, expected) => {
    const untouched = stubNuExtract('{}')
    replies(intent(name, focus))
    await expect(respondToSchemaEdit(CALLER, input, { ...question, message: 'go', offer: 'Run extraction: Run it?' }, general)).resolves.toEqual(expected)
    replies(intent(name, focus))
    await expect(respondToSchemaEdit(CALLER, input, { ...question, message: 'go' }, nuextract)).resolves.toEqual(expected)
    expect(generateTextMock).toHaveBeenCalledTimes(2)
    expect(untouched).not.toHaveBeenCalled()
    expect(sent(0)).toContain('Studio has just offered: Run extraction: Run it?')
  })

  it('hands what is said about the results back to Studio where a result is shown, and changes the template where none is (ADR 0043)', async () => {
    replies(intent('correct'))
    await expect(respondToSchemaEdit(CALLER, input, { ...question, message: 'the dates should only be years', where: { view: 'results', results: true } }, general))
      .resolves.toEqual({ action: 'correct', focus: null })
    replies(intent('correct'), JSON.stringify({ template: { _description: 'One burial.', year: 'integer' } }))
    await expect(respondToSchemaEdit(CALLER, input, { ...question, message: 'the dates should only be years', where: { view: 'template', results: false } }, general))
      .resolves.toMatchObject({ template: { year: 'integer' } })
  })

  it('reads a reply that names no intent as a change, as every message was before', async () => {
    replies('Sure, here is a schema.', '{"_description":"One burial.","name":"string"}')
    await expect(respondToSchemaEdit(CALLER, input, { ...question, message: 'Add a name field' }, general))
      .resolves.toMatchObject({ template: { name: 'string' } })
  })

  it('keeps NuExtract selected for scalar note edits, in the same template-generation call', async () => {
    const fieldDescriptions = [{ path: ['name'], description: 'Copy the complete name.' }]
    const request = stubNuExtract(JSON.stringify({ template: { _description: 'One burial.', name: 'string' }, fieldDescriptions }))
    await expect(respondToSchemaEdit(CALLER, { ...input, edit: true }, question, nuextractAlone))
      .resolves.toMatchObject({ template: { _description: 'One burial.', name: 'string' }, fieldDescriptions })
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
    const body = JSON.parse(request.mock.calls[0]![1].body)
    expect(body.chat_template_kwargs.mode).toBe('template-generation')
    expect(body.messages[0].content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('fieldDescriptions') })
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: input.document.markdown })
  })

  it('keeps an explicit scalar note clear in NuExtract\'s single response', async () => {
    const fieldDescriptions = [{ path: ['name'], clear: true }]
    const request = stubNuExtract(JSON.stringify({ template: { _description: 'One burial.', name: 'string' }, fieldDescriptions }))
    await expect(respondToSchemaEdit(CALLER, { ...input, edit: true }, { ...question, message: 'Clear the name note' }, nuextractAlone))
      .resolves.toMatchObject({ template: { _description: 'One burial.', name: 'string' }, fieldDescriptions })
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
    expect(JSON.parse(request.mock.calls[0]![1].body).messages[0].content[0].text).toContain('"clear": true')
  })

  it('NuExtract with no Assistant model beside it revises the schema, as before', async () => {
    const request = stubNuExtract('{"_description":"One burial.","name":"string"}')
    await expect(respondToSchemaEdit(CALLER, input, question, nuextractAlone)).resolves.toMatchObject({ template: { name: 'string' } })
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })
})

describe('answerSchemaChat', () => {
  it('answers a question, or gives null for an instruction', async () => {
    replies(intent('question'), '{"answer":"42 burials."}')
    await expect(answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'How many burials?', history: [] }, {}, nuextract)).resolves.toBe('42 burials.')
    replies(intent('edit'))
    await expect(answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'Focus on dates', history: [] }, {}, general)).resolves.toBeNull()
    expect(generateTextMock).toHaveBeenCalledTimes(3)
  })

  it('hands a request back to Studio: a template asked for with what it should hold, a run, a yes or a no', async () => {
    replies(intent('generate', 'the dates'))
    await expect(answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'give me a template of the dates', history: [] }, {}, general))
      .resolves.toEqual({ action: 'generate', focus: 'the dates' })
    replies(intent('extract'))
    await expect(answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'Extract it', history: [] }, {}, general))
      .resolves.toEqual({ action: 'extract', focus: null })
    replies(intent('none'))
    await expect(answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'no thanks', history: [] }, {}, general)).resolves.toEqual({ action: 'none' })
    expect(generateTextMock).toHaveBeenCalledTimes(3)
  })

  it('keeps every message as an instruction when nothing can answer it', async () => {
    await expect(answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'How many burials?', history: [] }, {}, nuextractAlone)).resolves.toBeNull()
    expect(generateTextMock).not.toHaveBeenCalled()
  })
})

describe('the conversation', () => {
  it('goes before the latest message in the classification and in the answer', async () => {
    replies(intent('question'), '{"answer":"Grave 7."}')
    const history = [{ role: 'user' as const, text: 'Which grave is oldest?' }, { role: 'assistant' as const, text: 'Grave 7.' }]
    await answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'Where is it?', history }, {}, general)
    for (const call of [0, 1])
      expect(sent(call)).toContain('Researcher: Which grave is oldest?\\nAssistant: Grave 7.\\n\\nThe researcher\'s latest chat message:\\nWhere is it?')
  })
})

describe('combineWindowAnswers', () => {
  it('sends the parts in order and fails on a reply with no answer', async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"answer":"42 burials in all."}', finishReason: 'stop' })
    await expect(combineWindowAnswers(CALLER, ['40 burials', ''], question, {}, general)).resolves.toBe('42 burials in all.')
    expect(sent(0)).toContain('PART 1:\\n40 burials\\n\\nPART 2:\\n(nothing relevant)')

    generateTextMock.mockResolvedValueOnce({ text: '{"answer":null}', finishReason: 'stop' })
    await expect(combineWindowAnswers(CALLER, ['40 burials'], question, {}, general)).rejects.toMatchObject({ code: 'invalid_model_output' })
  })
})
