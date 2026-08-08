import type {
  EvidenceLink,
  ResultPath,
} from '../shared/groundedExtraction'
import { isPopulatedResultScalar } from '../shared/groundedExtraction'
import {
  anchoredSource,
  canonicalAnchorInventory,
  type CanonicalAnchorInventoryEntry,
} from './anchoredDocument'
import type { ParsedDocumentV2 } from './parsedDocument'

export type {
  EvidenceLink,
  GroundedExtractionPayload,
  GroundedModelAttribution,
  ResultPath,
} from '../shared/groundedExtraction'

export type GroundingIssue =
  | {
      code: 'missing_claim'
      claimLabel: string
      resultPath: ResultPath
    }
  | {
      code: 'unknown_claim_label'
      claimLabel: string
    }
  | {
      code: 'unknown_anchor_label'
      claimLabel: string
      resultPath: ResultPath
      anchorLabel: string
    }
  | {
      code: 'malformed_selection'
      claimLabel: string
      resultPath: ResultPath
    }
  | {
      code: 'conflicting_anchor_selection'
      claimLabel: string
      resultPath: ResultPath
      anchorLabel: string
    }

export type GroundingOutcome = {
  evidenceLinks: readonly EvidenceLink[]
  ungroundedPaths: readonly ResultPath[]
  issues: readonly GroundingIssue[]
  modelAttribution: GroundingStageAttribution | null
}

export type GroundingStageAttribution = {
  strategy: 'retrieval_batched'
  batches: readonly {
    resultPath: ResultPath | null
    candidateCount: number
    fallback: boolean
    modelAttribution: unknown
  }[]
}

export type GroundingTemplate = {
  links: Record<string, 'verbatim-string'>
}

export type GroundingModelRequest = {
  documentMarkdown: string
  template: GroundingTemplate
  instruction: string
  signal?: AbortSignal
}

export type GroundingModelResponse = {
  result: unknown
  modelAttribution: unknown
}

export type GroundingModelInvoker = (
  request: GroundingModelRequest,
) => Promise<GroundingModelResponse>

export type GroundExtractionInput = {
  document: ParsedDocumentV2
  result: Record<string, unknown>
  signal?: AbortSignal
  invokeModel: GroundingModelInvoker
}

type Claim = {
  label: string
  resultPath: ResultPath
  value: string | number | boolean
}

type ClaimBatch = {
  resultPath: ResultPath | null
  claims: Claim[]
}

const ABSTAIN = 'NONE'

export class InvalidGroundingResponseError extends Error {
  constructor() {
    super('Grounding response must contain exactly one links object.')
    this.name = 'InvalidGroundingResponseError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function enumerateClaims(result: Record<string, unknown>): Claim[] {
  const claims: Claim[] = []
  const visit = (value: unknown, path: ResultPath) => {
    if (isPopulatedResultScalar(value)) {
      claims.push({
        label: `C${claims.length + 1}`,
        resultPath: path,
        value,
      })
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]))
      return
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value))
        visit(item, [...path, key])
    }
  }

  for (const [key, value] of Object.entries(result)) visit(value, [key])
  return claims
}

function renderResultPath(path: ResultPath): string {
  return path.reduce<string>((rendered, segment, index) => {
    if (typeof segment === 'number') return `${rendered}[${segment}]`
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
      ? `${rendered}${index === 0 ? '' : '.'}${segment}`
      : `${rendered}[${JSON.stringify(segment)}]`
  }, '')
}

function claimBatches(
  result: Record<string, unknown>,
  claims: readonly Claim[],
): ClaimBatch[] {
  if (!Array.isArray(result.records)) return [{ resultPath: null, claims: [...claims] }]

  const batches = new Map<string, ClaimBatch>()
  for (const claim of claims) {
    const recordIndex =
      claim.resultPath[0] === 'records' &&
      typeof claim.resultPath[1] === 'number' &&
      claim.resultPath[1] < result.records.length
        ? claim.resultPath[1]
        : null
    const key = recordIndex === null ? '$' : `records[${recordIndex}]`
    const batch = batches.get(key) ?? {
      resultPath: recordIndex === null ? null : ['records', recordIndex],
      claims: [],
    }
    batch.claims.push(claim)
    batches.set(key, batch)
  }
  return [...batches.values()]
}

