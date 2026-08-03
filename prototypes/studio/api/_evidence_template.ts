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
  const result: Record<string, unknown> = {}
  const evidence: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === '_description' || key === '_strategy' || key === 'source_scope') continue // schema/routing metadata, not an extracted value
    const split = splitNode(value)
    result[key] = split.result
    if (split.evidence !== null) {
      evidence[key] = split.evidence
    }
  }
  return { result, evidence: Object.keys(evidence).length > 0 ? evidence : null }
}

function wrapSchema(template: unknown, hasTables: boolean): unknown {
  if (Array.isArray(template)) {
    return template.map((item) => wrapSchema(item, hasTables))
  }
  if (isRecord(template)) {
    return Object.fromEntries(
      Object.entries(template)
        // "_strategy" (Catalog/Article) is internal routing metadata, not
        // something the model should ever see — drop it before it reaches
        // the prompt, unlike "_description" below which the model does read.
        .filter(([key]) => key !== '_strategy')
        // "_description" is NuExtract's own field-guidance convention, not an
        // extraction target — it must reach the model as plain text, not
        // wrapped in {value, snippet, page} like a real field.
        .map(([key, value]) => [key, key === '_description' ? value : wrapSchema(value, hasTables)]),
    )
  }
  return hasTables
    ? { value: template, snippet: 'string', page: 'number', row_header: 'string', column_header: 'string' }
    : { value: template, snippet: 'string', page: 'number' }
}

function splitNode(node: unknown): SplitEvidence {
  if (isInlineEvidence(node)) {
    const snippet = node.snippet
    const page = node.page
    const value = node.value
    const hasEvidence = typeof snippet === 'string' && snippet.length > 0 && typeof page === 'number' && page > 0
    const rowHeader = typeof node.row_header === 'string' && node.row_header.trim() ? node.row_header : null
    const columnHeader =
      typeof node.column_header === 'string' && node.column_header.trim() ? node.column_header : null
    return {
      result: value,
      evidence: hasEvidence
        ? { snippet, page: Math.trunc(page), value, row_header: rowHeader, column_header: columnHeader }
        : null,
    }
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

  if (isRecord(node)) {
    const result: Record<string, unknown> = {}
    const evidence: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === '_description' || key === '_strategy' || key === 'source_scope') continue // schema/routing metadata, not an extracted value
      const split = splitNode(value)
      result[key] = split.result
      if (split.evidence !== null) {
        evidence[key] = split.evidence
      }
    }
    return { result, evidence: Object.keys(evidence).length > 0 ? evidence : null }
  }

  return { result: node, evidence: null }
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

function isInlineEvidence(
  value: unknown,
): value is Record<'page' | 'snippet' | 'value' | 'row_header' | 'column_header', unknown> {
  return (
    isRecord(value) &&
    'value' in value &&
    (typeof value.snippet === 'string' || value.snippet === null) &&
    (typeof value.page === 'number' || value.page === null)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
