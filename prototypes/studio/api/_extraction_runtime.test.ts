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
