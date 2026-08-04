import { isAllowedValues } from '../shared/allowedValues.js'

// Evidence rides alongside the Extraction Schema as one `_evidence` object per
// schema object, keyed by that object's own field names. Wrapping each leaf as
// {value, snippet, page} instead removes every plain scalar from the template,
// and NuExtract then returns a single record where a repeated collection is
// asked for (measured: 1 of 7 graves wrapped, 7 of 7 with a sibling object).
const EVIDENCE_KEY = '_evidence'

type EvidenceLeaf = {
  readonly value: unknown
  readonly snippet: string
  readonly page: number | null
}

type SplitEvidence = {
  readonly result: unknown
  readonly evidence: unknown
}

export function wrapTemplateWithEvidence(template: unknown): unknown {
  if (!isRecord(template)) {
    return template
  }
  return wrapSchema(template)
}

export function splitEvidenceResult(input: Record<string, unknown>): {
  readonly result: Record<string, unknown>
  readonly evidence: Record<string, unknown> | null
} {
  const split = splitNode(input)
  return {
    result: isRecord(split.result) ? split.result : {},
    evidence: isRecord(split.evidence) ? split.evidence : null,
  }
}

function evidenceSlot(): Record<string, string> {
  return { snippet: 'string', page: 'number' }
}

function wrapSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => wrapSchema(item))
  }
  if (!isRecord(node)) {
    return node
  }

  const wrapped: Record<string, unknown> = {}
  const evidence: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    wrapped[key] = wrapSchema(value)
    if (key.startsWith('_')) continue
    // A closed set is answered with one value, so it takes a scalar slot even
    // though the template writes it as an array.
    if (isScalarLeaf(value) || isAllowedValues(value)) {
      evidence[key] = evidenceSlot()
    } else if (isScalarArray(value)) {
      evidence[key] = [evidenceSlot()]
    }
    // Nested objects and object arrays carry their own `_evidence` from recursion.
  }
  if (Object.keys(evidence).length > 0) {
    wrapped[EVIDENCE_KEY] = evidence
  }
  return wrapped
}

function splitNode(node: unknown): SplitEvidence {
  if (Array.isArray(node)) {
    const result: unknown[] = []
    const evidence: unknown[] = []
    let hasEvidence = false
    for (const item of node) {
      const split = splitNode(item)
      result.push(split.result)
      evidence.push(split.evidence)
      hasEvidence ||= split.evidence !== null
    }
    return { result, evidence: hasEvidence ? evidence : null }
  }

  if (!isRecord(node)) {
    return { result: node, evidence: null }
  }

  const declared = isRecord(node[EVIDENCE_KEY]) ? node[EVIDENCE_KEY] : {}
  const result: Record<string, unknown> = {}
  const evidence: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === EVIDENCE_KEY) continue
    const split = splitNode(value)
    result[key] = split.result
    const own = split.evidence ?? evidenceFor(split.result, declared[key])
    if (own !== null) {
      evidence[key] = own
    }
  }
  return { result, evidence: Object.keys(evidence).length > 0 ? evidence : null }
}

function evidenceFor(value: unknown, declared: unknown): unknown {
  if (Array.isArray(declared) && Array.isArray(value)) {
    const leaves = value.map((item, index) => evidenceLeaf(item, declared[index]))
    return leaves.some((leaf) => leaf !== null) ? leaves : null
  }
  return evidenceLeaf(value, declared)
}

function evidenceLeaf(value: unknown, declared: unknown): EvidenceLeaf | null {
  if (!isRecord(declared)) {
    return null
  }
  const snippet = firstSnippet(declared)
  if (snippet === null) {
    return null
  }
  const page = declared.page
  return {
    value,
    snippet,
    page: typeof page === 'number' && Number.isFinite(page) && page > 0 ? Math.trunc(page) : null,
  }
}

/** Accepts `snippet` or FREE-technical's plural `snippets`; models return either. */
function firstSnippet(declared: Record<string, unknown>): string | null {
  const candidates = Array.isArray(declared.snippets)
    ? declared.snippets
    : [declared.snippet, declared.snippets]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return null
}

function isScalarLeaf(value: unknown): boolean {
  return !Array.isArray(value) && !isRecord(value)
}

function isScalarArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && isScalarLeaf(value[0])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
