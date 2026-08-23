export function hasRecordShape(value: unknown): value is Record<string, unknown> {
  if (value === null || Array.isArray(value)) return false
  return typeof value === 'object'
}
export function omitDescriptionsDeep(value: unknown): unknown {
  if (!hasRecordShape(value)) {
    return Array.isArray(value) ? value.map(omitDescriptionsDeep) : value
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '_description')
      .map(([key, child]) => [key, omitDescriptionsDeep(child)]),
  )
}

export function collectInstructions(value: unknown, prefix = ''): string {
  if (!hasRecordShape(value)) return ''
  const lines: string[] = []
  Object.entries(value).forEach(([key, field]) => {
    if (key === '_description') return
    const path = prefix.length > 0 ? `${prefix}.${key}` : key
    const child = Array.isArray(field) ? field.at(0) : field
    if (!hasRecordShape(child)) return
    const description = child['_description']
    if (typeof description === 'string') lines.push(`- ${path}: ${description}`)
    const descendants = collectInstructions(child, path)
    if (descendants.length > 0) lines.push(descendants)
  })
  return lines.join('\n')
}

export function countLeafFields(value: unknown): number {
  const current = Array.isArray(value) ? value[0] : value
  if (!hasRecordShape(current)) return 1
  let leaves = 0
  for (const key of Object.keys(current)) {
    if (key !== '_description') leaves += countLeafFields(current[key])
  }
  return leaves
}
