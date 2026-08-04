// A field's allowed values ride in the Extraction Schema as a literal array of
// those values — NuExtract's native closed set, measured to bind: given
// ["mand","kvinde","ukendt"] it answers with one member rather than a list.
//
// Shared because the browser authors the template and the server sends it and
// reads the answer back; both have to agree on what counts as a closed set.

export const FIELD_TYPES = [
  'verbatim-string',
  'string',
  'date',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
] as const

/**
 * An array of type tokens (`["string"]`) means "array of that type", and a
 * single literal is read as an array too, so a closed set needs two or more
 * non-token values. Same discriminator the model itself applies.
 */
export function isAllowedValues(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every(
      (item) =>
        typeof item === 'string' &&
        item.trim().length > 0 &&
        !(FIELD_TYPES as readonly string[]).includes(item),
    )
  )
}

/**
 * Degrade the field, never fail the Extraction Result. The model answers a
 * closed set with a scalar in some runs and a one-item array in others, so
 * unwrap that first; a case- or whitespace-variant snaps to its canonical
 * member; and anything still outside the list is kept verbatim, so the
 * Humanities Researcher reviews what the model actually said instead of a
 * silently blanked field.
 */
export function coerceAllowedValue(value: unknown, allowed: readonly string[]): unknown {
  const raw = Array.isArray(value) && value.length === 1 ? value[0] : value
  if (typeof raw !== 'string') {
    return raw
  }
  const folded = raw.trim().toLowerCase()
  return allowed.find((option) => option === raw) ?? allowed.find((option) => option.toLowerCase() === folded) ?? raw
}

/** Walks an Extraction Result against its Extraction Schema, coercing closed-set fields. */
export function applyAllowedValues(
  result: Record<string, unknown>,
  template: unknown,
): Record<string, unknown> {
  const coerced = coerceNode(result, template)
  return isRecord(coerced) ? coerced : result
}

function coerceNode(result: unknown, template: unknown): unknown {
  if (isAllowedValues(template)) {
    return coerceAllowedValue(result, template)
  }
  if (Array.isArray(template)) {
    return Array.isArray(result) ? result.map((item) => coerceNode(item, template[0])) : result
  }
  if (!isRecord(template) || !isRecord(result)) {
    return result
  }
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, coerceNode(value, template[key])]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
