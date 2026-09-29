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

  it.each([
    ['a truncated description', '{"_description":"Graves from the cem'],
    ['mismatched closing brackets', '{"_description":"One grave record.","grave":[{"name":"verbatim-string"}}]'],
    ['an elided array', '{"_description":"One grave.","ids":[1,2,...]}'],
    ['concatenated strings', '{"_description":"One" + " grave."}'],
    ['a missing comma', '{"_description":"One grave." "grave":"string"}'],
    ['prose around the JSON', 'Here is the schema: {"_description":"One grave."}'],
    ['an unclosed reasoning block', '<think>still thinking {"_description":"One grave."}'],
    ['a reasoning block that is not leading', '{"_description":"One grave."}<think>after</think>'],
    ['two JSON documents', '{"_description":"One grave."}\n{"_description":"Another."}'],
  ])('rejects %s visibly', async (_, text) => {
    await expect(parseTemplate(text)).rejects.toMatchObject(INVALID)
  })
})
