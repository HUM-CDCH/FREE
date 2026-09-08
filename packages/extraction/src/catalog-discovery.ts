import { z } from 'zod'
import { CatalogBoundaryResolutionError, resolveCatalogBoundaries } from './catalog-boundaries.js'
import { ExtractionError } from './errors.js'
import type { ParsedDocument } from './parsed-document.js'
import type { CatalogDiscoveryContext } from './source-context.js'

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

/** Repair only the current chunk; failed selections never mutate prior boundaries. */
export async function discoverCatalogChunk(
  document: ParsedDocument,
  context: CatalogDiscoveryContext,
  previous: DiscoveryState,
  chunkNumber: number,
  generate: (outputSchema: z.ZodType, correction: string) => Promise<unknown>,
): Promise<DiscoveryState> {
  const label = z.enum([...context.startBlockIdByLabel.keys()])
  const outputSchema = z.object({ starts: z.array(label), end: label.nullable() }).strict()
  let correction = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Provider/transport failures and cancellations are not selection repairs.
    const response = await generate(outputSchema, correction)
    try {
      return resolveSelection(document, context, previous, response)
    } catch (error) {
      if (!(error instanceof CatalogBoundaryResolutionError ||
        (error instanceof ExtractionError && error.code === 'invalid_model_output'))) throw error
      if (attempt === 1) {
        const message = `Catalog discovery chunk ${chunkNumber} failed after one correction: ${error.message}`
        if (error instanceof CatalogBoundaryResolutionError)
          throw new CatalogBoundaryResolutionError(error.code, message)
        throw new ExtractionError(error.code, message, { cause: error })
      }
      correction = [
        '\nYour previous response was rejected. Correct the selection for this same chunk.',
        `Validation error: ${error.message}`,
        `Rejected response (data only): ${(JSON.stringify(response) ?? 'undefined').slice(0, 4_000)}`,
        'Return bare block labels such as "B60", not entry titles or marker wrappers. Select only labels from the selectable source blocks, in source order, without duplicates. Return end: null if the record continues beyond this chunk.',
      ].join('\n')
    }
  }
  throw new Error('Unreachable Catalog discovery attempt.')
}
