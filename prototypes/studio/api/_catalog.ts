import {
  canonicalAnchorInventory,
  type CanonicalAnchorInventoryEntry,
} from '../shared/anchoredDocument.js'
import type { ParsedDocument } from '../shared/parsedDocument.js'

export const MAX_CATALOG_RECORDS = 100

export type CatalogDiagnosticCode =
  | 'discovery_invalid_output'
  | 'boundary_invalid'
  | 'boundary_terminal_ambiguous'
  | 'document_metadata_incomplete'
  | 'document_metadata_inconsistent'
  | 'record_extraction_failed'
  | 'grounding_incomplete'
  | 'not_attempted_limit'

export type HeadingCandidate = {
  label: string
  anchorId: string
  blockId: string
  text: string
  level: number
  inventoryIndex: number
}

export type BoundaryIssue = {
  code: 'boundary_invalid' | 'boundary_terminal_ambiguous'
  label: string | null
  reason:
    | 'unknown_label'
    | 'duplicate_label'
    | 'non_monotonic'
    | 'wrong_level'
    | 'terminal_unresolved'
}

export type CatalogBoundary = {
  ordinal: number
  startLabel: string
  startAnchorId: string
  headingText: string
  headingLevel: number
  endAnchorId: string | null
  startIndex: number
  endIndex: number
}

export type CatalogBoundaryResolution = {
  boundaries: CatalogBoundary[]
  issues: BoundaryIssue[]
  notAttempted: CatalogBoundary[]
}

function alphaLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    value--
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return `H-${label}`
}

export function headingCandidates(
  document: ParsedDocument,
): HeadingCandidate[] {
  const inventory = canonicalAnchorInventory(document)
  const inventoryIndexByAnchor = new Map(
    inventory.map((entry, index) => [entry.anchorId, index]),
  )
  const anchorByBlock = new Map(
    document.evidence_index.anchors.flatMap((anchor) =>
      anchor.kind === 'text'
        ? [[anchor.block_id, anchor.anchor_id] as const]
        : [],
    ),
  )
  const blockById = new Map(
    document.content_stream.map((block) => [block.block_id, block]),
  )
  const result: HeadingCandidate[] = []
  for (const page of document.pages) {
    for (const blockId of page.ordered_content) {
      const block = blockById.get(blockId)
      if (block?.kind !== 'heading') continue
      const anchorId = anchorByBlock.get(blockId)
      const inventoryIndex = anchorId
        ? inventoryIndexByAnchor.get(anchorId)
        : undefined
      if (!anchorId || inventoryIndex === undefined) continue
      result.push({
        label: alphaLabel(result.length),
        anchorId,
        blockId,
        text: block.text,
        level: block.level,
        inventoryIndex,
      })
    }
  }
  return result
}

function numberedHeadingSignature(text: string): string | null {
  const outline = /^\s*(\d+(?:\.\d+)*)\.\s+/.exec(text)
  if (outline) return `outline:${outline[1].split('.').length}`
  if (!/\d/.test(text)) return null
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}#\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Prefer one proved shallow sibling family when canonical headings expose it.
 * This removes nested Zhang subsections and Beretning's spurious headings
 * before discovery; otherwise all canonical headings remain available.
 */
export function catalogHeadingCandidates(
  document: ParsedDocument,
): HeadingCandidate[] {
  const candidates = headingCandidates(document)
  if (candidates.length < 2) return candidates
  const shallowest = Math.min(...candidates.map((candidate) => candidate.level))
  const siblings = candidates.filter(
    (candidate) => candidate.level === shallowest,
  )
  const groups = new Map<string, HeadingCandidate[]>()
  for (const candidate of siblings) {
    const signature = numberedHeadingSignature(candidate.text)
    if (!signature) continue
    groups.set(signature, [...(groups.get(signature) ?? []), candidate])
  }
  const recurring = [...groups.values()].sort(
    (left, right) => right.length - left.length,
  )[0]
  return recurring && recurring.length >= 2 ? recurring : candidates
}

export function headingCandidateSource(
  candidates: readonly HeadingCandidate[],
): string {
  return candidates
    .map(
      (candidate) =>
        `[${candidate.label}] level=${candidate.level} ${candidate.text}`,
    )
    .join('\n')
}

