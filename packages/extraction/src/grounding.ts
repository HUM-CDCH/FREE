import type { GroundingModel, GroundingModelResponse } from './dependencies.js'
export type { GroundingModel } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { lexicalCheck, lexicalText } from './lexical.js'
import type { ParsedDocument } from './parsed-document.js'
import type { CatalogBoundary } from './catalog-boundaries.js'
import { sourceContext } from './source-context.js'
import type {
  EvidenceLink,
  GroundingBatchSnapshot,
  ModelGenerationMetadata,
  ResultPath,
} from './types.js'

export type GroundingIssue = Readonly<{
  code: 'missing_claim' | 'unknown_claim_label' | 'unknown_anchor_label' | 'malformed_selection' | 'grounding_failed'
  resultPath: ResultPath | null
  claimLabel?: string
  anchorLabel?: string
}>

export type GroundingOutcome = Readonly<{
  evidence: readonly EvidenceLink[]
  ungroundedPaths: readonly ResultPath[]
  issues: readonly GroundingIssue[]
  metadata: readonly ModelGenerationMetadata[]
  batches: readonly GroundingBatchSnapshot[]
}>

type Claim = Readonly<{ label: string; path: ResultPath; value: string | number | boolean }>
type ClaimBatch = Readonly<{ resultPath: ResultPath | null; claims: readonly Claim[] }>

export function resultPathKey(path: ResultPath): string {
  return JSON.stringify(path)
}

export function populatedContentPaths(value: unknown, path: ResultPath = []): ResultPath[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => populatedContentPaths(entry, [...path, index]))
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => populatedContentPaths(entry, [...path, key]))
  return value === '' || value === null || value === undefined ? [] : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [path] : []
}

