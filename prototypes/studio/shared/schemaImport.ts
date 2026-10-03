import { mkId, schemaDefinitionSchema, type SchemaDefinition, type SchemaNode } from 'extraction/schema'
import type { ScalarFieldType } from 'extraction/allowed-values'

export const IMPORT_LIMITS = { compressed: 5 * 1024 * 1024, expanded: 25 * 1024 * 1024, columns: 200, rows: 5000, cell: 64 * 1024 } as const

export type ImportColumn = {
  id: string; column: number; name: string; type: ScalarFieldType; include: boolean; enum?: boolean
  examples: string[]; kinds: string[]; suggestedType: 'number' | 'string'; choices: string[]
}

/** Maps, never property assignment with workbook headers. Leaf IDs survive every preview edit. */
export function importDefinition(columns: ImportColumn[], recordDescription: string, separator: string, groups: Map<string, string>): SchemaDefinition {
  const roots: SchemaNode[] = [], ids = new Set<string>(), paths = new Map<string, SchemaNode>()
  for (const column of columns.filter((field) => field.include)) {
    const parts = separator ? column.name.split(separator).map((part) => part.trim()) : [column.name.trim()]
    if (parts.some((part) => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error(`Column ${column.column}: blank, ambiguous or unsupported field path.`)
    let children = roots
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!, key = JSON.stringify(parts.slice(0, index + 1)), leaf = index === parts.length - 1, existing = paths.get(key)
      if (existing && (leaf || !existing.children)) throw new Error(`Column ${column.column}: duplicate path or leaf/group collision at ${name}.`)
      const groupKey = JSON.stringify([column.id, index])
      if (existing?.children) { groups.set(groupKey, existing.id); children = existing.children; continue }
      let node: SchemaNode
      if (leaf) node = column.enum
        ? { id: column.id, name, type: 'string', allowedValues: column.choices }
        : { id: column.id, name, type: column.type }
      else { if (!groups.has(groupKey) || ids.has(groups.get(groupKey)!)) groups.set(groupKey, mkId()); node = { id: groups.get(groupKey)!, name, type: 'object', children: [] } }
      if (ids.has(node.id)) throw new Error(`Column ${column.column}: duplicate node identity.`)
      ids.add(node.id); paths.set(key, node); children.push(node)
      if (node.children) children = node.children
    }
  }
  if (!roots.length) throw new Error('Include at least one column.')
  const parsed = schemaDefinitionSchema.safeParse({ recordDescription, schemaNodes: roots })
  if (!parsed.success) throw new Error(importIssueMessage(parsed.error.issues[0]!, roots, separator))
  return parsed.data
}

/** What a property's validation failure asks of the researcher, where the schema's own message is too terse. */
const PROPERTY_WORDS: Record<string, string> = {
  allowedValues: 'allowed values need at least two, none blank and none a field type name such as "date".',
}

/** The first validation issue in the researcher's words: a missing record description, or the issue named by the
 *  column it comes from (`Column "person.birth.year": …`), never the raw issue list. */
function importIssueMessage(issue: { code: string; path: PropertyKey[]; message: string }, roots: readonly SchemaNode[], separator: string): string {
  if (issue.path[0] === 'recordDescription')
    return issue.code === 'too_small' ? 'Add a record description to import these fields.' : `Record description: ${issue.message}`
  const names: string[] = []
  let level: readonly SchemaNode[] | undefined = roots
  for (const segment of issue.path.slice(1)) {
    if (typeof segment !== 'number') continue
    const node: SchemaNode | undefined = level?.[segment]
    if (!node) break
    names.push(node.name)
    level = node.children
  }
  const property = issue.path.at(-1)
  const words = (typeof property === 'string' && PROPERTY_WORDS[property]) || issue.message
  return names.length ? `Column "${names.join(separator || '.')}": ${words}` : words
}
