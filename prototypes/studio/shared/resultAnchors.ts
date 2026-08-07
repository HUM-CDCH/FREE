/**
 * Canonical Evidence Anchor IDs an Extraction Result references. A model may
 * only cite `anchor_id`s the Parsing Service published, so this walk is the one
 * place both the browser review action and the review write derive them from.
 */
export function resultAnchorIds(
  value: unknown,
  found = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) resultAnchorIds(item, found)
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.anchor_id === 'string') found.add(record.anchor_id)
    for (const item of Object.values(record)) resultAnchorIds(item, found)
  }
  return found
}
