import type { ParsedContentBlock, ParsedDocument } from './parsed-document.js'

export type CatalogBoundary = {
  startBlockId: string
  startContentIndex: number
  endContentIndex: number
  headingText: string
  headingLevel: number
}

export type CatalogBoundaryErrorCode =
  | 'unknown_start'
  | 'duplicate_start'
  | 'non_heading_start'
  | 'non_monotonic_order'

export class CatalogBoundaryResolutionError extends Error {
  readonly code: CatalogBoundaryErrorCode

  constructor(code: CatalogBoundaryErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'CatalogBoundaryResolutionError'
  }
}


/** Resolve stable heading block IDs to canonical, end-exclusive content slices. */
export function resolveCatalogBoundaries(
  document: Pick<ParsedDocument, 'content_stream'>,
  startBlockIds: readonly string[],
): CatalogBoundary[] {
  const seen = new Set<string>()
  for (const startBlockId of startBlockIds) {
    if (seen.has(startBlockId)) {
      throw new CatalogBoundaryResolutionError(
        'duplicate_start',
        `Catalog discovery start block is duplicated: ${JSON.stringify(startBlockId)}.`,
      )
    }
    seen.add(startBlockId)
  }

  const blocks = new Map(
    document.content_stream.map((block, index) => [
      block.block_id,
      { index, block },
    ]),
  )
  const resolved = startBlockIds.map((startBlockId) => {
    const match = blocks.get(startBlockId)
    if (!match)
      throw new CatalogBoundaryResolutionError(
        'unknown_start',
        `Catalog discovery start block ${JSON.stringify(startBlockId)} is unknown.`,
      )
    if (match.block.kind !== 'heading')
      throw new CatalogBoundaryResolutionError(
        'non_heading_start',
        `Catalog discovery start block ${JSON.stringify(startBlockId)} is not a heading.`,
      )
    return { index: match.index, block: match.block }
  })

  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index - 1].index >= resolved[index].index) {
      throw new CatalogBoundaryResolutionError(
        'non_monotonic_order',
        'Catalog discovery starts are not in canonical source order.',
      )
    }
  }

  return resolved.map(({ index, block }, ordinal) => {
    const endContentIndex =
      ordinal + 1 < resolved.length
        ? resolved[ordinal + 1].index
        : nextPeerOrShallowerHeading(document.content_stream, index, block.level)

    return {
      startBlockId: block.block_id,
      startContentIndex: index,
      endContentIndex,
      headingText: block.text,
      headingLevel: block.level,
    }
  })
}

function nextPeerOrShallowerHeading(
  contentStream: readonly ParsedContentBlock[],
  startIndex: number,
  startLevel: number,
): number {
  for (let index = startIndex + 1; index < contentStream.length; index += 1) {
    const block = contentStream[index]
    if (block.kind === 'heading' && block.level <= startLevel) return index
  }
  return contentStream.length
}
