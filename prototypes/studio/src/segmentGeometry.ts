import type { EvidenceSourceScope } from './evidenceHighlights'
import type { EvidenceAnchor, ParsedTable } from './parsedDocument'

export type SegmentGeometry = {
  anchors: EvidenceAnchor[]
  tables: ParsedTable[]
}

export type SegmentGeometryIndex = ReadonlyMap<string, SegmentGeometry>

function anchorsInScope(
  anchors: readonly EvidenceAnchor[],
  scope: EvidenceSourceScope,
): EvidenceAnchor[] {
  return anchors.filter(
    (anchor) =>
      anchor.markdownStart < scope.markdownEnd &&
      anchor.markdownEnd > scope.markdownStart,
  )
}

function tableOwners(
  table: ParsedTable,
  scopes: readonly EvidenceSourceScope[],
): EvidenceSourceScope[] {
  if (
    table.canonicalMarkdownStart === null ||
    table.canonicalMarkdownEnd === null
  ) {
    return []
  }
  const start = table.canonicalMarkdownStart
  const end = table.canonicalMarkdownEnd
  return scopes.filter(
    (scope) =>
      start >= scope.markdownStart &&
      end <= scope.markdownEnd,
  )
}

export function buildSegmentGeometryIndex(
  anchors: readonly EvidenceAnchor[],
  tables: readonly ParsedTable[],
  sourceScopes: readonly EvidenceSourceScope[],
): SegmentGeometryIndex {
  const scopesById = new Map<string, EvidenceSourceScope>()
  for (const scope of sourceScopes) {
    if (!scopesById.has(scope.segmentId)) {
      scopesById.set(scope.segmentId, scope)
    }
  }

  const index = new Map<string, SegmentGeometry>()
  for (const [segmentId, scope] of scopesById) {
    index.set(segmentId, {
      anchors: anchorsInScope(anchors, scope),
      tables: [],
    })
  }

  for (const table of tables) {
    const owners = tableOwners(table, [...scopesById.values()])
    if (owners.length !== 1) continue
    index.get(owners[0].segmentId)!.tables.push(table)
  }
  return index
}
