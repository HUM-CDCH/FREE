import { describe, expect, it, vi } from 'vitest'
import { reduceSchemas } from './_schema_reduction.js'
import { combineSchemas, type generateSchemaWithModel } from './_schema_suggestion.js'

type Schema = { fields: string[] }
const union = async (text: string): Promise<Schema> => ({
  fields: [...new Set([...text.matchAll(/"(f\d+)"/g)].map((match) => match[1]!))].sort(),
})

describe('reduceSchemas', () => {
  it('folds inputs over one request through several levels, every request within budget and every leaf read', async () => {
    const leaves = Array.from({ length: 12 }, (_, i) => ({ label: `WINDOW ${i + 1}`, schema: { fields: [`f${i}`] } }))
    const requests: Array<{ text: string; step: string }> = []

    const result = await reduceSchemas(leaves, async (text, step) => {
      requests.push({ text, step })
      return union(text)
    }, 150)

    expect(result.fields).toEqual(leaves.map((_, i) => `f${i}`).sort())
    expect(requests.every(({ text }) => text.length <= 150)).toBe(true)
    expect(new Set(requests.map(({ step }) => step)).size).toBe(requests.length)
    expect(requests.some(({ step }) => step.startsWith('reduce:2:'))).toBe(true)
    for (const leaf of leaves) expect(requests.some(({ text }) => text.includes(`${leaf.label} SCHEMA:`))).toBe(true)
  })

  it('returns a single input without a model call', async () => {
    const merge = vi.fn(union)
    await expect(reduceSchemas([{ label: 'WINDOW 1', schema: { fields: ['f1'] } }], merge)).resolves.toEqual({ fields: ['f1'] })
    expect(merge).not.toHaveBeenCalled()
  })

  it('fails rather than drop an input that cannot fit a request', async () => {
    const leaves = [{ label: 'WINDOW 1', schema: { fields: ['f1'] } }, { label: 'WINDOW 2', schema: { fields: ['x'.repeat(200)] } }]
    await expect(reduceSchemas(leaves, union, 100)).rejects.toMatchObject({ status: 422, code: 'merge_input_too_large' })
  })

  it('fails rather than loop when no two inputs fit one request', async () => {
    const leaves = Array.from({ length: 3 }, (_, i) => ({ label: `W${i}`, schema: { fields: [`f${i}`.padEnd(40, 'x')] } }))
    await expect(reduceSchemas(leaves, union, 80)).rejects.toMatchObject({ status: 422, code: 'merge_input_too_large' })
  })
})

describe('combineSchemas', () => {
  it('sends the labelled schemas whole with the union or the intersection instruction', async () => {
    const generate = vi.fn(async () => ({ template: { _description: 'One entry.' }, raw: '{}', pages: null, sourceCoverage: { complete: true as const } }))
    const signal = new AbortController().signal
    for (const mode of ['union', 'intersection'] as const)
      await combineSchemas({ researcherAccountId: 'owner' }, mode, 'WINDOW 1 SCHEMA:\n{}', signal, generate as unknown as typeof generateSchemaWithModel)

    const [union, intersection] = generate.mock.calls.map((call) => (call as unknown[])[1] as { instruction: string; window: boolean; document: { markdown: string } })
    expect(union!.instruction).toContain('keep every field found in any of them')
    expect(intersection!.instruction).toContain('only fields present in every supplied')
    expect([union!.window, intersection!.window]).toEqual([true, true])
    expect(union!.document.markdown).toBe('WINDOW 1 SCHEMA:\n{}')
  })
})
