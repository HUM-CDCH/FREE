import { enumerateFieldPaths, type SchemaNode } from 'extraction/schema'

export function isInternalFieldName(name: string): boolean {
  const normalized = name.toLowerCase()
  return name.startsWith('_') || normalized === 'evidence' || normalized === 'internal'
}

/** A field the review UI shows a column/value for: every leaf the approved
 *  schema declares, whatever its name. Shared so the batch grid's columns and
 *  the finished-extraction reports' field counts count the same set. */
export function leafFields(schemaNodes: readonly SchemaNode[] | null) {
  if (!schemaNodes) return []
  return enumerateFieldPaths(schemaNodes).filter((field) => !field.node.children)
}

export function countLeafFields(schemaNodes: readonly SchemaNode[] | null): number {
  return leafFields(schemaNodes).length
}
