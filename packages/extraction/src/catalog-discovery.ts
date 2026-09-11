import { z } from 'zod'
import { CatalogBoundaryResolutionError, resolveCatalogBoundaries } from './catalog-boundaries.js'
import { ExtractionError } from './errors.js'
import type { ParsedDocument } from './parsed-document.js'
import { splitCatalogDiscoveryContext, type CatalogDiscoveryContext } from './source-context.js'

type DiscoveryState = Readonly<{
  startBlockIds: readonly string[]
  terminalEndBlockId?: string
}>

const selectionShape = z.object({
  starts: z.array(z.string()),
  end: z.string().nullable().optional(),
}).strict()

function resolveSelection(
  document: ParsedDocument,
  context: CatalogDiscoveryContext,
  previous: DiscoveryState,
  response: unknown,
): DiscoveryState {
  const parsed = selectionShape.safeParse(response)
  if (!parsed.success)
    throw new ExtractionError('invalid_model_output', 'Catalog discovery must return starts: string[] and end: string|null, with no extra keys.')
  const resolve = (value: string, kind: 'start' | 'end') => {
    const trimmed = value.trim()
    const label = /^\[\[block:(B\d+)\]\]$/.exec(trimmed)?.[1] ?? trimmed
    const id = context.startBlockIdByLabel.get(label)
    if (!id)
      throw new CatalogBoundaryResolutionError(
        kind === 'start' ? 'unknown_start' : 'invalid_end',
        `Catalog discovery ${kind} block ID ${JSON.stringify(value.slice(0, 160))} is not selectable in this chunk.`,
      )
    return id
  }
  const starts = parsed.data.starts.map(value => resolve(value, 'start'))
  // Validate every supplied ID, even when an earlier section already has an end.
  const end = parsed.data.end == null ? undefined : resolve(parsed.data.end, 'end')
  const startBlockIds = [...previous.startBlockIds, ...starts]
  const previousEnd = starts.length > 0 ? undefined : previous.terminalEndBlockId
  const terminalEndBlockId = previousEnd ?? (startBlockIds.length > 0 ? end : undefined)
  resolveCatalogBoundaries(document, startBlockIds, terminalEndBlockId)
  return { startBlockIds, terminalEndBlockId }
}

/** Failed whole-chunk selections never mutate accepted boundaries. Split only once. */
export async function discoverCatalogChunk(
  document: ParsedDocument,
  context: CatalogDiscoveryContext,
  previous: DiscoveryState,
  chunkNumber: number,
  generate: (outputSchema: z.ZodType, context: CatalogDiscoveryContext, previous: DiscoveryState) => Promise<unknown>,
): Promise<DiscoveryState> {
  const discover = async (part: CatalogDiscoveryContext, state: DiscoveryState) => {
    if (part.startBlockIdByLabel.size === 0) return state
    const label = z.enum([...part.startBlockIdByLabel.keys()])
    const outputSchema = z.object({ starts: z.array(label), end: label.nullable() }).strict()
    return resolveSelection(document, part, state, await generate(outputSchema, part, state))
  }
  try {
    return await discover(context, previous)
  } catch (error) {
    if (!(error instanceof CatalogBoundaryResolutionError ||
      (error instanceof ExtractionError && error.code === 'invalid_model_output'))) throw error
    const halves = splitCatalogDiscoveryContext(document, context)
    if (halves.length === 0)
      throw new ExtractionError('invalid_model_output', `Catalog discovery chunk ${chunkNumber} failed and cannot be split.`, { cause: error })
    let recovered = previous
    for (const half of halves) recovered = await discover(half, recovered)
    return recovered
  }
}
