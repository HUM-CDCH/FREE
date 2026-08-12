import { z } from 'zod'
import {
  isAllowedValues,
  isScalarFieldType,
  NON_STRING_SCALAR_FIELD_TYPES,
  SCALAR_FIELD_TYPES,
  type ScalarFieldType,
} from './allowedValues.js'

type SchemaNodeBase = {
  id: string
  name: string
  description?: string
  valueSource?: ValueSource
}

export type ValueSource = 'document' | 'source-filename'

export type SchemaNode =
  | (SchemaNodeBase & { type: 'string'; allowedValues?: string[]; itemType?: never; children?: never })
  | (SchemaNodeBase & { type: Exclude<ScalarFieldType, 'string'>; allowedValues?: never; itemType?: never; children?: never })
  | (SchemaNodeBase & { type: 'array'; itemType: ScalarFieldType; allowedValues?: never; children?: never })
  | (SchemaNodeBase & { type: 'object' | 'array'; children: SchemaNode[]; allowedValues?: never; itemType?: never })

const schemaNodeBaseShape = {
  id: z.string().min(1),
  name: z.string().trim().min(1),
  description: z.string().min(1).optional(),
  valueSource: z.enum(['document', 'source-filename']).optional(),
}

export const schemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() =>
  z.union([
    z
      .object({
        ...schemaNodeBaseShape,
        type: z.literal('string'),
        allowedValues: z
          .array(z.string())
          .refine(isAllowedValues)
          .optional(),
      })
      .strict(),
    z
      .object({
        ...schemaNodeBaseShape,
        type: z.enum(NON_STRING_SCALAR_FIELD_TYPES),
      })
      .strict(),
    z
      .object({
        ...schemaNodeBaseShape,
        type: z.literal('array'),
        itemType: z.enum(SCALAR_FIELD_TYPES),
      })
      .strict(),
    z
      .object({
        ...schemaNodeBaseShape,
        type: z.enum(['object', 'array']),
        children: z.array(schemaNodeSchema),
      })
      .strict(),
  ]),
)

export const schemaNodesSchema = z.array(schemaNodeSchema).superRefine((nodes, context) => {
  if (nodes.some((node) => node.children?.some(hasNestedValueSource)))
    context.addIssue({ code: 'custom', message: 'valueSource is allowed only on top-level schema fields' })
})
export const recordDescriptionSchema = z.string().trim().min(1).max(1_000)
export const schemaDefinitionSchema = z
  .object({
    recordDescription: recordDescriptionSchema,
    schemaNodes: schemaNodesSchema,
  })
  .strict()

export type SchemaDefinition = z.infer<typeof schemaDefinitionSchema>

export function parseSchemaDefinition(value: unknown): SchemaDefinition {
  return schemaDefinitionSchema.parse(value)
}

export function parseSchemaNodes(value: unknown): SchemaNode[] {
  return schemaNodesSchema.parse(value)
}

function hasNestedValueSource(node: SchemaNode): boolean {
  return node.valueSource !== undefined || Boolean(node.children?.some(hasNestedValueSource))
}

export type SchemaNodePartition = {
  documentNodes: SchemaNode[]
  recordNodes: SchemaNode[]
  packageNodes: SchemaNode[]
}

/** Partition complete top-level subtrees without changing their order. */
export function partitionSchemaNodes(nodes: readonly SchemaNode[]): SchemaNodePartition {
  const partition: SchemaNodePartition = {
    documentNodes: [],
    recordNodes: [],
    packageNodes: [],
  }
  for (const node of nodes) {
    if (node.valueSource === 'document') partition.documentNodes.push(node)
    else if (node.valueSource === 'source-filename') partition.packageNodes.push(node)
    else partition.recordNodes.push(node)
  }
  return partition
}

