import pluralize from 'pluralize'
import type { SchemaNode } from 'extraction/schema'

const WORDS: Record<string, string> = {
  string: 'string',
  'verbatim-string': 'verbatim',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  date: 'date',
}

const PLURALS: Record<string, string> = { 'verbatim-string': 'verbatim strings' }

function word(type: string): string {
  return WORDS[type] ?? type
}

/** A field's type in words for its pill (§6): "string", "verbatim", "list of strings", "list of objects", "object". */
export function fieldTypeWords(node: SchemaNode): string {
  if (node.type === 'array')
    return node.children === undefined
      ? `list of ${PLURALS[node.itemType ?? 'string'] ?? pluralize(word(node.itemType ?? 'string'))}`
      : 'list of objects'
  if (node.type === 'object' || node.children !== undefined) return 'object'
  return word(node.type)
}
