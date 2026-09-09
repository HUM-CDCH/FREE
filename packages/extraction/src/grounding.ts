import type { GroundingClaimField, GroundingModel, GroundingModelResponse } from './dependencies.js'
export type { GroundingModel } from './dependencies.js'
import type { CatalogPolicy } from './catalog.js'
import { ExtractionError } from './errors.js'
import { lexicalCheck, lexicalText, lexicalUniqueHit } from './lexical.js'
import type { ParsedDocument } from './parsed-document.js'
import type { CatalogBoundary } from './catalog-boundaries.js'
import { schemaNodeAtPath, type SchemaNode } from './schema.js'
import { recordAnchorIds, sourceContext } from './source-context.js'
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
    /** Call structure; absent means one values-only call per record. */
    policy?: Pick<CatalogPolicy, 'lexicalLinks' | 'groundingGroupSize' | 'fieldAwareGrounding' | 'citationLinks' | 'groundAlways' | 'groundMultiHit' | 'groundedContext'>
    /** Schema nodes describing the claims' fields, for field-aware grounding. */
    schemaNodes?: readonly SchemaNode[]
    /** Anchor the values call cited for a claim, by result path key. */
    citations?: ReadonlyMap<string, string>
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
    const anchorIds = recordAnchorIds(document, boundary)
    return Object.fromEntries(Object.entries(anchors).filter(([label]) => anchorIds.has(context.anchorIdByLabel.get(label)!)))
  })
  const lexicalTextByAnchorId = new Map([...context.textByAnchorId].map(([anchorId, text]) => [anchorId, lexicalText(text)]))
  const policy = options?.policy
  const selectedClaims = new Set<string>()
  const evidence: EvidenceLink[] = []
  const issues: GroundingIssue[] = []
  const metadata: ModelGenerationMetadata[] = []
  const batches: GroundingBatchSnapshot[] = []
  const now = options?.now ?? performance.now.bind(performance)
  for (const group of claimGroups(claimBatches(result, claims), policy?.groundingGroupSize ?? 1)) {
    signal.throwIfAborted()
    // Every record keeps its own candidate set; a grouped call shows their union.
    const members = group.map((batch) => {
      const recordIndex = batch.resultPath?.[1]
      const batchAnchors = typeof recordIndex === 'number' ? recordAnchors?.[recordIndex] ?? anchors : anchors
      // Ambiguity counts only the candidates the grounder was shown: a value
      // repeated in other catalogue entries was never a candidate for this one.
      const lexical = batchAnchors === anchors
        ? lexicalTextByAnchorId
        : new Map(Object.keys(batchAnchors).map((label) => {
            const anchorId = context.anchorIdByLabel.get(label)!
            return [anchorId, lexicalTextByAnchorId.get(anchorId)!] as const
          }))
      return { batch, anchors: batchAnchors, lexical }
    })
    const pending = new Map<string, { claim: Claim; member: (typeof members)[number] }>()
    const linkedInCode = new Map<string, { claim: Claim; anchorId: string }>()
    for (const member of members)
      for (const claim of member.batch.claims) {
        const cited = policy?.citationLinks ? options?.citations?.get(resultPathKey(claim.path)) : undefined
        if (cited !== undefined) {
          // A citation is accepted only where code can see the value in the
          // cited block of the claim's own record; a match proves occurrence,
          // not meaning, so routed fields and repeated values still go to the
          // grounder. Still a suggestion; the reviewer decides.
          const label = context.labelByAnchorId.get(cited)
          const check = label !== undefined && Object.hasOwn(member.anchors, label) ? lexicalCheck(claim.value, cited, member.lexical) : null
          const field = claimField(claim, options?.schemaNodes ?? []).field
          const routed = (policy?.groundAlways ?? []).includes(field) || (policy?.groundMultiHit === true && (check?.lexicalHits ?? 0) > 1)
          if (check?.verbatim && !routed) {
            selectedClaims.add(claim.label)
            evidence.push({ resultPath: claim.path, evidenceAnchorId: cited, ...check, linkedBy: 'citation_lexical' })
            linkedInCode.set(claim.label, { claim, anchorId: cited })
            continue
          }
        }
        const hit = policy?.lexicalLinks ? lexicalUniqueHit(claim.value, member.lexical) : null
        if (hit === null) {
          pending.set(claim.label, { claim, member })
          continue
        }
        // The value is a bounded token of exactly one candidate: link it
        // without the model. Still a suggestion; the reviewer decides.
        selectedClaims.add(claim.label)
        evidence.push({ resultPath: claim.path, evidenceAnchorId: hit, verbatim: true, lexicalHits: 1, linkedBy: 'lexical' })
        linkedInCode.set(claim.label, { claim, anchorId: hit })
      }
    if (pending.size === 0) continue
    // Only records that still have a claim are shown: a record whose claims
    // were all linked in code adds candidates without a question to answer.
    // With grounded context the call keeps every record's slice, so the shown links resolve.
    const active = policy?.groundedContext ? members : members.filter((member) => member.batch.claims.some((claim) => pending.has(claim.label)))
    const callAnchors: Record<string, string> = active.length === 1 ? active[0].anchors : Object.assign({}, ...active.map((member) => member.anchors))
    const linkedClaims = policy?.groundedContext && linkedInCode.size > 0
      ? Object.fromEntries([...linkedInCode].map(([label, { claim, anchorId }]) => [label, { value: claim.value, anchorLabel: context.labelByAnchorId.get(anchorId)!, field: policy?.fieldAwareGrounding ? claimField(claim, options?.schemaNodes ?? []) : null }]))
      : undefined
    const resultPath = group[0].resultPath
    const startedAt = now()
    let generated: GroundingModelResponse
    try {
      generated = await model.ground({
        claims: Object.fromEntries([...pending.values()].map(({ claim }) => [claim.label, claim.value])),
        anchors: callAnchors,
        ...(policy?.fieldAwareGrounding && {
          claimFields: Object.fromEntries([...pending.values()].map(({ claim }) => [claim.label, claimField(claim, options?.schemaNodes ?? [])])),
        }),
        ...(linkedClaims && { linkedClaims }),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      for (const label of pending.keys()) selectedClaims.add(label)
      for (const member of members) issues.push({ code: 'grounding_failed', resultPath: member.batch.resultPath })
      batches.push({
        resultPath,
        candidateCount: Object.keys(callAnchors).length,
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
      resultPath,
      candidateCount: Object.keys(callAnchors).length,
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
      const entry = pending.get(selection.claimLabel)
      if (!entry) {
        issues.push({ code: 'unknown_claim_label', claimLabel: selection.claimLabel, resultPath: null })
        continue
      }
      const { claim, member } = entry
      if (selectedClaims.has(selection.claimLabel)) {
        issues.push({ code: 'malformed_selection', claimLabel: selection.claimLabel, resultPath: claim.path })
        continue
      }
      selectedClaims.add(selection.claimLabel)
      if (selection.anchorLabel === null) continue
      const evidenceAnchorId = context.anchorIdByLabel.get(selection.anchorLabel)
      // A link must stay inside the claim's own record, not merely inside the call.
      if (!evidenceAnchorId || !Object.hasOwn(member.anchors, selection.anchorLabel))
        issues.push({ code: 'unknown_anchor_label', claimLabel: claim.label, anchorLabel: selection.anchorLabel, resultPath: claim.path })
      else evidence.push({ resultPath: claim.path, evidenceAnchorId, ...lexicalCheck(claim.value, evidenceAnchorId, member.lexical) })
    }
  }
  const grounded = new Set(evidence.map((link) => resultPathKey(link.resultPath)))
  const ungroundedPaths = claims.filter((claim) => !grounded.has(resultPathKey(claim.path))).map((claim) => claim.path)
  for (const claim of claims) if (!selectedClaims.has(claim.label)) issues.push({ code: 'missing_claim', claimLabel: claim.label, resultPath: claim.path })
  return { evidence, ungroundedPaths, issues, metadata, batches }
}

function claimField(claim: Claim, nodes: readonly SchemaNode[]): GroundingClaimField {
  const record = claim.path[0] === 'records' && typeof claim.path[1] === 'number' ? `records[${claim.path[1]}]` : null
  const segments = claim.path.filter((segment): segment is string => typeof segment === 'string')
  return {
    record,
    field: (record === null ? segments : segments.slice(1)).join('.'),
    description: schemaNodeAtPath(nodes, claim.path)?.description ?? null,
  }
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

/** Consecutive record batches share one call, `size` at a time; the root
 *  batch (document-level claims) always stands alone. */
function claimGroups(batches: readonly ClaimBatch[], size: number): ClaimBatch[][] {
  const groups: ClaimBatch[][] = []
  for (const batch of batches) {
    const open = groups.at(-1)
    if (batch.resultPath !== null && open && open[0].resultPath !== null && open.length < size) open.push(batch)
    else groups.push([batch])
  }
  return groups
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
