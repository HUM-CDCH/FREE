import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { CreateExtractionRuntimeDependencies } from 'extraction'

const runtime = vi.hoisted(() => ({
  create: vi.fn(),
  extract: vi.fn(),
  resolve: vi.fn(),
}))
vi.mock('extraction', async (importOriginal) => ({
  ...await importOriginal<typeof import('extraction')>(),
  createExtractionRuntime: runtime.create,
}))
vi.mock('./_model.js', () => ({ extractWithModel: runtime.extract }))
vi.mock('./_provider.js', () => ({ resolveCapabilityRoute: runtime.resolve }))

it('passes discovery output constraints from the extraction session to the provider adapter', async () => {
  await import('./_extraction_runtime.js')
  const target = { attribution: { provider: 'test', modelId: 'test' } }
  runtime.resolve.mockResolvedValue(target)
  runtime.extract.mockResolvedValue({ result: { starts: ['B60'], end: null }, metadata: {} })
  const dependencies = runtime.create.mock.calls[0][0] as CreateExtractionRuntimeDependencies
  const session = await dependencies.models.open()
  const label = z.enum(['B60', 'B81'])
  const outputSchema = z.object({ starts: z.array(label), end: label.nullable() }).strict()
  await session.model.extract({
    document: { markdown: '[[block:B60]] 215. Oberheldrungen', pages: 1 },
    template: { starts: ['string'], end: 'string' },
    outputSchema,
    signal: new AbortController().signal,
  })
  expect(runtime.extract).toHaveBeenCalledWith(expect.objectContaining({ outputSchema }), target)
})

it("names each claim's record and field to the grounder when the request carries them", async () => {
  await import('./_extraction_runtime.js')
  const target = { attribution: { provider: 'test', modelId: 'test' } }
  runtime.resolve.mockResolvedValue(target)
  runtime.extract.mockResolvedValue({ result: { links: { C1: 'E1', C2: 'NONE' } }, metadata: {} })
  const dependencies = runtime.create.mock.calls[0][0] as CreateExtractionRuntimeDependencies
  const session = await dependencies.models.open()
  const anchors = { E1: 'Grab 12, NW-SO.', E2: 'Pflaster NW-SO.' }
  await session.groundingModel.ground({
    claims: { C1: 'NW-SO', C2: 12 },
    anchors,
    claimFields: {
      C1: { record: 'records[3]', field: 'burial_axis', description: 'Orientation of the grave pit.' },
      C2: { record: 'records[3]', field: 'grave_number', description: null },
    },
    signal: new AbortController().signal,
  })
  const instruction = runtime.extract.mock.lastCall?.[0].instruction as string
  expect(instruction).toContain('### Fields\n- burial_axis: Orientation of the grave pit.')
  expect(instruction).toContain('[C1] records[3].burial_axis: "NW-SO"')
  expect(instruction).toContain('[C2] records[3].grave_number: 12')
  expect(instruction).toContain('own record')

  await session.groundingModel.ground({ claims: { C1: 'NW-SO' }, anchors, signal: new AbortController().signal })
  const plain = runtime.extract.mock.lastCall?.[0].instruction as string
  expect(plain).toContain('[C1] "NW-SO"')
  expect(plain).not.toContain('### Fields')
  expect(plain).not.toContain('own record')
  expect(dependencies.policy).toEqual({ recordBatchSize: 1, lexicalLinks: false, groundingGroupSize: 1, fieldAwareGrounding: false })
})
