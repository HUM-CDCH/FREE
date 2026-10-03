import { ExtractionError } from './errors.js'
import type { ExtractionMethodIntent } from './extraction-method.js'
import { parseExtractionSchema, type SchemaNode } from './schema.js'

/** Narrow admission mirror of ExtractRequest/native_schema, pinned by gliformer-compatibility.json.
 * The Parsing Service remains authoritative. Never edits the schema, model choice or predictions. */
export function gliformerIssues(method: ExtractionMethodIntent, nodes: readonly SchemaNode[]): string[] {
  const issues: string[] = []
  if (method.models?.reasoning === 'gliformer') issues.push('GLiFormer cannot be the reasoning model')
  if (method.models?.fields !== 'gliformer') return issues
  if (!('unified' in method.settings)) issues.push('the fields model requires unified Catalog extraction')
  else {
    for (const control of ['headings', 'verification'] as const)
      if (method.settings.unified[control] === true) issues.push(`${control} must be Auto or off`)
  }
  const visit = (fields: readonly SchemaNode[], parent: string) => {
    if (fields.length === 0) issues.push(`${parent || 'record'} (empty record group)`)
    const names = new Set<string>()
    for (const node of fields) {
      const path = parent ? `${parent}.${node.name}` : node.name
      if (names.has(node.name)) issues.push(`${path} (duplicate field name)`)
      names.add(node.name)
      if (node.valueSource) issues.push(`${path} (${node.valueSource} fields are not supported)`)
      if (node.allowedValues?.length) issues.push(`${path} (allowed values are not supported)`)
      if (node.evidencePolicy === 'derived') issues.push(`${path} (derived values are not supported)`)
      if (parent && node.name === '_item_text') issues.push(`${path} (reserved list field name)`)
      if (node.type === 'array' && node.itemType === undefined) visit(node.children, `${path}[]`)
      else if (node.type !== 'string' && node.type !== 'verbatim-string')
        issues.push(`${path} (${node.type === 'array' ? 'scalar arrays' : node.type + ' fields'} are not supported)`)
    }
  }
  visit(nodes, '')
  return issues
}

export function refuseIncompatibleGliformer(method: ExtractionMethodIntent, schemaTree: unknown): void {
  if (method.models?.fields !== 'gliformer' && method.models?.reasoning !== 'gliformer') return
  let nodes
  try { nodes = parseExtractionSchema(schemaTree).schemaNodes }
  catch { throw new ExtractionError('invalid_extraction_pins', 'The selected Schema Revision is invalid.') }
  const issues = gliformerIssues(method, nodes)
  if (issues.length) throw new ExtractionError('incompatible_extraction_model',
    `GLiFormer cannot run this Extraction: ${issues.join('; ')}. Choose a compatible model or explicitly edit the schema or advanced settings.`)
}
