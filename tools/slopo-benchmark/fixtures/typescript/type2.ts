export function isPlainRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
}
export function removeMetadataDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(removeMetadataDescriptions)
  if (isPlainRecord(node)) {
    const cleaned: Record<string, unknown> = {}
    for (const [name, child] of Object.entries(node)) {
      if (name === '_description') continue
      cleaned[name] = removeMetadataDescriptions(child)
    }
    return cleaned
  }
  return node
}

export function renderNestedInstructions(schema: unknown, parent = ''): string {
  if (!isPlainRecord(schema)) return ''
  const output: string[] = []
  for (const [name, field] of Object.entries(schema)) {
    if (name === '_description') continue
    const qualifiedName = parent ? `${parent}.${name}` : name
    const nestedValue = Array.isArray(field) ? field[0] : field
    if (isPlainRecord(nestedValue)) {
      const help = typeof nestedValue['_description'] === 'string' ? nestedValue['_description'] : null
      if (help) output.push(`- ${qualifiedName}: ${help}`)
      const children = renderNestedInstructions(nestedValue, qualifiedName)
      if (children) output.push(children)
    }
  }
  return output.join('\n')
}

export function countSchemaLeaves(node: unknown): number {
  if (Array.isArray(node)) return countSchemaLeaves(node[0])
  if (isPlainRecord(node)) {
    return Object.entries(node).reduce<number>(
      (total, [name, child]) =>
        name === '_description' ? total : total + countSchemaLeaves(child),
      0,
    )
  }
  return 1
}
