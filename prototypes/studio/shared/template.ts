// Type guard: true for plain objects (excludes null and arrays).
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Counts leaf fields in a schema value
export function countTemplateFields(value: unknown): number {
  if (Array.isArray(value)) {
    return countTemplateFields(value[0])
  }
  if (isRecord(value)) {
    return Object.entries(value).reduce<number>(
      (sum, [key, child]) =>
        key === '_description' ? sum : sum + countTemplateFields(child),
      0,
    )
  }
  return 1
}
