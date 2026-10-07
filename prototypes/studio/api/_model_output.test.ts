import { describe, expect, it } from 'vitest'
import { parseTemplate } from './_model_output'

const INVALID = { status: 502, code: 'invalid_model_output' }

describe('parseTemplate', () => {
  it('keeps literal fences and tags anywhere inside valid values', async () => {
    const template = {
      _description: '<think>a</think> then ```json``` and </think> again',
      note: '```',
    }

    await expect(parseTemplate(JSON.stringify(template))).resolves.toEqual(template)
  })

  it('reads JSON after a leading reasoning block', async () => {
    const text = '<think>\nThe document lists graves.\n</think>\n\n{"_description":"One grave.","grave":"string"}'

    await expect(parseTemplate(text)).resolves.toEqual({ _description: 'One grave.', grave: 'string' })
  })

  it('reads a fenced JSON reply, with or without a leading reasoning block', async () => {
    const fenced = '```json\n{"_description":"One grave.","grave":"string"}\n```'

    await expect(parseTemplate(fenced)).resolves.toEqual({ _description: 'One grave.', grave: 'string' })
    await expect(parseTemplate(`<think>plan</think>\n${fenced}`))
      .resolves.toEqual({ _description: 'One grave.', grave: 'string' })
  })

  it('keeps a literal tag inside a value after stripping the leading reasoning block', async () => {
    const text = '<think>plan</think>{"_description":"Uses <think>x</think> verbatim."}'

    await expect(parseTemplate(text)).resolves.toEqual({ _description: 'Uses <think>x</think> verbatim.' })
  })

  it('repairs syntax after outer framing without stripping literal tags from values', async () => {
    const text = '<think>plan</think>\n```json\n{"_description":"Uses <think>x</think> and ``` verbatim.",}\n```'

    await expect(parseTemplate(text)).resolves.toEqual({ _description: 'Uses <think>x</think> and ``` verbatim.' })
  })

  it.each(['{"a":1:2}', 'not json'])('rejects an unrecoverable or non-object reply: %s', async (text) => {
    await expect(parseTemplate(text)).rejects.toMatchObject(INVALID)
  })
})
