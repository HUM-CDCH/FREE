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

describe('respondToSchemaEdit', () => {
  it('keeps scalar note edits in the general route\'s single response and still answers questions', async () => {
    const fieldDescriptions = [{ path: ['name'], description: 'Copy the complete name.' }]
    generateTextMock.mockResolvedValueOnce({ text: JSON.stringify({
      template: { _description: 'One burial.', name: 'string' }, fieldDescriptions,
    }), finishReason: 'stop' })
    await expect(respondToSchemaEdit(CALLER, { ...input, edit: true }, { ...question, message: 'Copy the complete name' }, general))
      .resolves.toMatchObject({ template: { _description: 'One burial.', name: 'string' }, fieldDescriptions })
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(sent(0)).toContain('fieldDescriptions')
    expect(sent(0)).toContain('array of exact field names')

    generateTextMock.mockResolvedValueOnce({ text: '{"answer":"The name field copies the name."}', finishReason: 'stop' })
    await expect(respondToSchemaEdit(CALLER, { ...input, edit: true }, question, general))
      .resolves.toEqual({ answer: 'The name field copies the name.' })
    expect(generateTextMock).toHaveBeenCalledTimes(2)
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

  it('on a general route one Schema Suggestion request answers a question or returns the schema', async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"answer":"42 burials."}', finishReason: 'stop' })
    await expect(respondToSchemaEdit(CALLER, input, question, general)).resolves.toEqual({ answer: '42 burials.' })
    expect(generateTextMock).toHaveBeenCalledOnce()
    expect(sent(0)).toContain('How many burials are there?')
    expect(sent(0)).toContain('{\\"answer\\":\\"<your answer>\\"}')

    generateTextMock.mockResolvedValueOnce({ text: '{"_description":"One burial.","name":"string"}', finishReason: 'stop' })
    await expect(respondToSchemaEdit(CALLER, input, { ...question, message: 'Add a name field' }, general))
      .resolves.toMatchObject({ template: { _description: 'One burial.', name: 'string' } })
  })

  it('on NuExtract the Assistant model answers a question, and NuExtract revises the schema otherwise', async () => {
    const untouched = stubNuExtract('{}')
    generateTextMock.mockResolvedValueOnce({ text: '{"answer":"42 burials."}', finishReason: 'stop' })
    await expect(respondToSchemaEdit(CALLER, input, question, nuextract)).resolves.toEqual({ answer: '42 burials.' })
    expect(untouched).not.toHaveBeenCalled()
    expect(sent(0)).toContain('The researcher\'s current extraction schema')

    const request = stubNuExtract('{"_description":"One burial.","name":"string"}')
    generateTextMock.mockResolvedValueOnce({ text: '{"answer":null}', finishReason: 'stop' })
    await expect(respondToSchemaEdit(CALLER, input, { ...question, message: 'Add a name field' }, nuextract))
      .resolves.toMatchObject({ template: { _description: 'One burial.', name: 'string' } })
    expect(request).toHaveBeenCalledOnce()
    expect(JSON.parse(request.mock.calls[0]![1].body).chat_template_kwargs.mode).toBe('template-generation')
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
    generateTextMock.mockResolvedValueOnce({ text: '{"answer":"42 burials."}', finishReason: 'stop' })
    await expect(answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'How many burials?', history: [] }, {}, nuextract)).resolves.toBe('42 burials.')
    generateTextMock.mockResolvedValueOnce({ text: '{"answer":null}', finishReason: 'stop' })
    await expect(answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'Focus on dates', history: [] }, {}, general)).resolves.toBeNull()
  })

  it('keeps every message as an instruction when nothing can answer it', async () => {
    await expect(answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'How many burials?', history: [] }, {}, nuextractAlone)).resolves.toBeNull()
    expect(generateTextMock).not.toHaveBeenCalled()
  })
})

describe('the conversation', () => {
  it('goes before the latest message in every question the model reads', async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"answer":"Grave 7."}', finishReason: 'stop' })
    const history = [{ role: 'user' as const, text: 'Which grave is oldest?' }, { role: 'assistant' as const, text: 'Grave 7.' }]
    await answerSchemaChat(CALLER, { markdown: '42 burials.' }, { message: 'Where is it?', history }, {}, general)
    expect(sent(0)).toContain('Researcher: Which grave is oldest?\\nAssistant: Grave 7.\\n\\nThe researcher\'s latest chat message:\\nWhere is it?')
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
