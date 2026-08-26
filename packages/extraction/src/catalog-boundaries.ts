import type { ParsedContentBlock, ParsedDocument } from './parsed-document.js'

export type CatalogBoundary = {
  startBlockId: string
  startContentIndex: number
  endContentIndex: number
  headingText: string
  headingLevel: number
}

export type CatalogBoundaryErrorCode =
  | 'unknown_label'
  | 'duplicate_label'
  | 'non_heading_label'
  | 'ambiguous_heading'
  | 'non_monotonic_order'

export class CatalogBoundaryResolutionError extends Error {
  readonly code: CatalogBoundaryErrorCode
  readonly label?: string

  constructor(
    code: CatalogBoundaryErrorCode,
    message: string,
    label?: string,
  ) {
    super(message)
    this.code = code
    this.label = label
    this.name = 'CatalogBoundaryResolutionError'
  }
}

function textOf(block: ParsedContentBlock): string | undefined {
  return 'text' in block ? block.text : undefined
}

/** Resolve exact discovery labels to canonical, end-exclusive content slices. */
export function resolveCatalogBoundaries(
  document: Pick<ParsedDocument, 'content_stream'>,
  labels: readonly string[],
): CatalogBoundary[] {
  const seen = new Set<string>()
  for (const label of labels) {
    if (seen.has(label)) {
      throw new CatalogBoundaryResolutionError(
        'duplicate_label',
        `Catalog discovery label is duplicated: ${JSON.stringify(label)}.`,
        label,
      )
    }
    seen.add(label)
  }

  const occurrences = new Map<
    string,
    {
      headings: Array<{
        index: number
        block: Extract<ParsedContentBlock, { kind: 'heading' }>
      }>
      nonHeading: boolean
    }
  >()
  document.content_stream.forEach((block, index) => {
    const text = textOf(block)
    if (text === undefined) return
    const occurrence = occurrences.get(text) ?? {
      headings: [],
      nonHeading: false,
    }
    if (block.kind === 'heading') occurrence.headings.push({ index, block })
    else occurrence.nonHeading = true
    occurrences.set(text, occurrence)
  })

  const resolved = labels.map((label) => {
    const occurrence = occurrences.get(label)
    const headingMatches = occurrence?.headings ?? []
    if (headingMatches.length === 0) {
      const nonHeadingMatch = occurrence?.nonHeading ?? false
      const code = nonHeadingMatch ? 'non_heading_label' : 'unknown_label'
      const reason = nonHeadingMatch ? 'identifies only non-heading content' : 'is unknown'
      throw new CatalogBoundaryResolutionError(
        code,
        `Catalog discovery label ${JSON.stringify(label)} ${reason}.`,
        label,
      )
    }
    if (headingMatches.length > 1) {
      throw new CatalogBoundaryResolutionError(
        'ambiguous_heading',
        `Catalog discovery label ${JSON.stringify(label)} matches multiple canonical headings.`,
        label,
      )
    }

    const match = headingMatches[0]
    return {
      index: match.index,
      block: match.block,
    }
  })

  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index - 1].index >= resolved[index].index) {
      throw new CatalogBoundaryResolutionError(
        'non_monotonic_order',
        'Catalog discovery labels are not in canonical source order.',
        labels[index],
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
