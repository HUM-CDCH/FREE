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
  const result: Record<string, unknown> = {}
  const evidence: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const split = splitNode(value)
    result[key] = split.result
    if (split.evidence !== null) {
      evidence[key] = split.evidence
    }
  }
  return { result, evidence: Object.keys(evidence).length > 0 ? evidence : null }
}

function wrapSchema(template: unknown): unknown {
  if (Array.isArray(template)) {
    return template.map((item) => wrapSchema(item))
  }
  if (isRecord(template)) {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, wrapSchema(value)]))
  }
  return { value: template, snippet: 'string', page: 'number' }
}

function splitNode(node: unknown): SplitEvidence {
  if (isInlineEvidence(node)) {
    const snippet = node.snippet
    const page = node.page
    const value = node.value
    const hasEvidence = typeof snippet === 'string' && snippet.length > 0 && typeof page === 'number' && page > 0
    return {
      result: value,
      evidence: hasEvidence ? { snippet, page: Math.trunc(page), value } : null,
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

function isInlineEvidence(value: unknown): value is Record<'page' | 'snippet' | 'value', unknown> {
  return isRecord(value) && 'value' in value && 'snippet' in value && 'page' in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
