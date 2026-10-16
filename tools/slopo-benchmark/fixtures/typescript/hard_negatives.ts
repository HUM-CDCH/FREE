export function isObjectLike(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}
export function blankDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blankDescriptions)
  if (isObjectLike(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      result[key] = key === '_description' ? '' : blankDescriptions(child)
    }
    return result
  }
  return value
}

export function listSchemaPaths(value: unknown, prefix = ''): string {
  if (!isObjectLike(value) || Array.isArray(value)) return prefix
  const paths: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    paths.push(path)
    const nested = listSchemaPaths(child, path)
    if (nested && nested !== path) paths.push(nested)
  }
  return paths.join('\n')
}

export function countAllNodes(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce((sum, child) => sum + countAllNodes(child), 0)
  if (isObjectLike(value)) {
    return 1 + Object.values(value).reduce<number>((sum, child) => sum + countAllNodes(child), 0)
  }
  return 1
}
