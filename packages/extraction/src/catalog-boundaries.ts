import type { ParsedContentBlock, ParsedDocument } from './parsed-document.js'

export type CatalogBoundary = {
  startBlockId: string
  startContentIndex: number
  endContentIndex: number
  headingText: string
  headingLevel: number | null
}

export type CatalogBoundaryErrorCode =
  | 'unknown_start'
  | 'duplicate_start'
  | 'non_text_start'
  | 'non_monotonic_order'
  | 'invalid_end'

export class CatalogBoundaryResolutionError extends Error {
  readonly code: CatalogBoundaryErrorCode

  constructor(code: CatalogBoundaryErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'CatalogBoundaryResolutionError'
  }
}


export function catalogStartText(block: ParsedContentBlock): string | null {
  return block.kind === 'list' ? block.items.join('; ') : 'text' in block ? block.text : null
}

/** Resolve stable text block IDs to canonical, end-exclusive content slices. */
export function resolveCatalogBoundaries(
  document: Pick<ParsedDocument, 'content_stream'>,
  startBlockIds: readonly string[],
  terminalEndBlockId?: string,
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
    const text = catalogStartText(match.block)
    if (!text?.trim())
      throw new CatalogBoundaryResolutionError(
        'non_text_start',
        `Catalog discovery start block ${JSON.stringify(startBlockId)} has no text.`,
      )
    return { index: match.index, block: match.block, text }
  })

  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index - 1].index >= resolved[index].index) {
      throw new CatalogBoundaryResolutionError(
        'non_monotonic_order',
        'Catalog discovery starts are not in canonical source order.',
      )
    }
  }

  const terminalEnd = terminalEndBlockId === undefined ? undefined : blocks.get(terminalEndBlockId)?.index
  if (terminalEndBlockId !== undefined &&
    (terminalEnd === undefined || terminalEnd <= (resolved.at(-1)?.index ?? -1)))
    throw new CatalogBoundaryResolutionError('invalid_end', 'Catalog end must identify a source block after its last record start.')

  return resolved.map(({ index, block, text }, ordinal) => {
    const endContentIndex =
      ordinal + 1 < resolved.length
        ? resolved[ordinal + 1].index
        : terminalEnd !== undefined
          ? terminalEnd
          : block.kind === 'heading'
          ? nextPeerOrShallowerHeading(document.content_stream, index, block.level)
          : document.content_stream.length

    return {
      startBlockId: block.block_id,
      startContentIndex: index,
      endContentIndex,
      headingText: text,
      headingLevel: block.kind === 'heading' ? block.level : null,
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