export function parseDiscoveryStarts(value: unknown): string[] | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, 'starts')
  )
    return null
  const starts = (value as { starts?: unknown }).starts
  return Array.isArray(starts) &&
    starts.every((label) => typeof label === 'string')
    ? starts
    : null
}

export function resolveCatalogBoundaries(
  document: ParsedDocument,
  labels: readonly string[],
  allowedCandidates: readonly HeadingCandidate[] = headingCandidates(document),
): CatalogBoundaryResolution {
  const inventory = canonicalAnchorInventory(document)
  const allHeadings = headingCandidates(document)
  const candidateByLabel = new Map(
    allowedCandidates.map((candidate) => [candidate.label, candidate]),
  )
  const accepted: HeadingCandidate[] = []
  const issues: BoundaryIssue[] = []
  const seen = new Set<string>()
  let previousIndex = -1
  let headingLevel: number | null = null

  for (const label of labels) {
    const candidate = candidateByLabel.get(label)
    if (!candidate) {
      issues.push({ code: 'boundary_invalid', label, reason: 'unknown_label' })
      continue
    }
    if (seen.has(label)) {
      issues.push({ code: 'boundary_invalid', label, reason: 'duplicate_label' })
      continue
    }
    seen.add(label)
    if (candidate.inventoryIndex <= previousIndex) {
      issues.push({ code: 'boundary_invalid', label, reason: 'non_monotonic' })
      continue
    }
    if (headingLevel !== null && candidate.level !== headingLevel) {
      issues.push({ code: 'boundary_invalid', label, reason: 'wrong_level' })
      continue
    }
    headingLevel ??= candidate.level
    previousIndex = candidate.inventoryIndex
    accepted.push(candidate)
  }

  const allBoundaries = accepted.map((candidate, index): CatalogBoundary => {
    const next = accepted[index + 1]
    let endIndex: number
    if (next) {
      endIndex = next.inventoryIndex
    } else {
      const terminal = allHeadings.find(
        (heading) =>
          heading.inventoryIndex > candidate.inventoryIndex &&
          heading.level <= candidate.level,
      )
      endIndex = terminal?.inventoryIndex ?? inventory.length
    }
    if (endIndex <= candidate.inventoryIndex) {
      issues.push({
        code: 'boundary_terminal_ambiguous',
        label: candidate.label,
        reason: 'terminal_unresolved',
      })
      endIndex = candidate.inventoryIndex + 1
    }
    return {
      ordinal: index,
      startLabel: candidate.label,
      startAnchorId: candidate.anchorId,
      headingText: candidate.text,
      headingLevel: candidate.level,
      endAnchorId: inventory[endIndex]?.anchorId ?? null,
      startIndex: candidate.inventoryIndex,
      endIndex,
    }
  })

  return {
    boundaries: allBoundaries.slice(0, MAX_CATALOG_RECORDS),
    notAttempted: allBoundaries.slice(MAX_CATALOG_RECORDS),
    issues,
  }
}

export function catalogSliceSource(
  document: ParsedDocument,
  boundary: Pick<CatalogBoundary, 'startIndex' | 'endIndex'>,
): string {
  return renderInventory(
    canonicalAnchorInventory(document).slice(
      boundary.startIndex,
      boundary.endIndex,
    ),
  )
}

function renderInventory(
  entries: readonly CanonicalAnchorInventoryEntry[],
): string {
  const lines: string[] = []
  let page: number | null = null
  let table: string | null = null
  let row: number | null = null
  for (const entry of entries) {
    if (entry.page !== page) {
      lines.push(`## Page ${entry.page}`)
      page = entry.page
      table = null
      row = null
    }
    if (entry.kind === 'text') {
      lines.push(entry.text)
      table = null
      row = null
      continue
    }
    if (entry.logicalTableId !== table) {
      lines.push(`### Table ${entry.logicalTableId}`)
      table = entry.logicalTableId
      row = null
    }
    if (entry.row !== row) {
      lines.push(entry.text)
      row = entry.row
    } else {
      lines[lines.length - 1] += ` | ${entry.text}`
    }
  }
  return lines.join('\n')
}
