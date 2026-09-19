import { enumerateFieldPaths, type SchemaNode } from 'extraction/schema'

export function isInternalFieldName(name: string): boolean {
  const normalized = name.toLowerCase()
  return name.startsWith('_') || normalized === 'evidence' || normalized === 'internal'
}

/** A field the review UI actually shows a column/value for: a schema leaf,
 *  excluding the internal bookkeeping fields extraction attaches (evidence,
 *  internal, _-prefixed). Shared so the batch grid's columns and the
 *  finished-extraction reports' field counts count the same set. */
export function leafFields(schemaNodes: readonly SchemaNode[] | null) {
  if (!schemaNodes) return []
  return enumerateFieldPaths(schemaNodes).filter(
    (field) => !field.node.children && !field.path.some(isInternalFieldName),
  )
}

export function countLeafFields(schemaNodes: readonly SchemaNode[] | null): number {
  return leafFields(schemaNodes).length
}