export async function groundExtraction(
  document: ParsedDocument,
  result: Readonly<Record<string, unknown>>,
  model: GroundingModel,
  signal: AbortSignal,
  options?: {
    excludedRootFields?: ReadonlySet<string>
    allowedAnchorIds?: ReadonlySet<string>
    recordBoundaries?: readonly CatalogBoundary[]
    now?: () => number
  },
): Promise<GroundingOutcome> {
  const paths = populatedContentPaths(result).filter((path) => {
    const field = path[0] === 'records' && typeof path[1] === 'number' ? path[2] : path[0]
    return typeof field !== 'string' || !options?.excludedRootFields?.has(field)
  })
  if (paths.length === 0)
    return {
      evidence: [],
      ungroundedPaths: [],
      issues: [],
      metadata: [],
      batches: [],
    }
  const claims: Claim[] = paths.map((path, index) => ({ label: `C${index + 1}`, path, value: valueAtPath(result, path) as string | number | boolean }))
  const context = sourceContext(document, options?.allowedAnchorIds)
  // Read the anchor's own text, not the rendered line: re-parsing the render
  // cut every anchor at its first ` | ` (the table-cell join) or newline, so
  // the model saw less than the lexical check below verifies against.
  const anchors = Object.fromEntries([...context.anchorIdByLabel].map(([label, anchorId]) => [label, context.textByAnchorId.get(anchorId) ?? '']))
  const recordAnchors = options?.recordBoundaries?.map(boundary => {
    const blocks = document.content_stream.slice(boundary.startContentIndex, boundary.endContentIndex)
    const blockIds = new Set(blocks.map(block => block.block_id))
    const tableIds = new Set(blocks.flatMap(block => block.kind === 'table' ? [block.table_id] : []))
    const anchorIds = new Set(document.evidence_index.anchors.filter(anchor =>
      anchor.kind === 'text' ? blockIds.has(anchor.block_id) : tableIds.has(anchor.logical_table_id),
    ).map(anchor => anchor.anchor_id))
    return Object.fromEntries(Object.entries(anchors).filter(([label]) => anchorIds.has(context.anchorIdByLabel.get(label)!)))
  })
  const lexicalTextByAnchorId = new Map([...context.textByAnchorId].map(([anchorId, text]) => [anchorId, lexicalText(text)]))
  const claimByLabel = new Map(claims.map((claim) => [claim.label, claim]))
  const selectedClaims = new Set<string>()
  const evidence: EvidenceLink[] = []
  const issues: GroundingIssue[] = []
  const metadata: ModelGenerationMetadata[] = []
  const batches: GroundingBatchSnapshot[] = []
  const now = options?.now ?? performance.now.bind(performance)
  for (const batch of claimBatches(result, claims)) {
    signal.throwIfAborted()
    const recordIndex = batch.resultPath?.[1]
    const batchAnchors = typeof recordIndex === 'number' ? recordAnchors?.[recordIndex] ?? anchors : anchors
    const startedAt = now()
    let generated: GroundingModelResponse
    try {
      generated = await model.ground({
        claims: Object.fromEntries(batch.claims.map((claim) => [claim.label, claim.value])),
        anchors: batchAnchors,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      for (const claim of batch.claims) selectedClaims.add(claim.label)
      issues.push({ code: 'grounding_failed', resultPath: batch.resultPath })
      batches.push({
        resultPath: batch.resultPath,
        candidateCount: Object.keys(batchAnchors).length,
        fallback: true,
        outcome: 'failed',
        finishReason: null,
        inputTokens: null,
        outputTokens: null,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
      })
      continue
    }
    signal.throwIfAborted()
    metadata.push(generated.metadata)
    batches.push({
      resultPath: batch.resultPath,
      candidateCount: Object.keys(batchAnchors).length,
      fallback: true,
      outcome: 'succeeded',
      finishReason: generated.metadata.finishReason,
      inputTokens: generated.metadata.inputTokens,
      outputTokens: generated.metadata.outputTokens,
      durationMs:
        generated.metadata.durationMs ??
        Math.max(0, Math.round(now() - startedAt)),
    })
    for (const selection of generated.selections) {
      const claim = claimByLabel.get(selection.claimLabel)
      if (!claim || !batch.claims.includes(claim)) {
        issues.push({ code: 'unknown_claim_label', claimLabel: selection.claimLabel, resultPath: null })
        continue
      }
      if (selectedClaims.has(selection.claimLabel)) {
        issues.push({ code: 'malformed_selection', claimLabel: selection.claimLabel, resultPath: claim.path })
        continue
      }
      selectedClaims.add(selection.claimLabel)
      if (selection.anchorLabel === null) continue
      const evidenceAnchorId = context.anchorIdByLabel.get(selection.anchorLabel)
      if (!evidenceAnchorId || !Object.hasOwn(batchAnchors, selection.anchorLabel))
        issues.push({ code: 'unknown_anchor_label', claimLabel: claim.label, anchorLabel: selection.anchorLabel, resultPath: claim.path })
      else evidence.push({ resultPath: claim.path, evidenceAnchorId, ...lexicalCheck(claim.value, evidenceAnchorId, lexicalTextByAnchorId) })
    }
  }
  const grounded = new Set(evidence.map((link) => resultPathKey(link.resultPath)))
  const ungroundedPaths = claims.filter((claim) => !grounded.has(resultPathKey(claim.path))).map((claim) => claim.path)
  for (const claim of claims) if (!selectedClaims.has(claim.label)) issues.push({ code: 'missing_claim', claimLabel: claim.label, resultPath: claim.path })
  return { evidence, ungroundedPaths, issues, metadata, batches }
}

function claimBatches(
  result: Readonly<Record<string, unknown>>,
  claims: readonly Claim[],
): ClaimBatch[] {
  if (!Array.isArray(result.records))
    return [{ resultPath: null, claims: [...claims] }]
  const batches = new Map<string, { resultPath: ResultPath | null; claims: Claim[] }>()
  for (const claim of claims) {
    const recordIndex =
      claim.path[0] === 'records' &&
      typeof claim.path[1] === 'number' &&
      claim.path[1] < result.records.length
        ? claim.path[1]
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

function valueAtPath(root: unknown, path: ResultPath): unknown {
  let value = root
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value)) throw new ExtractionError('grounding_failed', 'An Extraction Result path did not resolve.')
      value = value[segment]
    } else {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ExtractionError('grounding_failed', 'An Extraction Result path did not resolve.')
      value = (value as Record<string, unknown>)[segment]
    }
  }
  return value
}