function normalizeForRetrieval(value: string | number | boolean): string {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function containsClaim(
  source: string,
  claimValue: string | number | boolean,
): boolean {
  const needle = normalizeForRetrieval(claimValue)
  if (!needle || needle.length < 2) return false
  const haystack = normalizeForRetrieval(source)
  if (/^[+-]?(?:\d+[.,]?\d*|[.,]\d+)$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(
      `(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`,
      'u',
    ).test(haystack)
  }
  return haystack.includes(needle)
}

function retrievalCandidates(
  inventory: readonly CanonicalAnchorInventoryEntry[],
  claims: readonly Claim[],
): { anchorIds: readonly string[]; fallback: boolean } {
  const seeds = new Set(
    inventory
      .filter((entry) =>
        claims.some((claim) => containsClaim(entry.text, claim.value)),
      )
      .map((entry) => entry.anchorId),
  )
  if (seeds.size === 0)
    return {
      anchorIds: inventory.map((entry) => entry.anchorId),
      fallback: true,
    }

  const seededTableRows = new Map<string, Set<number>>()
  for (const entry of inventory) {
    if (entry.kind !== 'table_cell' || !seeds.has(entry.anchorId)) continue
    const rows = seededTableRows.get(entry.logicalTableId) ?? new Set<number>()
    rows.add(entry.row)
    seededTableRows.set(entry.logicalTableId, rows)
  }
  return {
    anchorIds: inventory
      .filter(
        (entry) =>
          seeds.has(entry.anchorId) ||
          (entry.kind === 'table_cell' &&
            seededTableRows.get(entry.logicalTableId)?.has(entry.row)),
      )
      .map((entry) => entry.anchorId),
    fallback: false,
  }
}

function groundingInstruction(batch: ClaimBatch): string {
  const renderedClaims = batch.claims.map(
    (claim) =>
      `[${claim.label}] ${renderResultPath(
        batch.resultPath
          ? claim.resultPath.slice(batch.resultPath.length)
          : claim.resultPath,
      )} = ${JSON.stringify(claim.value)}`,
  )
  return [
    'Ground every claim listed after "### Claims". Return exactly the keys shown under "links". Each value must be one exact E label from "### Canonical Evidence", without brackets, or NONE when no candidate directly supports the claim. A translated or normalized claim may cite a passage expressing the same meaning. A claim value or source passage is never a link: do not copy either into the links map. Never cite a C label. Add no snippets, pages, coordinates, explanations, or extra keys. Example: with evidence "[E1] The vessel is red" and claims "[C1] color = red" and "[C2] weight = 4", the only valid output is {"links":{"C1":"E1","C2":"NONE"}}.',
    '',
    '### Claims',
    `## ${batch.resultPath ? renderResultPath(batch.resultPath) : '$'}`,
    ...renderedClaims,
  ].join('\n')
}

function strictLinks(result: unknown): Record<string, unknown> {
  if (
    !isRecord(result) ||
    Object.keys(result).length !== 1 ||
    !Object.hasOwn(result, 'links') ||
    !isRecord(result.links)
  )
    throw new InvalidGroundingResponseError()
  return result.links
}

function resolveGrounding(
  result: unknown,
  claims: readonly Claim[],
  anchorIdByLabel: ReadonlyMap<string, string>,
  anchorTextByLabel: ReadonlyMap<string, string>,
): Pick<GroundingOutcome, 'evidenceLinks' | 'ungroundedPaths' | 'issues'> {
  const returned = strictLinks(result)
  const claimByLabel = new Map(claims.map((claim) => [claim.label, claim]))
  const evidenceLinks: EvidenceLink[] = []
  const issues: GroundingIssue[] = []

  for (const claimLabel of Object.keys(returned)) {
    if (!claimByLabel.has(claimLabel))
      issues.push({ code: 'unknown_claim_label', claimLabel })
  }

  for (const claim of claims) {
    if (!Object.hasOwn(returned, claim.label)) {
      issues.push({
        code: 'missing_claim',
        claimLabel: claim.label,
        resultPath: claim.resultPath,
      })
      continue
    }
    const anchorLabel = returned[claim.label]
    if (typeof anchorLabel !== 'string' || anchorLabel.length === 0) {
      issues.push({
        code: 'malformed_selection',
        claimLabel: claim.label,
        resultPath: claim.resultPath,
      })
      continue
    }
    if (anchorLabel === ABSTAIN) continue
    const evidenceAnchorId = anchorIdByLabel.get(anchorLabel)
    if (!evidenceAnchorId) {
      issues.push({
        code: 'unknown_anchor_label',
        claimLabel: claim.label,
        resultPath: claim.resultPath,
        anchorLabel,
      })
      continue
    }
    const exactAnchorLabels = [...anchorTextByLabel]
      .filter(([, text]) => containsClaim(text, claim.value))
      .map(([label]) => label)
    if (
      exactAnchorLabels.length > 0 &&
      !exactAnchorLabels.includes(anchorLabel)
    ) {
      issues.push({
        code: 'conflicting_anchor_selection',
        claimLabel: claim.label,
        resultPath: claim.resultPath,
        anchorLabel,
      })
      continue
    }
    evidenceLinks.push({
      resultPath: claim.resultPath,
      evidenceAnchorId,
    })
  }

  const groundedPaths = new Set(
    evidenceLinks.map((link) => JSON.stringify(link.resultPath)),
  )
  return {
    evidenceLinks,
    ungroundedPaths: claims
      .filter((claim) => !groundedPaths.has(JSON.stringify(claim.resultPath)))
      .map((claim) => claim.resultPath),
    issues,
  }
}

/**
 * Links immutable extracted values to parser-published Evidence through two
 * exact, call-scoped label dictionaries. No model-authored location survives.
 */
export async function groundExtraction({
  document,
  result,
  signal,
  invokeModel,
}: GroundExtractionInput): Promise<GroundingOutcome> {
  const claims = enumerateClaims(result)
  if (claims.length === 0)
    return {
      evidenceLinks: [],
      ungroundedPaths: [],
      issues: [],
      modelAttribution: null,
    }

  const inventory = canonicalAnchorInventory(document)
  const anchorTextById = new Map(
    inventory.map((entry) => [entry.anchorId, entry.text]),
  )
  const batches = claimBatches(result, claims)
  const evidenceLinks: EvidenceLink[] = []
  const issues: GroundingIssue[] = []
  const attributions: GroundingStageAttribution['batches'][number][] = []
  for (const batch of batches) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const candidates = retrievalCandidates(inventory, batch.claims)
    const source = anchoredSource(document, new Set(candidates.anchorIds))
    const generated = await invokeModel({
      documentMarkdown: `### Canonical Evidence\n${source.text}`,
      template: {
        links: Object.fromEntries(
          batch.claims.map((claim) => [claim.label, 'verbatim-string' as const]),
        ),
      },
      instruction: groundingInstruction(batch),
      signal,
    })
    const resolved = resolveGrounding(
      generated.result,
      batch.claims,
      source.anchorIdByLabel,
      new Map(
        [...source.anchorIdByLabel].flatMap(([label, anchorId]) => {
          const text = anchorTextById.get(anchorId)
          return text === undefined ? [] : [[label, text] as const]
        }),
      ),
    )
    evidenceLinks.push(...resolved.evidenceLinks)
    issues.push(...resolved.issues)
    attributions.push({
      resultPath: batch.resultPath,
      candidateCount: candidates.anchorIds.length,
      fallback: candidates.fallback,
      modelAttribution: generated.modelAttribution,
    })
  }
  const groundedPaths = new Set(
    evidenceLinks.map((link) => JSON.stringify(link.resultPath)),
  )
  return {
    evidenceLinks,
    ungroundedPaths: claims
      .filter((claim) => !groundedPaths.has(JSON.stringify(claim.resultPath)))
      .map((claim) => claim.resultPath),
    issues,
    modelAttribution: {
      strategy: 'retrieval_batched',
      batches: attributions,
    },
  }
}
