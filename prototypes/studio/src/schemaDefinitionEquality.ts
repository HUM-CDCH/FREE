import type { SchemaDefinition, SchemaNode } from 'extraction/schema'

function sameNode(left: SchemaNode, right: SchemaNode): boolean {
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.type !== right.type ||
    left.description !== right.description ||
    left.valueSource !== right.valueSource ||
    left.itemType !== right.itemType
  )
    return false
  const leftValues = left.allowedValues
  const rightValues = right.allowedValues
  if (leftValues?.length !== rightValues?.length) return false
  if (
    leftValues &&
    rightValues &&
    leftValues.some((value, index) => value !== rightValues[index])
  )
    return false
  const leftChildren = left.children
  const rightChildren = right.children
  if (leftChildren?.length !== rightChildren?.length) return false
  return (
    !leftChildren ||
    !rightChildren ||
    leftChildren.every((child, index) => sameNode(child, rightChildren[index]!))
  )
}

export function sameSchemaDefinition(
  left: SchemaDefinition,
  right: SchemaDefinition,
): boolean {
  return (
    left.recordDescription === right.recordDescription &&
    left.schemaNodes.length === right.schemaNodes.length &&
    left.schemaNodes.every((node, index) =>
      sameNode(node, right.schemaNodes[index]!),
    )
  )
}
