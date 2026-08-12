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
  readonly row_header: string | null
  readonly column_header: string | null
}

type SplitEvidence = {
  readonly result: unknown
  readonly evidence: unknown
}

export type EvidenceSourceScope = {
  readonly segment_id: string
  readonly markdown_start: number
  readonly markdown_end: number
  readonly start_page: number
  readonly end_page: number
}

export function wrapTemplateWithEvidence(template: unknown, hasTables = false): unknown {
  if (!isRecord(template)) {
    return template
  }
  return wrapSchema(template, hasTables)
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

function evidenceSlot(hasTables: boolean): Record<string, string> {
  return hasTables
    ? { snippet: 'string', page: 'number', row_header: 'string', column_header: 'string' }
    : { snippet: 'string', page: 'number' }
}

function wrapSchema(node: unknown, hasTables: boolean): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => wrapSchema(item, hasTables))
  }
  if (!isRecord(node)) {
    return node
  }

  const wrapped: Record<string, unknown> = {}
  const evidence: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '_strategy') continue
    wrapped[key] = key === '_description' ? value : wrapSchema(value, hasTables)
    if (key.startsWith('_')) continue
    if (isScalarLeaf(value)) {
      evidence[key] = evidenceSlot(hasTables)
    } else if (isScalarArray(value)) {
      evidence[key] = [evidenceSlot(hasTables)]
    }
    // Nested objects and object arrays carry their own `_evidence` from recursion.
  }
  if (Object.keys(evidence).length > 0) {
    wrapped[EVIDENCE_KEY] = evidence
  }
  return wrapped
}

function splitNode(node: unknown): SplitEvidence {
  if (isInlineEvidence(node)) {
    return splitInlineEvidence(node)
  }

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
    if (key === EVIDENCE_KEY || key === '_description' || key === '_strategy' || key === 'source_scope') continue
    const split = splitNode(value)
    result[key] = split.result
    const own = split.evidence ?? evidenceFor(split.result, declared[key])
    if (own !== null) {
      evidence[key] = own
    }
  }
  return { result, evidence: Object.keys(evidence).length > 0 ? evidence : null }
}

// Scope comes from the section sent to the model, never from model output. Keep
// it on every usable evidence leaf so result/evidence paths stay mirrored.
export function attachEvidenceSourceScope(evidence: unknown, sourceScope: EvidenceSourceScope): unknown {
  if (Array.isArray(evidence)) {
    return evidence.map((item) => attachEvidenceSourceScope(item, sourceScope))
  }
  if (!isRecord(evidence)) {
    return evidence
  }
  if (isInlineEvidence(evidence)) {
    return { ...evidence, source_scope: sourceScope }
  }
  return Object.fromEntries(
    Object.entries(evidence).map(([key, value]) => [key, attachEvidenceSourceScope(value, sourceScope)]),
  )
}

function evidenceFor(value: unknown, declared: unknown): unknown {
  if (Array.isArray(declared) && Array.isArray(value)) {
    const leaves = value.map((item, index) => evidenceLeaf(item, declared[index]))
    return leaves.some((leaf) => leaf !== null) ? leaves : null
  }
  return evidenceLeaf(value, declared)
}

function evidenceLeaf(value: unknown, declared: unknown): EvidenceLeaf | null {
  if (!isRecord(declared) || looksLikeInlineEvidence(declared)) {
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
    row_header: textOrNull(declared.row_header),
    column_header: textOrNull(declared.column_header),
  }
}

function splitInlineEvidence(node: Record<string, unknown>): SplitEvidence {
  const snippet = node.snippet
  const page = node.page
  const value = node.value
  const hasEvidence =
    typeof snippet === 'string' &&
    snippet.trim().length > 0 &&
    ((typeof page === 'number' && Number.isFinite(page) && page > 0) || page === null)
  return {
    result: value,
    evidence: hasEvidence
      ? {
          value,
          snippet: snippet.trim(),
          page: typeof page === 'number' && Number.isFinite(page) && page > 0 ? Math.trunc(page) : null,
          row_header: textOrNull(node.row_header),
          column_header: textOrNull(node.column_header),
        }
      : null,
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

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isInlineEvidence(value: unknown): value is Record<string, unknown> {
  return looksLikeInlineEvidence(value)
}

function looksLikeInlineEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    'value' in value &&
    (typeof value.snippet === 'string' || value.snippet === null) &&
    (typeof value.page === 'number' || value.page === null)
  )
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
