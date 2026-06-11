export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function countTemplateFields(value: unknown): number {
  if (Array.isArray(value)) {
    return countTemplateFields(value[0])
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>((sum, child) => sum + countTemplateFields(child), 0)
  }
  return 1
}