/** Restore model values to schema order while rejecting unknown keys. */
export function restoreSchemaNodeOrder(
  value: unknown,
  nodes: readonly SchemaNode[],
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Model output records must be objects.')
  const byName = new Map(nodes.map((node) => [node.name, node]))
  for (const key of Object.keys(value))
    if (!byName.has(key)) throw new Error(`Unexpected model key: ${key}`)

  const restored: Record<string, unknown> = {}
  for (const node of nodes) {
    if (!Object.hasOwn(value, node.name)) continue
    const item = value[node.name]
    if (node.children && item !== null) {
      if (node.type === 'array') {
        if (!Array.isArray(item)) throw new Error(`Model output field ${node.name} must be an array.`)
        restored[node.name] = item.map((entry) => restoreSchemaNodeOrder(entry, node.children))
      } else {
        restored[node.name] = restoreSchemaNodeOrder(item, node.children)
      }
    } else {
      restored[node.name] = item
    }
  }
  return restored
}

export type EnumeratedField = {
  id: string
  key: string
  path: readonly string[]
  node: SchemaNode
}

export type SchemaMetadataCount = {
  descriptions: number
  allowedValues: number
}

let uid = 1
export const mkId = () => `n${uid++}`

export function templateToNodes(value: unknown): SchemaNode[] {
  if (!isRecord(value)) return []
  return Object.entries(value)
    .filter(([name]) => name !== '_description')
    .map(([name, child]) => {
      if (Array.isArray(child)) {
        const first = child[0]
        if (isRecord(first)) {
          const description = typeof first._description === 'string' ? first._description : undefined
          return { id: mkId(), name, type: 'array', children: templateToNodes(first), ...(description && { description }) }
        }
        if (isAllowedValues(child)) {
          return { id: mkId(), name, type: 'string', allowedValues: child }
        }
        return { id: mkId(), name, type: 'array', itemType: isScalarFieldType(first) ? first : 'string' }
      }
      if (isRecord(child)) {
        const description = typeof child._description === 'string' ? child._description : undefined
        return { id: mkId(), name, type: 'object', children: templateToNodes(child), ...(description && { description }) }
      }
      return { id: mkId(), name, type: isScalarFieldType(child) ? child : 'string' }
    })
}

export function templateToSchemaDefinition(value: unknown): SchemaDefinition {
  if (!isRecord(value) || typeof value._description !== 'string')
    throw new Error('The Extraction Schema requires a root record description.')
  return parseSchemaDefinition({
    recordDescription: value._description,
    schemaNodes: templateToNodes(value),
  })
}

export function schemaDefinitionToTemplate(
  definition: SchemaDefinition,
): Record<string, unknown> {
  const parsed = parseSchemaDefinition(definition)
  return {
    _description: parsed.recordDescription,
    ...nodesToTemplate(parsed.schemaNodes),
  }
}

export function nodesToTemplate(nodes: readonly SchemaNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const node of nodes) {
    if (Object.hasOwn(out, node.name)) throw new Error(`Duplicate field name: ${node.name}`)
    if (node.children !== undefined) {
      const children = nodesToTemplate(node.children)
      const group = node.description ? { _description: node.description, ...children } : children
      out[node.name] = node.type === 'array' ? [group] : group
    } else if (node.allowedValues) {
      out[node.name] = node.allowedValues
    } else {
      out[node.name] = node.type === 'array' ? [node.itemType] : node.type
    }
  }
  return out
}

export function enumerateFieldPaths(nodes: readonly SchemaNode[]): EnumeratedField[] {
  const fields: EnumeratedField[] = []
  const visit = (level: readonly SchemaNode[], parentPath: readonly string[]) => {
    for (const node of level) {
      const path = [...parentPath, node.name]
      fields.push({ id: node.id, key: path.join('.'), path, node })
      if (node.children) visit(node.children, path)
    }
  }
  visit(nodes, [])
  return fields
}

export function duplicateFieldKeys(fields: readonly EnumeratedField[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const field of fields) {
    if (seen.has(field.key)) duplicates.add(field.key)
    seen.add(field.key)
  }
  return [...duplicates]
}

export function countSchemaMetadata(nodes: readonly SchemaNode[]): SchemaMetadataCount {
  let descriptions = 0
  let allowedValues = 0
  for (const { node } of enumerateFieldPaths(nodes)) {
    if (node.description) descriptions++
    if (node.allowedValues) allowedValues++
  }
  return { descriptions, allowedValues }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
